use std::net::IpAddr;
use std::time::{Duration, Instant};

use crate::events::EventEmitter;
use crate::services::speaker_monitor::monitor::ms_between;
use crate::services::speaker_monitor::session::{note_debt_repaid, SpeakerSession};
use crate::services::speaker_monitor::{
    DriftController, DriftMode, MemberChange, MonitorState, ReserveTracker, SegmentBreak,
    SwitchOutcome, SwitchUnmeasured, WindowStats,
};
use crate::stream::{ConnectionTap, SpeakerFigures};

/// How often each watched speaker's reserve and clock are estimated and
/// written to the log.
pub(super) const SPEAKER_REPORT_INTERVAL: Duration = Duration::from_secs(30);

/// Projected time to the low floor above which a draining warning is
/// re-armed (it fires below
/// [`DRAINING_WARN_SECS`](crate::services::speaker_monitor::tracker::DRAINING_WARN_SECS)).
const DRAINING_CLEAR_SECS: f64 = 45.0 * 60.0;

impl SpeakerSession {
    /// Whether the reserve and clock are due another report.
    pub(crate) fn report_due(&self, now: Instant) -> bool {
        self.last_report.map_or(true, |at| {
            now.saturating_duration_since(at) >= SPEAKER_REPORT_INTERVAL
        })
    }

    /// Estimates the reserve and clock, publishes them to the connection's
    /// pipeline snapshots, writes the rolled-up `[SpeakerMonitor]` line and
    /// sends it to clients as a speaker health event, warning when the
    /// reserve is draining towards empty or has stepped as an underrun would.
    ///
    /// A window in which the connection came near its declared end is the
    /// end of the item (see [`ConnectionTap::near_declared_end`]): the
    /// speaker reads to about there, plays out and stops, and nothing its
    /// acknowledgements or reserve do on the way is a stall, a reserve
    /// running low or drift. Such a window measures no ack
    /// lag, decides no notice and warns of nothing, and the drift controller
    /// holds through it.
    pub(crate) fn report(
        &mut self,
        stream_id: &str,
        speaker_ip: IpAddr,
        tap: &ConnectionTap,
        now: Instant,
        emitter: &dyn EventEmitter,
    ) {
        let window = self.last_report.map_or(SPEAKER_REPORT_INTERVAL, |at| {
            now.saturating_duration_since(at)
        });
        self.last_report = Some(now);
        let polls = std::mem::take(&mut self.polls_since_report);
        let phase_gap = largest_phase_gap_ms(&mut self.phases_since_report);
        self.phases_since_report.clear();

        let at_declared_end =
            std::mem::take(&mut self.declared_end_in_window) || tap.near_declared_end();
        let now_ms = ms_between(tap.connected_at, now);
        // The correction in force over the window just ended.
        self.tracker.set_command_ppm(self.command_in_force(tap));
        let (estimate, brk) = self.tracker.estimate(now_ms);
        if let Some(outcome) = self.tracker.take_switch_outcome() {
            log_switch_outcome(stream_id, speaker_ip, outcome);
        }
        // Measuring a continuation switch: the estimate is the one from
        // before it, carried forward, and decides nothing.
        let settling = self.tracker.settling();
        if brk == Some(SegmentBreak::OffsetStep) && !at_declared_end {
            log::warn!(
                "[SpeakerMonitor] {} stream={}: underrun suspected: the reserve stepped and \
                 stayed stepped; measuring it afresh",
                speaker_ip,
                stream_id
            );
        }
        // Copies the window out under the pipeline timeline's lock, which
        // the cadence loop also takes every 500 ms. Unlike everything else
        // the monitor reads, this is not an atomic, but the lock is held
        // only for the copy (about 60 entries every 30 s) and never across
        // an await.
        let pipeline = tap.recent_pipeline(window);
        let was_low = self.tracker.is_low();
        let tick_lags = std::mem::take(&mut self.tick_lags_ms);
        let mut lags_ms: Vec<f64> = if tap.byte_rate > 0 && !at_declared_end {
            pipeline
                .iter()
                .filter_map(|s| s.unacked_bytes)
                .map(|b| b as f64 * 1000.0 / f64::from(tap.byte_rate))
                .chain(tick_lags)
                .collect()
        } else {
            Vec::new()
        };
        let acked = if at_declared_end {
            self.tracker.observe_declared_end();
            None
        } else {
            self.tracker.observe_ack_lag(&mut lags_ms)
        };
        let clock = self.tracker.clock();
        // Nothing near the end says where the reserve is heading: hold.
        self.step_drift(tap, now, estimate.filter(|_| !at_declared_end));
        if !at_declared_end {
            note_debt_repaid(
                stream_id,
                speaker_ip,
                tap,
                estimate,
                self.tracker.target_ms(),
            );
        }
        tap.publish_speaker(SpeakerFigures {
            reserve: estimate.map(|e| (e.reserve_ms, e.half_width_ms)),
            clock_ppm: clock.map(|c| (c.ppm, c.se_ppm)),
        });

        let state = self.health_state();
        let reserve = match (&estimate, self.pcm) {
            (Some(e), _) => format!(
                "{:.0}\u{b1}{:.0}ms{}{}",
                e.reserve_ms,
                e.half_width_ms,
                if e.inconsistent { "(incons)" } else { "" },
                format_acked(acked, self.tracker.target_ms()),
            ),
            (None, true) => "\u{2014}".to_string(),
            (None, false) => "n/a(compressed)".to_string(),
        };
        let ttf = self.tracker.time_to_floor_s();
        let (estimates, inconsistent) = self.tracker.connection_estimate_counts();
        let per_min = f64::from(polls) * 60.0 / window.as_secs_f64().max(1.0);
        let topology = format_topology(&std::mem::take(&mut self.topology_since_report));
        let opt_ms =
            |v: Option<f64>| v.map_or_else(|| "\u{2014}".to_string(), |v| format!("{v:.0}"));
        log::info!(
            "[SpeakerMonitor] {} stream={} state={} reserve={} lock={} {} stall={} ttf={} \
             calib={} clock={} {} polls={}({:.0}/min) phase_gap={} incons={}/{} j={:.0}ms {} \
             link={} transport={}{}{}{}",
            speaker_ip,
            stream_id,
            state,
            reserve,
            estimate.map_or("\u{2014}", |e| e.lock_reason.as_str()),
            format_head_start(&self.tracker),
            opt_ms(self.tracker.stall_ms()),
            ttf.map_or_else(
                || "\u{2014}".to_string(),
                |s| format_duration(Duration::from_secs_f64(s))
            ),
            opt_ms(self.tracker.calib_ms()),
            format_clock(clock),
            format_drift(
                &self.drift,
                tap.net_inserted_ms(),
                tap.rate_control().and_then(|c| c.forced_ppm()),
                tap.rate_control().is_some_and(|c| c.is_pinned())
            ),
            polls,
            per_min,
            phase_gap.map_or_else(|| "\u{2014}".to_string(), |g| format!("{g:.0}ms")),
            inconsistent,
            estimates,
            self.tracker.jitter_ms(),
            format_pipeline(&pipeline),
            tap.link_verdict().map_or_else(
                || "\u{2014}".to_string(),
                |q| format!("{q:?}").to_lowercase()
            ),
            self.last_transport_source,
            topology,
            if at_declared_end { " end=declared" } else { "" },
            if settling { " switch=settling" } else { "" },
        );

        // The end of the item: the notice stands as it was, and the low,
        // recovered and draining warnings below say nothing true about it.
        if at_declared_end {
            self.emit_health(stream_id, speaker_ip, state, emitter);
            return;
        }

        // While a switch settles the notice stands as it was too.
        if !settling {
            self.decide_notice(
                stream_id,
                speaker_ip,
                tap,
                now,
                estimate.is_some_and(|e| e.locked()),
                acked,
                brk,
                ttf,
            );
        }

        let is_low = self.tracker.is_low();
        if is_low && !was_low {
            if let (Some(a), Some(floor)) = (acked, self.tracker.floor_ms()) {
                log::warn!(
                    "[SpeakerMonitor] {} stream={}: reserve low: the speaker's buffer spent a \
                     tenth of the last window at or below {:.0}ms of {} audio, under the {:.0}ms \
                     floor for its {}ms head start; it may cut out (reserve={})",
                    speaker_ip,
                    stream_id,
                    a.p10_ms,
                    if a.measured {
                        "acknowledged"
                    } else {
                        "delivered"
                    },
                    floor,
                    self.tracker.head_start().map_or(0, |h| h.sent_ms),
                    reserve
                );
            }
        } else if was_low && !is_low {
            log::info!(
                "[SpeakerMonitor] {} stream={}: reserve recovered (reserve={})",
                speaker_ip,
                stream_id,
                reserve
            );
        }

        let due = draining_warning_due(
            &mut self.draining_warned,
            state,
            ttf,
            self.tracker.clock_drains(),
        );
        if let (true, Some(secs)) = (due, ttf) {
            log::warn!(
                "[SpeakerMonitor] {} stream={}: reserve draining: the speaker plays {} faster \
                 than the audio arrives, leaving about {} before it runs low (reserve={}). A live \
                 source cannot catch up; expect dropouts after that until playback is restarted",
                speaker_ip,
                stream_id,
                format_clock(clock),
                format_duration(Duration::from_secs_f64(secs)),
                reserve
            );
        }

        self.emit_health(stream_id, speaker_ip, state, emitter);
    }
}

/// The widest gap between the polls' phases in the second, `phases` being
/// each poll's position in the second in ms (`[0, 1000)`), counting the gap
/// that wraps from the last phase round to the first. `None` without polls.
///
/// The reserve bounds narrow only as far as the polls fill the second, so
/// this is what limits how tight an estimate can get: ~72 well-spread polls
/// leave gaps of a few tens of ms, a lattice of four points leaves 250.
pub(super) fn largest_phase_gap_ms(phases: &mut [f64]) -> Option<f64> {
    phases.sort_unstable_by(f64::total_cmp);
    let (first, last) = (*phases.first()?, *phases.last()?);
    let inner = phases.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
    Some(inner.max(first + 1000.0 - last))
}

/// A duration for the log: `4.5s`, `12m05s`, `1h23m`.
pub(super) fn format_duration(d: Duration) -> String {
    let secs = d.as_secs();
    if secs < 60 {
        format!("{:.1}s", d.as_secs_f64())
    } else if secs < 3600 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// Steps the draining warning's hysteresis for one report and returns
/// whether to warn now. It fires once on entering [`MonitorState::Draining`]
/// and is re-armed only when the projection recovers past
/// [`DRAINING_CLEAR_SECS`], or lapses because the clock no longer drains.
/// A projection that lapses while the clock still drains (the estimate
/// briefly unlocked, or cleared by an offset step) leaves it fired.
fn draining_warning_due(
    warned: &mut bool,
    state: MonitorState,
    tte: Option<f64>,
    clock_drains: bool,
) -> bool {
    let draining = state == MonitorState::Draining
        || (state == MonitorState::Low
            && tte.is_some_and(|s| {
                s < crate::services::speaker_monitor::tracker::DRAINING_WARN_SECS
            }));
    match tte {
        Some(_) if draining => !std::mem::replace(warned, true),
        Some(secs) if secs >= DRAINING_CLEAR_SECS => {
            *warned = false;
            false
        }
        None if !clock_drains => {
            *warned = false;
            false
        }
        _ => false,
    }
}

/// Logs what a continuation switch came to: one line per switch, at info
/// (debug for a switch between segments too short to measure, which comes
/// round every few seconds in a test configuration).
fn log_switch_outcome(stream_id: &str, speaker_ip: IpAddr, outcome: SwitchOutcome) {
    match outcome {
        SwitchOutcome::Absorbed { offset_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: the speaker counts RelTime \
             {:+.0}ms differently on the new segment; absorbed, the reserve carries on",
            speaker_ip,
            stream_id,
            offset_ms
        ),
        SwitchOutcome::Steady { offset_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: the reserve carries on \
             ({:+.0}ms measured, within measuring error); nothing absorbed",
            speaker_ip,
            stream_id,
            offset_ms
        ),
        SwitchOutcome::Rejected { offset_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: the reserve stepped {:+.0}ms, \
             too far for a reporting offset; not absorbed",
            speaker_ip,
            stream_id,
            offset_ms
        ),
        SwitchOutcome::Reclocked { offset_ms, by_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: offset corrected {:+.0}ms \
             for the speaker's clock, now precise; {:+.0}ms absorbed",
            speaker_ip,
            stream_id,
            by_ms,
            offset_ms
        ),
        SwitchOutcome::Unmeasured(SwitchUnmeasured::ShortSegment) => log::debug!(
            "[SpeakerMonitor] {} stream={}: continuation switch after a short segment; \
             offset not measured",
            speaker_ip,
            stream_id
        ),
        SwitchOutcome::Unmeasured(SwitchUnmeasured::NotTight) => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: offset not measured yet \
             (not_tight); reporting the new segment's own reserve, the drift controller \
             holds until it is measured",
            speaker_ip,
            stream_id
        ),
        SwitchOutcome::Unmeasured(why) => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: offset not measured ({})",
            speaker_ip,
            stream_id,
            why.as_str()
        ),
    }
}

/// A clock estimate for the log: `+39.8±7.1ppm(31m)`, positive when the
/// speaker plays faster than we deliver.
pub(super) fn format_clock(
    clock: Option<crate::services::speaker_monitor::ClockEstimate>,
) -> String {
    clock.map_or_else(
        || "\u{2014}".to_string(),
        |c| {
            format!(
                "{:+.1}\u{b1}{:.1}ppm({}m)",
                c.ppm,
                c.se_ppm,
                (c.span_ms / 60_000.0).round()
            )
        },
    )
}

/// The acknowledged reserve over a report's window, for the log, and how
/// far its 10th percentile has dropped from the level the connection
/// settled at: ` (acked min30s=431 p10=470) dropped=70`. The acknowledged
/// part is left out where acknowledgements are not measured, and `dropped`
/// until the level is learned.
fn format_acked(
    acked: Option<crate::services::speaker_monitor::AckedReserve>,
    target_ms: Option<f64>,
) -> String {
    let measured = acked
        .filter(|a| a.measured)
        .map(|a| format!(" (acked min30s={:.0} p10={:.0})", a.min_ms, a.p10_ms))
        .unwrap_or_default();
    let dropped = acked
        .zip(target_ms)
        .map(|(a, t)| format!(" dropped={:.0}", t - a.p10_ms))
        .unwrap_or_default();
    format!("{measured}{dropped}")
}

/// The head start the connection was sent and the low floor and clear
/// levels sized from it, for the log: `H=500 Hcfg=500 floor=150 clear=250`,
/// with dashes for a compressed connection.
fn format_head_start(tracker: &ReserveTracker) -> String {
    let dash = || "\u{2014}".to_string();
    let head_start = tracker.head_start();
    format!(
        "H={} Hcfg={} floor={} clear={}",
        head_start.map_or_else(dash, |h| h.sent_ms.to_string()),
        head_start.map_or_else(dash, |h| h.configured_ms.to_string()),
        tracker.floor_ms().map_or_else(dash, |f| format!("{f:.0}")),
        tracker.clear_ms().map_or_else(dash, |c| format!("{c:.0}")),
    )
}

/// The cadence queue, delivery gaps and retransmissions over a report's
/// window, for the log.
fn format_pipeline(samples: &[crate::stream::cadence::PipelineSample]) -> String {
    let mut queue: Vec<f64> = samples.iter().map(|s| s.queue_len as f64).collect();
    let queue = WindowStats::of(&mut queue).map_or_else(
        || "\u{2014}".to_string(),
        |q| format!("{:.0}/{:.0}/{:.0}", q.min, q.p10, q.max),
    );
    let gap_max = samples.iter().map(|s| s.max_gap_ms).max();
    let retransmitted: Option<u64> = samples
        .iter()
        .filter_map(|s| s.retransmitted)
        .fold(None, |acc, r| Some(acc.unwrap_or(0) + r));
    format!(
        "queue[min/p10/max]={} gap_max={} retx={}",
        queue,
        gap_max.map_or_else(|| "\u{2014}".to_string(), |g| format!("{g}ms")),
        retransmitted.map_or_else(|| "\u{2014}".to_string(), |r| r.to_string()),
    )
}

/// What drift correction is doing, for the log: `drift=on cmd=+18.0ppm
/// I=+17.6 taught=93m pull=+0.12ppm ins=+54ms` when it corrects the audio,
/// `drift=observe would_cmd=+18.0ppm I=+17.6 taught=93m pull=+0.12ppm` when
/// it only works out what it would do, and `drift=off` otherwise. `taught`
/// is how long the loop has taught the speaker's integral, over every cast,
/// and `pull` how far the clock fit drew it on this report (`pull=—` when it
/// did not). The controller's reason is added when it is not steering
/// (holding, ramping, no target yet, or a distrusted target).
///
/// A rate `THAUMIC_DRIFT_FORCE_PPM` fixed the adapter at is shown as
/// `forced=+150ppm` (with what it has inserted) whatever the mode, since it
/// is what the audio actually gets, and as `forced=+150ppm(pinned)` once
/// the net-insertion guard (`pinned`) holds the adapter at 0 ppm instead.
fn format_drift(
    drift: &DriftController,
    net_inserted_ms: Option<f64>,
    forced_ppm: Option<f64>,
    pinned: bool,
) -> String {
    let base = format_drift_mode(drift, net_inserted_ms.filter(|_| forced_ppm.is_none()));
    match forced_ppm {
        Some(ppm) => {
            let inserted =
                net_inserted_ms.map_or_else(String::new, |ms| format!(" ins={ms:+.0}ms"));
            let pinned = if pinned { "(pinned)" } else { "" };
            format!("{base} forced={ppm:+}ppm{pinned}{inserted}")
        }
        None => base,
    }
}

/// [`format_drift`] without a forced rate.
fn format_drift_mode(drift: &DriftController, net_inserted_ms: Option<f64>) -> String {
    use crate::services::speaker_monitor::ControlHold;
    let mode = drift.mode();
    if mode == DriftMode::Off {
        return "drift=off".to_string();
    }
    let label = if mode == DriftMode::On {
        "cmd"
    } else {
        "would_cmd"
    };
    let hold = match drift.hold() {
        ControlHold::Steering => String::new(),
        other => format!("({})", other.as_str()),
    };
    let saturated = if drift.saturated() { " saturated" } else { "" };
    let inserted = net_inserted_ms.map_or_else(String::new, |ms| format!(" ins={ms:+.0}ms"));
    let pull = drift
        .pull_ppm()
        .map_or_else(|| "\u{2014}".to_string(), |ppm| format!("{ppm:+.2}ppm"));
    format!(
        "drift={mode} {label}={:+.1}ppm{hold} I={:+.1} taught={:.0}m pull={pull}{saturated}{inserted}",
        drift.command_ppm(),
        drift.integral_ppm(),
        drift.state().taught_s / 60.0,
    )
}

/// Household changes noted since the last report, for the end of its line:
/// nothing when there were none.
fn format_topology(changes: &[MemberChange]) -> String {
    if changes.is_empty() {
        return String::new();
    }
    let listed: Vec<String> = changes.iter().map(ToString::to_string).collect();
    format!(" topology[{}]", listed.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::speaker_monitor::session::MAX_TOPOLOGY_NOTES;
    use crate::services::speaker_monitor::{ControlInput, SpeakerControlState};

    #[test]
    fn the_draining_warning_fires_once_until_the_drain_recovers() {
        use MonitorState::{Draining, Locking, Ok};
        let mut warned = false;
        let mut step =
            |state, tte, clock_drains| draining_warning_due(&mut warned, state, tte, clock_drains);
        assert!(step(Draining, Some(900.0), true), "fires on entering");
        assert!(!step(Draining, Some(880.0), true), "once");
        // The estimate unlocks, or an offset step clears it, while the clock
        // still drains: no new warning when it comes back.
        assert!(!step(Locking, None, true));
        assert!(!step(Draining, Some(860.0), true));
        // Between the warning and clearing thresholds nothing changes.
        assert!(!step(Ok, Some(40.0 * 60.0), true));
        assert!(!step(Draining, Some(850.0), true));
        // Recovering past the clearing threshold re-arms it.
        assert!(!step(Ok, Some(DRAINING_CLEAR_SECS), true));
        assert!(step(Draining, Some(800.0), true));
        // So does the clock ceasing to drain.
        assert!(!step(Ok, None, false));
        assert!(step(Draining, Some(800.0), true));
    }

    #[test]
    fn a_low_speaker_that_is_also_draining_still_gets_the_draining_warning() {
        use MonitorState::{Draining, Low};
        let mut warned = false;
        assert!(
            !draining_warning_due(&mut warned, Low, Some(35.0 * 60.0), true),
            "low, but not projected to reach the floor soon"
        );
        assert!(draining_warning_due(&mut warned, Low, Some(600.0), true));
        assert!(!draining_warning_due(
            &mut warned,
            Draining,
            Some(580.0),
            true
        ));
    }

    #[test]
    fn the_acknowledged_reserve_is_logged_only_when_measured() {
        use crate::services::speaker_monitor::AckedReserve;
        let acked = |measured| {
            Some(AckedReserve {
                min_ms: 431.4,
                p10_ms: 470.0,
                median_ms: 480.0,
                measured,
                stall_ms: None,
            })
        };
        assert_eq!(
            format_acked(acked(true), Some(540.2)),
            " (acked min30s=431 p10=470) dropped=70"
        );
        assert_eq!(format_acked(acked(false), Some(540.0)), " dropped=70");
        assert_eq!(
            format_acked(acked(true), None),
            " (acked min30s=431 p10=470)"
        );
        assert_eq!(format_acked(None, None), "");
    }

    #[test]
    fn topology_changes_go_on_the_next_report_line_and_into_the_summary_count() {
        let rebooted = |to| MemberChange::DeviceRebooted {
            uuid: "RINCON_SUB".to_string(),
            from: 31,
            to,
        };
        let mut session = SpeakerSession::new(false, 0);
        assert_eq!(format_topology(&session.topology_since_report), "");

        session.note_topology(rebooted(32));
        assert_eq!(
            format_topology(&session.topology_since_report),
            " topology[RINCON_SUB rebooted (BootSeq 31->32)]"
        );

        // A flapping device fills the line up to its cap; the summary still
        // counts every change.
        for to in 33..45 {
            session.note_topology(rebooted(to));
        }
        assert_eq!(session.topology_since_report.len(), MAX_TOPOLOGY_NOTES);
        assert_eq!(session.connection_topology_changes, 13);
    }

    #[test]
    fn the_report_line_shows_a_forced_rate_in_every_mode() {
        let mut drift = DriftController::default();
        drift.start_connection(DriftMode::Off, true);
        assert_eq!(format_drift(&drift, Some(0.0), None, false), "drift=off");
        assert_eq!(
            format_drift(&drift, Some(12.4), Some(150.0), false),
            "drift=off forced=+150ppm ins=+12ms"
        );
        assert_eq!(
            format_drift(&drift, Some(2000.0), Some(150.0), true),
            "drift=off forced=+150ppm(pinned) ins=+2000ms"
        );
        drift.start_connection(DriftMode::Observe, true);
        let line = format_drift(&drift, Some(-3.0), Some(-42.5), false);
        assert!(line.starts_with("drift=observe would_cmd="), "{line}");
        assert!(line.ends_with(" forced=-42.5ppm ins=-3ms"), "{line}");
        assert_eq!(line.matches("ins=").count(), 1, "{line}");
    }

    #[test]
    fn the_report_line_shows_the_controller_holding_or_steering_by_a_carried_estimate() {
        let mut drift = DriftController::new(SpeakerControlState {
            integral_ppm: 19.0,
            seeded: true,
            ..SpeakerControlState::default()
        });
        drift.start_connection(DriftMode::On, true);
        drift.update(&ControlInput {
            settling: true,
            ..ControlInput::default()
        });
        assert_eq!(
            format_drift(&drift, Some(431.0), None, false),
            "drift=on cmd=+19.0ppm(settle) I=+19.0 taught=0m pull=\u{2014} ins=+431ms"
        );
        // Steering by the estimate carried across a switch.
        drift.update(&ControlInput {
            now_s: 30.0,
            estimate: Some(crate::services::speaker_monitor::ReserveEstimate {
                at: 30_000.0,
                reserve_ms: 500.0,
                half_width_ms: 60.0,
                inconsistent: false,
                jitter_ms: 25.0,
                polls: 12,
                lock_reason: crate::services::speaker_monitor::LockReason::Held,
            }),
            target_ms: Some(500.0),
            head_start_ms: Some(500),
            carry: crate::services::speaker_monitor::EstimateCarry::Teaches,
            ..ControlInput::default()
        });
        assert_eq!(
            format_drift(&drift, Some(431.0), None, false),
            "drift=on cmd=+19.0ppm(carried) I=+19.0 taught=0m pull=\u{2014} ins=+431ms"
        );
    }

    #[test]
    fn the_report_line_shows_how_long_the_integral_was_taught_and_the_clock_fit_drawing_it() {
        use crate::services::speaker_monitor::{ClockEstimate, LockReason, ReserveEstimate};
        let mut drift = DriftController::new(SpeakerControlState {
            integral_ppm: 17.6,
            seeded: true,
            taught_s: 93.0 * 60.0,
            ..SpeakerControlState::default()
        });
        drift.start_connection(DriftMode::On, true);
        let tight = ReserveEstimate {
            at: 0.0,
            reserve_ms: 450.0,
            half_width_ms: 30.0,
            inconsistent: false,
            jitter_ms: 25.0,
            polls: 72,
            lock_reason: LockReason::Tight,
        };
        let report = |now_s: f64, clock: Option<ClockEstimate>| ControlInput {
            now_s,
            estimate: Some(tight),
            target_ms: Some(450.0),
            head_start_ms: Some(500),
            clock,
            ..ControlInput::default()
        };
        // On target, so only the fit moves the integral: taught for 93 min
        // it is weighed as 8.5 ppm off, the fit's ±2 ppm as ±3, and 0.089 of
        // the 1.4 ppm gap is drawn.
        drift.update(&report(
            0.0,
            Some(ClockEstimate {
                ppm: 19.0,
                se_ppm: 2.0,
                span_ms: 90.0 * 60_000.0,
                dof: 85,
            }),
        ));
        assert_eq!(
            format_drift(&drift, Some(54.0), None, false),
            "drift=on cmd=+10.0ppm I=+17.7 taught=93m pull=+0.12ppm ins=+54ms"
        );
        // With no fit precise enough, nothing is drawn.
        drift.update(&report(30.0, None));
        drift.start_connection(DriftMode::Observe, true);
        drift.update(&report(60.0, None));
        let line = format_drift(&drift, None, None, false);
        assert!(
            line.ends_with(" I=+17.7 taught=94m pull=\u{2014}"),
            "{line}"
        );
    }
}
