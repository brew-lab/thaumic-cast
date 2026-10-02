use std::net::IpAddr;
use std::time::Instant;

use crate::events::{EventEmitter, LinkQuality, NetworkEvent};
use crate::services::speaker_monitor::session::{SpeakerSession, BACKOFF_AFTER_FAILURES};
use crate::services::speaker_monitor::{
    drift_active, DriftMode, MonitorState, NoticeInput, SegmentBreak,
};
use crate::stream::ConnectionTap;
use crate::utils::now_millis;

impl SpeakerSession {
    /// Steps the speaker's notice with what this report found, and logs a
    /// new or escalated one.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn decide_notice(
        &mut self,
        stream_id: &str,
        speaker_ip: IpAddr,
        tap: &ConnectionTap,
        now: Instant,
        locked: bool,
        acked: Option<crate::services::speaker_monitor::AckedReserve>,
        brk: Option<SegmentBreak>,
        time_to_floor_s: Option<f64>,
    ) {
        let input = NoticeInput {
            locked,
            acked,
            offset_step: brk == Some(SegmentBreak::OffsetStep),
            pre_break: self.tracker.pre_break(),
            head_start: self.tracker.head_start(),
            stall_ms: self.tracker.stall_ms(),
            link_poor: tap.link_verdict() == Some(LinkQuality::Poor),
            time_to_floor_s,
            net_drift_ppm: self.tracker.net_drain_ppm(),
            clock_drained_ms: self.tracker.clock_drained_ms(),
            target_ms: self.tracker.target_ms(),
            drift_active: drift_active(self.drift.mode(), tap.rate_control().map(|c| &**c)),
            saturated: self.drift.saturated(),
        };
        let before = self.notices.active();
        let notice = self.notices.update(now, &input);
        let before_cause = before.and_then(|n| n.cause);
        let before = before.map(|n| n.notice_id);
        if let Some(n) = notice.filter(|n| Some(n.notice_id) == before && n.cause != before_cause) {
            // A standing notice that gained its cause in place keeps its id,
            // so a client does not show it again; the log still says why.
            log::info!(
                "[SpeakerMonitor] {} stream={}: notice {} id={} cause={}",
                speaker_ip,
                stream_id,
                n.kind,
                n.notice_id,
                n.cause.map_or("\u{2014}", |c| c.as_str())
            );
        } else if let Some(n) = notice.filter(|n| Some(n.notice_id) != before) {
            let opt = |v: Option<u32>| v.map_or_else(|| "\u{2014}".to_string(), |v| v.to_string());
            log::warn!(
                "[SpeakerMonitor] {} stream={}: notice {} id={}: stall={}ms left={}ms H={}ms \
                 suggested={}ms minutes={} restart_helps={} cause={}",
                speaker_ip,
                stream_id,
                n.kind,
                n.notice_id,
                opt(n.stall_ms),
                n.left_ms
                    .map_or_else(|| "\u{2014}".to_string(), |v| v.to_string()),
                opt(n.head_start_ms),
                opt(n.suggested_head_start_ms),
                opt(n.minutes),
                n.restart_helps,
                n.cause.map_or("\u{2014}", |c| c.as_str())
            );
        } else if notice.is_none() {
            if let Some(id) = before {
                log::info!(
                    "[SpeakerMonitor] {} stream={}: notice id={} cleared",
                    speaker_ip,
                    stream_id,
                    id
                );
            }
        }
    }

    /// The monitor's view of the speaker, from its latest report and what
    /// the polls have shown since.
    pub(crate) fn health_state(&self) -> MonitorState {
        let stale = self.consecutive_failures >= BACKOFF_AFTER_FAILURES || self.is_stale();
        self.tracker.state(self.dormant, stale)
    }

    /// Whether clients are told about this speaker's health: whenever it is
    /// polled, or would be but for playing something else.
    pub(crate) fn reports_health(&self) -> bool {
        self.monitor || self.emit_events
    }

    /// Sends the speaker's health, with the figures of its latest report, to
    /// clients.
    pub(crate) fn emit_health(
        &mut self,
        stream_id: &str,
        speaker_ip: IpAddr,
        state: MonitorState,
        emitter: &dyn EventEmitter,
    ) {
        self.health_reported = Some(state);
        emitter.emit_network(self.health_event(stream_id, speaker_ip, state));
    }

    /// The speaker health event for `state`, with the figures of the latest
    /// report.
    pub(super) fn health_event(
        &self,
        stream_id: &str,
        speaker_ip: IpAddr,
        state: MonitorState,
    ) -> NetworkEvent {
        let estimate = self.tracker.last_estimate();
        let acked = self.tracker.last_acked();
        let clock = self.tracker.clock();
        let ms = |v: f64| v.round() as i32;
        let unsigned_ms = |v: f64| v.max(0.0).round() as u32;
        let head_start = self.tracker.head_start();
        NetworkEvent::SpeakerHealth {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
            epoch_id: self.last_epoch_id,
            state: state.into(),
            reserve_ms: estimate.map(|e| ms(e.reserve_ms)),
            reserve_precision_ms: estimate.map(|e| e.half_width_ms.max(0.0).round() as u32),
            reserve_min_ms: acked.map(|a| ms(a.min_ms)),
            reserve_p10_ms: acked.map(|a| ms(a.p10_ms)),
            reserve_acked: acked.is_some_and(|a| a.measured),
            target_ms: self.tracker.target_ms().map(ms),
            head_start_ms: head_start.map(|h| h.sent_ms),
            head_start_configured_ms: head_start.map(|h| h.configured_ms),
            floor_ms: self.tracker.floor_ms().map(unsigned_ms),
            stall_ms: self.tracker.stall_ms().map(unsigned_ms),
            clock_ppm: clock.map(|c| c.ppm as f32),
            clock_se_ppm: clock.map(|c| c.se_ppm as f32),
            time_to_floor_s: self.tracker.time_to_floor_s().map(unsigned_ms),
            drift_mode: self.pcm.then(|| self.drift.mode()),
            command_ppm: (self.pcm && self.drift.mode() != DriftMode::Off)
                .then(|| self.drift.command_ppm() as f32),
            net_inserted_ms: self.live_tap().and_then(|t| t.net_inserted_ms()).map(ms),
            notice: self.notices.active(),
            timestamp: now_millis(),
        }
    }
}
