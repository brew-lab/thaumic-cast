//! Moving a speaker on from one PCM segment of a cast to the next.
//!
//! A long PCM cast is served in segments (see [`crate::stream::playout`]).
//! A speaker plays a segment to the length its WAV header declares, plays out
//! what it holds and reports STOPPED; nothing brings it back on its own. So
//! once it has stopped on segment `k`, the server tells it to play segment
//! `k + 1` (`SetAVTransportURI` and `Play`), which continues the playout
//! where `k` ended: a restart.
//!
//! Each speaker's switch is one **handoff**, from
//! [`HANDOFF_LEAD`](crate::stream::HANDOFF_LEAD) before
//! the segment's end until the speaker reports PLAYING on the next one:
//!
//! - **Transport states:** the STOPPED and TRANSITIONING of the switch would
//!   read to a client as the speaker giving up mid-cast (the extension ends
//!   the cast on a STOPPED). For the coordinator and every speaker joined to
//!   it with `x-rincon`, they are recorded as always but neither broadcast
//!   nor shown in snapshots until the handoff ends (see
//!   [`SonosState::hold_transport`]). When the coordinator plays the next
//!   segment, it is released at once; each member stays held until it
//!   reports PLAYING or PAUSED itself, or for [`MEMBER_GRACE`] at most, as a
//!   member's own events can lag the coordinator's by seconds and the
//!   STOPPED it recorded at the segment's end is not news.
//! - **When to restart:** only on a STOPPED on segment `k` that has lasted
//!   [`STOP_CONFIRM`] and that `GetTransportInfo` and `GetPositionInfo` then
//!   confirm. With no word from GENA, the speaker is asked once its reserve
//!   should have played out, and a STOPPED found then must also last
//!   [`STOP_CONFIRM`] and be confirmed again. `SetAVTransportURI` throws
//!   away whatever the speaker still holds, so restarting any earlier would
//!   skip audio. Nothing is restarted while the speaker is paused or still
//!   playing.
//! - **Never twice:** the restart is sent under the speaker's start lock,
//!   and not at all if the speaker fetched the next segment itself in the
//!   meantime, or a new playout took over.
//! - **If it fails:** a speaker that does not play the next segment within
//!   [`RESTART_PLAY_TIMEOUT`] is told once more; after that the cast ends on
//!   it with [`SpeakerRemovalReason::ContinuationFailed`].

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio::time::Instant;

use super::StreamCoordinator;
use crate::events::{SonosEvent, SpeakerRemovalReason};
use crate::services::playback_session_store::GroupRole;
use crate::sonos::types::TransportState;
use crate::stream::{parse_stream_uri, PcmContinuation, PlayoutChain, PlayoutEvent, PlayoutEvents};
use crate::utils::now_millis;

/// How long a STOPPED on the segment that ended must last before it is
/// taken for the speaker having played it out: a gapless switch, or a fetch
/// arriving just late, can show a brief one.
pub const STOP_CONFIRM: Duration = Duration::from_secs(1);

/// With no STOPPED from GENA, how long after the speaker's reserve should
/// have played out the speaker is asked whether it stopped.
pub const TIMER_MARGIN: Duration = Duration::from_millis(1500);

/// How often a speaker still playing the end of a segment is asked again.
const PLAYING_REPOLL: Duration = Duration::from_millis(500);

/// How often a speaker paused at the end of a segment is looked at again.
const PAUSED_REPOLL: Duration = Duration::from_secs(2);

/// How long after a restart the speaker has to report PLAYING before it is
/// told again, or, the second time, before the cast ends on it.
pub const RESTART_PLAY_TIMEOUT: Duration = Duration::from_secs(10);

/// How many times a speaker is told to play the next segment.
const RESTART_ATTEMPTS: u32 = 2;

/// How long a speaker joined to the coordinator stays held once the
/// coordinator plays the next segment, if it does not report PLAYING or
/// PAUSED itself first: a grouped handover was seen to take up to 3.8 s.
pub const MEMBER_GRACE: Duration = Duration::from_secs(5);

/// How long a handoff lasts after the speaker fetched the next segment, if
/// it never reports PLAYING.
const ATTACHED_MAX: Duration = Duration::from_secs(15);

/// How long a handoff lasts after its segment neared its end, if the segment
/// never reached it (the speaker paused and closed its connection first).
const NEAR_MAX: Duration = Duration::from_secs(12);

/// Longest the watch sleeps between looks, so a cast ended meanwhile
/// releases its speakers promptly.
const WATCH_TICK: Duration = Duration::from_secs(1);

/// The handoffs in progress, one per speaker playout.
#[derive(Default)]
pub(crate) struct Continuations {
    handoffs: Mutex<HashMap<HandoffKey, Handoff>>,
    /// Members still held after their coordinator's handoff succeeded, until
    /// they report PLAYING or PAUSED (see [`MEMBER_GRACE`]), each with the
    /// token of the grace that releases it.
    lingering: Mutex<HashMap<String, u64>>,
    next_generation: std::sync::atomic::AtomicU64,
}

/// Which playout a handoff belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HandoffKey {
    stream_id: String,
    /// The coordinator: the speaker that fetches the stream.
    speaker_ip: String,
}

/// One speaker's switch from one segment to the next.
struct Handoff {
    /// Tells its watch apart from an earlier handoff's.
    generation: u64,
    /// The playout being handed off.
    chain_id: u64,
    /// The playout's segment that is ending.
    seg: u32,
    /// The URL segment of the connection carrying it: the speaker's
    /// CurrentTrackURI until it switches.
    from_url_segment: u32,
    /// Speakers whose transport state is held (see
    /// [`crate::state::SonosState::hold_transport`]).
    held: Vec<String>,
    /// When the handoff began.
    began_at: Instant,
    /// When the segment handed over its last byte.
    ended_at: Option<Instant>,
    /// What the speaker still held then, at least.
    reserve_floor: Duration,
    /// Since when GENA has said STOPPED on the ending segment.
    stopped_since: Option<Instant>,
    /// When the speaker fetched the next segment, or a new playout started.
    attached_at: Option<Instant>,
    /// Restarts sent, and when the last one was.
    restarts: u32,
    restarted_at: Option<Instant>,
    /// Wakes the watch when something changes.
    notify: Arc<Notify>,
}

/// What the watch does next.
enum Step {
    /// The handoff is over.
    Done,
    /// Nothing to do yet: look again after this long, or when woken.
    Wait(Duration),
    /// Ask the speaker whether it stopped on the ending segment, and restart
    /// it if so.
    Confirm(Trigger),
    /// Tell the speaker again to play the next segment.
    Retry,
    /// Give up: the cast ends on the speaker.
    Fail,
}

/// What prompted a restart, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trigger {
    /// GENA said STOPPED.
    Stopped,
    /// The speaker's reserve should have played out, with no word from GENA.
    Timer,
    /// A restart the speaker did not follow.
    Retry,
}

impl Trigger {
    fn label(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Timer => "timer",
            Self::Retry => "retry",
        }
    }
}

/// What asking the speaker found.
enum Confirmation {
    /// Stopped on the ending segment: restart it.
    Stopped,
    /// Not stopped yet: ask again after this long.
    NotYet(Duration),
    /// It is playing something else of ours: no restart is needed.
    Moved,
    /// It holds no media at all (a cleared queue, or a stop that emptied
    /// it): nothing of ours to continue, so the handoff ends and the STOPPED
    /// is shown, as it was before continuation.
    Gone,
}

/// Passes a playout's events on to the coordinator, which it must not keep
/// alive.
struct EventsBridge(Weak<StreamCoordinator>);

impl PlayoutEvents for EventsBridge {
    fn playout_event(&self, chain: &Arc<PlayoutChain>, event: PlayoutEvent) {
        if let Some(coordinator) = self.0.upgrade() {
            coordinator.on_playout_event(chain, event);
        }
    }
}

/// The URL segment `uri` names, if it is one of stream `stream_id`'s PCM
/// URLs.
fn url_segment_of(uri: &str, stream_id: &str) -> Option<u32> {
    let parsed = parse_stream_uri(uri)?;
    if !parsed.stream_id.eq_ignore_ascii_case(stream_id) {
        return None;
    }
    parsed.resource.pcm_segment()
}

impl StreamCoordinator {
    /// Where a new PCM playout tells what happens to it, so its speaker is
    /// moved on from one segment to the next.
    pub fn playout_events(self: &Arc<Self>) -> Arc<dyn PlayoutEvents> {
        Arc::new(EventsBridge(Arc::downgrade(self)))
    }

    /// Takes in one of a playout's events (see [`PlayoutEvent`]). Called on
    /// the streaming runtime with no lock held; does nothing that blocks.
    pub(crate) fn on_playout_event(
        self: &Arc<Self>,
        chain: &Arc<PlayoutChain>,
        event: PlayoutEvent,
    ) {
        if chain.continuation() == PcmContinuation::Off {
            return;
        }
        let key = HandoffKey {
            stream_id: chain.stream_id().to_string(),
            speaker_ip: chain.speaker_ip().to_string(),
        };
        match event {
            PlayoutEvent::HandoffNear { seg, url_segment } => {
                self.begin_handoff(&key, chain.id(), seg, url_segment);
            }
            PlayoutEvent::SegmentEnded {
                seg,
                url_segment,
                reserve_floor_ms,
            } => {
                let now = Instant::now();
                self.begin_handoff(&key, chain.id(), seg, url_segment);
                if let Some(handoff) = self.continuations.handoffs.lock().get_mut(&key) {
                    handoff.ended_at = Some(now);
                    handoff.reserve_floor = Duration::from_millis(reserve_floor_ms);
                    handoff.notify.notify_one();
                }
            }
            PlayoutEvent::Continued {
                seg,
                url_segment,
                kind,
            } => {
                let mut handoffs = self.continuations.handoffs.lock();
                // Any fetch that continues the playout, a reopen of the
                // ending segment included, is the speaker carrying on by
                // itself: no restart, and the handoff ends once it plays.
                if let Some(handoff) = handoffs.get_mut(&key) {
                    handoff.attached_at.get_or_insert_with(Instant::now);
                    handoff.notify.notify_one();
                    log::info!(
                        "[Stream] Handoff: stream={} speaker={} seg={} fetched as {} \
                         (url_segment={}); waiting for PLAYING",
                        key.stream_id,
                        key.speaker_ip,
                        seg,
                        kind.label(),
                        url_segment
                    );
                }
            }
            PlayoutEvent::Started { url_segment } => {
                let mut handoffs = self.continuations.handoffs.lock();
                if let Some(handoff) = handoffs.get_mut(&key) {
                    if handoff.chain_id != chain.id() {
                        handoff.attached_at.get_or_insert_with(Instant::now);
                        handoff.notify.notify_one();
                        log::info!(
                            "[Stream] Handoff: stream={} speaker={} a new playout started on \
                             url_segment={}; no restart will be sent",
                            key.stream_id,
                            key.speaker_ip,
                            url_segment
                        );
                    }
                }
            }
            PlayoutEvent::ClosedMid { seg, url_segment } => {
                let ended = {
                    let mut handoffs = self.continuations.handoffs.lock();
                    let closes = handoffs.get(&key).is_some_and(|h| h.chain_id == chain.id());
                    closes.then(|| handoffs.remove(&key)).flatten()
                };
                if let Some(handoff) = ended {
                    log::info!(
                        "[Stream] Handoff ended: stream={} speaker={} seg={} url_segment={}: the \
                         speaker closed its connection part way (a pause or a skip), which is \
                         not a boundary",
                        key.stream_id,
                        key.speaker_ip,
                        seg,
                        url_segment
                    );
                    self.finish_handoff(handoff);
                }
            }
            PlayoutEvent::Retired => {}
        }
    }

    /// Starts the handoff of segment `seg` of playout `chain_id`, carried
    /// under URL segment `url_segment`, unless it has begun: holds the
    /// transport state of the coordinator and its `x-rincon` members, and
    /// starts the watch that restarts the speaker.
    fn begin_handoff(
        self: &Arc<Self>,
        key: &HandoffKey,
        chain_id: u64,
        seg: u32,
        url_segment: u32,
    ) {
        let Some(session) = self.sessions.get(&key.stream_id, &key.speaker_ip) else {
            return;
        };
        if session.role != GroupRole::Coordinator {
            return;
        }
        let mut replaced = None;
        let spawn = {
            let mut handoffs = self.continuations.handoffs.lock();
            match handoffs.get(key) {
                Some(h) if h.chain_id == chain_id && h.seg == seg => None,
                _ => {
                    let mut held = vec![key.speaker_ip.clone()];
                    held.extend(
                        self.sessions
                            .get_slaves_for_coordinator(&key.stream_id, &key.speaker_ip)
                            .into_iter()
                            .map(|(k, _)| k.speaker_ip),
                    );
                    for ip in &held {
                        self.sonos_state.hold_transport(ip);
                    }
                    let generation = self
                        .continuations
                        .next_generation
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let notify = Arc::new(Notify::new());
                    log::info!(
                        "[Stream] Handoff: stream={} speaker={} seg={} url_segment={} begins; \
                         holding the transport state of {} while it switches",
                        key.stream_id,
                        key.speaker_ip,
                        seg,
                        url_segment,
                        held.join(",")
                    );
                    replaced = handoffs.insert(
                        key.clone(),
                        Handoff {
                            generation,
                            chain_id,
                            seg,
                            from_url_segment: url_segment,
                            held,
                            began_at: Instant::now(),
                            ended_at: None,
                            reserve_floor: Duration::ZERO,
                            stopped_since: None,
                            attached_at: None,
                            restarts: 0,
                            restarted_at: None,
                            notify: Arc::clone(&notify),
                        },
                    );
                    Some((generation, notify))
                }
            }
        };
        if let Some(old) = replaced {
            // Its speakers are held again by the new one; only those it held
            // alone are released.
            let still: Vec<String> = self
                .continuations
                .handoffs
                .lock()
                .get(key)
                .map(|h| h.held.clone())
                .unwrap_or_default();
            old.notify.notify_one();
            for ip in old.held.iter().filter(|ip| !still.contains(ip)) {
                self.release_transport(ip);
            }
        }
        if let Some((generation, notify)) = spawn {
            let coordinator = Arc::clone(self);
            let key = key.clone();
            self.spawn_control(async move {
                coordinator.watch_handoff(key, generation, notify).await;
            });
        }
    }

    /// Takes in a transport state GENA reported for `speaker_ip`, playing
    /// `current_uri`: a parked playout counts its life from a STOPPED, and a
    /// handoff watches for its speaker stopping on the ending segment and
    /// ends once it plays the next one.
    pub fn note_transport_state(
        self: &Arc<Self>,
        speaker_ip: &str,
        state: TransportState,
        current_uri: Option<&str>,
    ) {
        if state == TransportState::Stopped {
            self.note_speaker_stopped(speaker_ip);
        }
        if matches!(state, TransportState::Playing | TransportState::Paused) {
            self.member_reported(speaker_ip);
        }
        let now = Instant::now();
        let finished = {
            let mut handoffs = self.continuations.handoffs.lock();
            let Some((key, handoff)) = handoffs
                .iter_mut()
                .find(|(key, _)| key.speaker_ip == speaker_ip)
            else {
                return;
            };
            let url_segment = current_uri.and_then(|uri| url_segment_of(uri, &key.stream_id));
            let on_ending = current_uri.is_none() || url_segment == Some(handoff.from_url_segment);
            match state {
                TransportState::Stopped => {
                    if on_ending && handoff.ended_at.is_some() {
                        handoff.stopped_since.get_or_insert(now);
                        handoff.notify.notify_one();
                    }
                    None
                }
                TransportState::Playing => {
                    // On the next segment, or on ours at all once the speaker
                    // has fetched again (a reopen of the ending segment plays
                    // new audio under its old URL).
                    let moved = url_segment.is_some_and(|s| s != handoff.from_url_segment);
                    let fetched = handoff.attached_at.is_some()
                        && (url_segment.is_some() || current_uri.is_none());
                    if moved || fetched {
                        Some(key.clone())
                    } else {
                        handoff.stopped_since = None;
                        None
                    }
                }
                TransportState::Paused => {
                    handoff.stopped_since = None;
                    None
                }
                TransportState::Transitioning => None,
            }
        };
        let Some(key) = finished else {
            return;
        };
        let Some(handoff) = self.continuations.handoffs.lock().remove(&key) else {
            return;
        };
        let gap_from = handoff.stopped_since.or_else(|| {
            handoff
                .ended_at
                .map(|t| t + handoff.reserve_floor + TIMER_MARGIN)
        });
        let debt = self
            .get_stream(&key.stream_id)
            .and_then(|s| s.playout.get(speaker_ip.parse().ok()?))
            .and_then(|chain| chain.latency_debt())
            .filter(|d| d.seg > handoff.seg);
        log::info!(
            "[Stream] Continuation playing: stream={} speaker={} seg={} mode={} \
             audible_gap_ms={} latency_debt_ms={} restarts={}",
            key.stream_id,
            key.speaker_ip,
            handoff.seg.wrapping_add(1),
            if handoff.restarts > 0 {
                "restart"
            } else {
                "fetched"
            },
            gap_from.map_or(0, |t| now.saturating_duration_since(t).as_millis()),
            debt.map_or(0, |d| d.debt_ms),
            handoff.restarts
        );
        self.complete_handoff(&key, handoff);
    }

    /// The speakers some handoff holds.
    fn held_by_handoffs(&self) -> Vec<String> {
        self.continuations
            .handoffs
            .lock()
            .values()
            .flat_map(|h| h.held.iter().cloned())
            .collect()
    }

    /// Ends a handoff taken out of the map: wakes its watch so it stops, and
    /// releases the speakers it held.
    fn finish_handoff(&self, handoff: Handoff) {
        handoff.notify.notify_one();
        let still_held = self.held_by_handoffs();
        for ip in handoff.held.iter().filter(|ip| !still_held.contains(ip)) {
            self.release_transport(ip);
        }
    }

    /// Ends a handoff taken out of the map because its coordinator moved on
    /// to the next segment: releases the coordinator, and keeps each member
    /// held until it reports PLAYING or PAUSED itself, or [`MEMBER_GRACE`]
    /// has passed. A member's own events can lag the coordinator's by
    /// seconds, and releasing it at once would tell clients the STOPPED it
    /// recorded at the segment's end, which ends the cast on it.
    fn complete_handoff(self: &Arc<Self>, key: &HandoffKey, handoff: Handoff) {
        handoff.notify.notify_one();
        let still_held = self.held_by_handoffs();
        let mut members = Vec::new();
        for ip in handoff
            .held
            .into_iter()
            .filter(|ip| !still_held.contains(ip))
        {
            if ip == key.speaker_ip {
                self.release_transport(&ip);
            } else {
                members.push(ip);
            }
        }
        if members.is_empty() {
            return;
        }
        let token = self
            .continuations
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut lingering = self.continuations.lingering.lock();
            for ip in &members {
                lingering.insert(ip.clone(), token);
            }
        }
        let coordinator = Arc::clone(self);
        self.spawn_control(async move {
            tokio::time::sleep(MEMBER_GRACE).await;
            coordinator.end_member_grace(&members, token);
        });
    }

    /// Releases a member held after its coordinator's handoff once it
    /// reports PLAYING or PAUSED: the state it reports is shown as usual,
    /// so nothing more is told.
    fn member_reported(&self, speaker_ip: &str) {
        if self
            .continuations
            .lingering
            .lock()
            .remove(speaker_ip)
            .is_none()
        {
            return;
        }
        if !self.held_by_handoffs().iter().any(|ip| ip == speaker_ip) {
            self.sonos_state.release_transport(speaker_ip);
        }
    }

    /// Releases the members of grace `token` that never reported PLAYING or
    /// PAUSED, telling clients the state GENA last recorded for each.
    fn end_member_grace(&self, members: &[String], token: u64) {
        let expired: Vec<&String> = {
            let mut lingering = self.continuations.lingering.lock();
            members
                .iter()
                .filter(|ip| {
                    let ours = lingering.get(ip.as_str()) == Some(&token);
                    if ours {
                        lingering.remove(ip.as_str());
                    }
                    ours
                })
                .collect()
        };
        if expired.is_empty() {
            return;
        }
        let still_held = self.held_by_handoffs();
        for ip in expired.into_iter().filter(|ip| !still_held.contains(ip)) {
            log::info!(
                "[Stream] Handoff: speaker {} joined to a coordinator that switched segments did \
                 not report PLAYING within {} ms; showing its recorded state",
                ip,
                MEMBER_GRACE.as_millis()
            );
            self.release_transport(ip);
        }
    }

    /// Stops holding `speaker_ip`'s transport state, and tells clients the
    /// state GENA last reported if they were shown another.
    fn release_transport(&self, speaker_ip: &str) {
        if let Some(state) = self.sonos_state.release_transport(speaker_ip) {
            self.emitter.emit_sonos(SonosEvent::TransportState {
                speaker_ip: speaker_ip.to_string(),
                state,
                current_uri: None,
                timestamp: now_millis(),
            });
        }
    }

    /// Takes a handoff out of the map if it is still generation
    /// `generation`.
    fn take_handoff(&self, key: &HandoffKey, generation: u64) -> Option<Handoff> {
        let mut handoffs = self.continuations.handoffs.lock();
        if handoffs.get(key)?.generation != generation {
            return None;
        }
        handoffs.remove(key)
    }

    /// Watches one handoff until it is over, restarting the speaker on the
    /// next segment once it has played out the one that ended.
    async fn watch_handoff(self: Arc<Self>, key: HandoffKey, generation: u64, notify: Arc<Notify>) {
        loop {
            match self.handoff_step(&key, generation) {
                Step::Done => return,
                Step::Wait(wait) => {
                    tokio::select! {
                        () = notify.notified() => {}
                        () = tokio::time::sleep(wait.min(WATCH_TICK)) => {}
                    }
                }
                Step::Confirm(trigger) => match self.confirm_stopped(&key, generation).await {
                    // With no STOPPED from GENA, one found by asking must
                    // last as long as GENA's would, and be confirmed again.
                    Confirmation::Stopped if trigger == Trigger::Timer => {
                        if let Some(h) = self
                            .continuations
                            .handoffs
                            .lock()
                            .get_mut(&key)
                            .filter(|h| h.generation == generation)
                        {
                            h.stopped_since.get_or_insert_with(Instant::now);
                        }
                    }
                    Confirmation::Stopped => self.restart_part(&key, generation, trigger).await,
                    Confirmation::NotYet(wait) => {
                        tokio::select! {
                            () = notify.notified() => {}
                            () = tokio::time::sleep(wait) => {}
                        }
                    }
                    Confirmation::Moved => {
                        if let Some(handoff) = self.take_handoff(&key, generation) {
                            self.complete_handoff(&key, handoff);
                        }
                        return;
                    }
                    Confirmation::Gone => {
                        if let Some(handoff) = self.take_handoff(&key, generation) {
                            self.finish_handoff(handoff);
                        }
                        return;
                    }
                },
                Step::Retry => self.restart_part(&key, generation, Trigger::Retry).await,
                Step::Fail => {
                    self.fail_continuation(&key, generation).await;
                    return;
                }
            }
        }
    }

    /// Decides the watch's next step from the handoff as it stands.
    fn handoff_step(&self, key: &HandoffKey, generation: u64) -> Step {
        let now = Instant::now();
        let session_live = self
            .sessions
            .get(&key.stream_id, &key.speaker_ip)
            .is_some_and(|s| s.role == GroupRole::Coordinator);
        let mut handoffs = self.continuations.handoffs.lock();
        let Some(handoff) = handoffs.get_mut(key).filter(|h| h.generation == generation) else {
            return Step::Done;
        };
        let expired = |since: Instant, max: Duration| now.saturating_duration_since(since) >= max;
        let over = !session_live
            || handoff
                .attached_at
                .is_some_and(|at| expired(at, ATTACHED_MAX))
            || (handoff.ended_at.is_none() && expired(handoff.began_at, NEAR_MAX));
        if over {
            let handoff = handoffs.remove(key);
            drop(handoffs);
            if let Some(handoff) = handoff {
                log::info!(
                    "[Stream] Handoff ended: stream={} speaker={} seg={}{}",
                    key.stream_id,
                    key.speaker_ip,
                    handoff.seg,
                    if session_live {
                        " without PLAYING on the next segment being reported"
                    } else {
                        ": the cast on the speaker ended"
                    }
                );
                self.finish_handoff(handoff);
            }
            return Step::Done;
        }
        if handoff.attached_at.is_some() {
            return Step::Wait(ATTACHED_MAX);
        }
        if let Some(at) = handoff.restarted_at {
            let waited = now.saturating_duration_since(at);
            if waited < RESTART_PLAY_TIMEOUT {
                return Step::Wait(RESTART_PLAY_TIMEOUT - waited);
            }
            return if handoff.restarts < RESTART_ATTEMPTS {
                Step::Retry
            } else {
                Step::Fail
            };
        }
        let Some(ended_at) = handoff.ended_at else {
            return Step::Wait(NEAR_MAX);
        };
        if let Some(since) = handoff.stopped_since {
            let lasted = now.saturating_duration_since(since);
            return if lasted >= STOP_CONFIRM {
                Step::Confirm(Trigger::Stopped)
            } else {
                Step::Wait(STOP_CONFIRM - lasted)
            };
        }
        let paused = self
            .sonos_state
            .transport_states
            .get(&key.speaker_ip)
            .is_some_and(|s| *s == TransportState::Paused);
        if paused {
            return Step::Wait(PAUSED_REPOLL);
        }
        let due = ended_at + handoff.reserve_floor + TIMER_MARGIN;
        if now >= due {
            Step::Confirm(Trigger::Timer)
        } else {
            Step::Wait(due - now)
        }
    }

    /// Asks the speaker whether it has stopped on the segment that ended:
    /// `GetTransportInfo` must say STOPPED and `GetPositionInfo` name that
    /// segment.
    async fn confirm_stopped(&self, key: &HandoffKey, generation: u64) -> Confirmation {
        let from = {
            let handoffs = self.continuations.handoffs.lock();
            match handoffs.get(key).filter(|h| h.generation == generation) {
                Some(h) => h.from_url_segment,
                None => return Confirmation::NotYet(Duration::ZERO),
            }
        };
        let ip = key.speaker_ip.as_str();
        let state = match self.sonos.get_transport_info(ip).await {
            Ok(state) => state,
            Err(e) => {
                log::warn!(
                    "[Stream] Handoff: stream={} speaker={}: GetTransportInfo failed ({}); \
                     asking again",
                    key.stream_id,
                    ip,
                    e
                );
                return Confirmation::NotYet(WATCH_TICK);
            }
        };
        let not_yet = |wait: Duration| {
            // Whatever GENA said, the speaker is not stopped: count afresh.
            if let Some(h) = self.continuations.handoffs.lock().get_mut(key) {
                h.stopped_since = None;
            }
            Confirmation::NotYet(wait)
        };
        match state {
            TransportState::Stopped => {}
            TransportState::Paused => return not_yet(PAUSED_REPOLL),
            TransportState::Playing | TransportState::Transitioning => {
                return not_yet(PLAYING_REPOLL)
            }
        }
        match self.sonos.get_position_info(ip).await {
            // After a clean end a speaker keeps the segment's URI; none at
            // all is no media, not our segment played out.
            Ok(position) if position.track_uri.is_empty() => {
                log::info!(
                    "[Stream] Handoff ended: stream={} speaker={} is stopped with no media; not \
                     restarting it",
                    key.stream_id,
                    ip
                );
                Confirmation::Gone
            }
            Ok(position) => match url_segment_of(&position.track_uri, &key.stream_id) {
                Some(segment) if segment == from => Confirmation::Stopped,
                Some(segment) => {
                    log::info!(
                        "[Stream] Handoff: stream={} speaker={} is already on url_segment={}; no \
                         restart needed",
                        key.stream_id,
                        ip,
                        segment
                    );
                    Confirmation::Moved
                }
                // Another source: the source-change handling ends the cast.
                None => Confirmation::NotYet(WATCH_TICK),
            },
            Err(e) => {
                log::warn!(
                    "[Stream] Handoff: stream={} speaker={}: GetPositionInfo failed ({}); asking \
                     again",
                    key.stream_id,
                    ip,
                    e
                );
                Confirmation::NotYet(WATCH_TICK)
            }
        }
    }

    /// Tells the speaker to play the segment after the one that ended,
    /// under its start lock, unless it has fetched it by itself meanwhile.
    async fn restart_part(&self, key: &HandoffKey, generation: u64, trigger: Trigger) {
        let Some(stream) = self.get_stream(&key.stream_id) else {
            return;
        };
        let Ok(ip) = key.speaker_ip.parse::<IpAddr>() else {
            return;
        };
        let _start = self
            .sessions
            .lock_speaker_start(&key.stream_id, &key.speaker_ip)
            .await;
        let Some(session) = self
            .sessions
            .get(&key.stream_id, &key.speaker_ip)
            .filter(|s| s.role == GroupRole::Coordinator)
        else {
            return;
        };
        let (chain_id, seg, next, ended_at) = {
            let handoffs = self.continuations.handoffs.lock();
            match handoffs.get(key).filter(|h| h.generation == generation) {
                Some(h) if h.attached_at.is_none() => (
                    h.chain_id,
                    h.seg,
                    h.from_url_segment.wrapping_add(1),
                    h.ended_at,
                ),
                // Fetched meanwhile, or over.
                _ => return,
            }
        };
        let chain = stream.playout.get(ip);
        let rejoin = match &chain {
            Some(chain) if chain.id() == chain_id => match chain.prepare_restart(next) {
                Some(rejoin) => rejoin.label(),
                None => {
                    log::info!(
                        "[Stream] Continuation restart skipped: stream={} speaker={} seg={}: the \
                         speaker fetched the next segment itself",
                        key.stream_id,
                        key.speaker_ip,
                        seg.wrapping_add(1)
                    );
                    return;
                }
            },
            Some(_) => {
                log::info!(
                    "[Stream] Continuation restart skipped: stream={} speaker={} seg={}: a new \
                     playout has taken over",
                    key.stream_id,
                    key.speaker_ip,
                    seg.wrapping_add(1)
                );
                return;
            }
            None => "none (the playout was dropped; the speaker starts again from the live edge)",
        };
        let url = format!("{}/{}", session.stream_url, next);
        let metadata = stream.metadata.read().clone();
        let artwork_url = self.network.url_builder().artwork_url();
        log::info!(
            "[Stream] Continuation restart: stream={} speaker={} seg={} url_segment={} \
             trigger={} after_end_ms={} rejoin={}",
            key.stream_id,
            key.speaker_ip,
            seg.wrapping_add(1),
            next,
            trigger.label(),
            ended_at.map_or(0, |t| t.elapsed().as_millis()),
            rejoin
        );
        let result = self
            .sonos
            .play_uri(
                &key.speaker_ip,
                &url,
                session.codec,
                &stream.audio_format,
                Some(&metadata),
                &artwork_url,
            )
            .await;
        let now = Instant::now();
        let mut handoffs = self.continuations.handoffs.lock();
        let Some(handoff) = handoffs.get_mut(key).filter(|h| h.generation == generation) else {
            return;
        };
        handoff.restarts += 1;
        handoff.stopped_since = None;
        match result {
            Ok(()) => handoff.restarted_at = Some(now),
            Err(e) => {
                log::warn!(
                    "[Stream] Continuation restart failed: stream={} speaker={} seg={}: {}",
                    key.stream_id,
                    key.speaker_ip,
                    seg.wrapping_add(1),
                    e
                );
                if let Some(chain) = chain.filter(|c| c.id() == chain_id) {
                    chain.cancel_restart();
                }
                // Due for the next attempt, or the end, at once.
                handoff.restarted_at = Some(now - RESTART_PLAY_TIMEOUT);
            }
        }
    }

    /// Ends the cast on a speaker that would not play the next segment.
    async fn fail_continuation(&self, key: &HandoffKey, generation: u64) {
        let Some(handoff) = self.take_handoff(key, generation) else {
            return;
        };
        log::warn!(
            "[Stream] Continuation failed: stream={} speaker={} seg={} reason=no_playing \
             restarts={}; ending the cast on it",
            key.stream_id,
            key.speaker_ip,
            handoff.seg.wrapping_add(1),
            handoff.restarts
        );
        self.stop_playback_speaker(
            &key.stream_id,
            &key.speaker_ip,
            Some(SpeakerRemovalReason::ContinuationFailed),
        )
        .await;
        self.finish_handoff(handoff);
    }

    /// Runs a handoff's watch or a member's grace on the control runtime
    /// when one is set (see [`StreamCoordinator::set_control_runtime`]), so
    /// its SOAP calls stay off the streaming runtime a playout's events come
    /// from.
    fn spawn_control<F>(&self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        match &self.control_runtime {
            Some(handle) => {
                handle.spawn(future);
            }
            None => {
                tokio::spawn(future);
            }
        }
    }

    /// Whether `speaker_ip`'s transport state is held by a handoff.
    #[cfg(test)]
    pub(crate) fn in_handoff(&self, speaker_ip: &str) -> bool {
        self.continuations
            .handoffs
            .lock()
            .keys()
            .any(|k| k.speaker_ip == speaker_ip)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use bytes::Bytes;
    use futures::StreamExt;

    use super::*;
    use crate::context::NetworkContext;
    use crate::error::SoapResult;
    use crate::events::{EventEmitter, NetworkEvent, StreamEvent, TopologyEvent};
    use crate::services::playback_session_store::PlaybackSession;
    use crate::sonos::gena::GenaSubscriptionManager;
    use crate::sonos::subscription_arbiter::SubscriptionArbiter;
    use crate::sonos::traits::SonosPlayback;
    use crate::sonos::types::PositionInfo;
    use crate::state::{SonosState, StreamingConfig};
    use crate::stream::{
        AudioCodec, AudioFormat, ChainParts, ChainStats, LoggingStreamGuard, PcmStream, Route,
        SegmentBody, SegmentLayout, SegmentStart, StreamMetadata,
    };

    const COORDINATOR: &str = "192.168.1.100";
    const MEMBER: &str = "192.168.1.101";

    /// A speaker whose answers the test sets, recording what it is told.
    #[derive(Default)]
    struct ScriptedSonos {
        transport: parking_lot::Mutex<Option<TransportState>>,
        track_uri: parking_lot::Mutex<String>,
        played: parking_lot::Mutex<Vec<(String, String)>>,
        /// When each `play_uri` and `GetTransportInfo` came.
        played_at: parking_lot::Mutex<Vec<Instant>>,
        polled_at: parking_lot::Mutex<Vec<Instant>>,
        stops: AtomicUsize,
    }

    impl ScriptedSonos {
        fn played(&self) -> Vec<(String, String)> {
            self.played.lock().clone()
        }

        /// Answers from now on as a speaker stopped on `track_uri`.
        fn stopped_on(&self, track_uri: &str) {
            *self.transport.lock() = Some(TransportState::Stopped);
            *self.track_uri.lock() = track_uri.to_string();
        }
    }

    #[async_trait]
    impl SonosPlayback for ScriptedSonos {
        async fn play_uri(
            &self,
            ip: &str,
            uri: &str,
            _: AudioCodec,
            _: &AudioFormat,
            _: Option<&StreamMetadata>,
            _: &str,
        ) -> SoapResult<()> {
            self.played.lock().push((ip.to_string(), uri.to_string()));
            self.played_at.lock().push(Instant::now());
            Ok(())
        }
        async fn play(&self, _: &str) -> SoapResult<()> {
            Ok(())
        }
        async fn stop(&self, _: &str) -> SoapResult<()> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn switch_to_queue(&self, _: &str, _: &str) -> SoapResult<()> {
            Ok(())
        }
        async fn get_position_info(&self, _: &str) -> SoapResult<PositionInfo> {
            Ok(PositionInfo {
                track_uri: self.track_uri.lock().clone(),
                rel_time_ms: 0,
            })
        }
        async fn get_transport_info(&self, _: &str) -> SoapResult<TransportState> {
            self.polled_at.lock().push(Instant::now());
            Ok(self.transport.lock().unwrap_or(TransportState::Playing))
        }
        async fn join_group(&self, _: &str, _: &str) -> SoapResult<()> {
            Ok(())
        }
        async fn leave_group(&self, _: &str) -> SoapResult<()> {
            Ok(())
        }
    }

    /// Collects what clients are sent.
    #[derive(Default)]
    struct Collector {
        stream: parking_lot::Mutex<Vec<StreamEvent>>,
        sonos: parking_lot::Mutex<Vec<SonosEvent>>,
    }

    impl EventEmitter for Collector {
        fn emit_stream(&self, event: StreamEvent) {
            self.stream.lock().push(event);
        }
        fn emit_sonos(&self, event: SonosEvent) {
            self.sonos.lock().push(event);
        }
        fn emit_latency(&self, _: crate::events::LatencyEvent) {}
        fn emit_network(&self, _: NetworkEvent) {}
        fn emit_topology(&self, _: TopologyEvent) {}
    }

    /// A coordinator with one PCM stream cast to [`COORDINATOR`], and
    /// optionally [`MEMBER`] joined to it.
    struct Rig {
        coordinator: Arc<StreamCoordinator>,
        sonos: Arc<ScriptedSonos>,
        emitter: Arc<Collector>,
        state: Arc<SonosState>,
        stream_id: String,
        layout: SegmentLayout,
    }

    impl Rig {
        fn new(with_member: bool) -> Self {
            let sonos = Arc::new(ScriptedSonos::default());
            let emitter = Arc::new(Collector::default());
            let state = Arc::new(SonosState::default());
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(1))
                .build()
                .unwrap();
            let (gena, _rx) = GenaSubscriptionManager::new(client);
            let coordinator = Arc::new(StreamCoordinator::new(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&state),
                NetworkContext::for_test(),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
                StreamingConfig::default(),
                Arc::new(SubscriptionArbiter::new(Arc::new(gena))),
            ));
            let stream_id = coordinator
                .create_stream(AudioCodec::Pcm, AudioFormat::default(), 200, 10)
                .unwrap();
            let base = format!("http://127.0.0.1:49400/stream/{stream_id}/live");
            coordinator.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: COORDINATOR.to_string(),
                stream_url: base,
                codec: AudioCodec::Pcm,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });
            state.record_transport_state(COORDINATOR, TransportState::Playing);
            if with_member {
                coordinator.insert_test_session(PlaybackSession {
                    stream_id: stream_id.clone(),
                    speaker_ip: MEMBER.to_string(),
                    stream_url: "x-rincon:RINCON_COORD".to_string(),
                    codec: AudioCodec::Pcm,
                    role: GroupRole::Slave,
                    coordinator_ip: Some(COORDINATOR.to_string()),
                    coordinator_uuid: Some("RINCON_COORD".to_string()),
                    original_coordinator_uuid: None,
                });
                state.record_transport_state(MEMBER, TransportState::Playing);
            }
            Self {
                coordinator,
                sonos,
                emitter,
                state,
                stream_id,
                layout: SegmentLayout::new(&AudioFormat::default(), 96_000),
            }
        }

        /// The URL of segment `n` as a speaker reports it.
        fn uri(&self, n: u32) -> String {
            crate::stream::pcm_segment_uri(
                &format!("http://127.0.0.1:49400/stream/{}/live", self.stream_id),
                n,
            )
        }

        fn ip() -> IpAddr {
            COORDINATOR.parse().unwrap()
        }

        /// Starts the coordinator's playout, fed a 10 ms frame every 10 ms.
        fn start(&self, continuation: PcmContinuation) -> SegmentBody {
            let stream = self.coordinator.get_stream(&self.stream_id).unwrap();
            let mut ticks = tokio::time::interval(Duration::from_millis(10));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
            let cadence: PcmStream = Box::pin(futures::stream::unfold(ticks, |mut t| async move {
                t.tick().await;
                Some((Ok(Bytes::from(vec![1u8; 1920])), t))
            }));
            let guard = Arc::new(LoggingStreamGuard::new(self.stream_id.clone(), Self::ip()));
            PlayoutChain::start(ChainParts {
                stream_id: self.stream_id.clone(),
                speaker_ip: Self::ip(),
                format: AudioFormat::default(),
                layout: self.layout,
                cadence,
                stats: Arc::new(ChainStats::new(self.stream_id.clone(), Self::ip())),
                tap: None,
                start: SegmentStart::new(0, None, &self.layout).unwrap(),
                guard,
                registry: Some(Arc::clone(&stream.playout)),
                continuation,
                head_start: Duration::from_millis(500),
                events: Some(self.coordinator.playout_events()),
            })
        }

        /// Plays segment 0 to its end.
        async fn play_first_segment(&self, continuation: PcmContinuation) {
            let mut body = self.start(continuation);
            while let Some(item) = body.next().await {
                item.unwrap();
            }
        }

        /// The speaker fetches segment `n` and reads a little of it.
        async fn fetch(&self, n: u32) -> SegmentBody {
            let stream = self.coordinator.get_stream(&self.stream_id).unwrap();
            let guard = Arc::new(LoggingStreamGuard::new(self.stream_id.clone(), Self::ip()));
            let route = stream
                .playout
                .route(Self::ip(), n, None, &self.layout, move |_| guard);
            let Route::Attach(mut body) = route else {
                panic!("segment {n} should continue the playout");
            };
            body.next().await.unwrap().unwrap();
            body
        }

        /// The transport states clients were told for `ip`.
        fn told(&self, ip: &str) -> Vec<TransportState> {
            self.emitter
                .sonos
                .lock()
                .iter()
                .filter_map(|e| match e {
                    SonosEvent::TransportState {
                        speaker_ip, state, ..
                    } if speaker_ip == ip => Some(*state),
                    _ => None,
                })
                .collect()
        }

        /// GENA reports `state` on `uri` for `ip`, as the event processor
        /// passes it on; returns whether clients were told.
        fn gena(&self, ip: &str, state: TransportState, uri: Option<&str>) -> bool {
            self.state.record_transport_state(ip, state);
            self.coordinator.note_transport_state(ip, state, uri);
            self.state.screen_transport(ip, state)
        }

        fn stop_reasons(&self) -> Vec<(String, Option<SpeakerRemovalReason>)> {
            self.emitter
                .stream
                .lock()
                .iter()
                .filter_map(|e| match e {
                    StreamEvent::PlaybackStopped {
                        speaker_ip, reason, ..
                    } => Some((speaker_ip.clone(), *reason)),
                    _ => None,
                })
                .collect()
        }
    }

    async fn sleep_ms(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    /// The whole restart: once the coordinator has played segment 0 out and
    /// stayed STOPPED on it for a second, confirmed by asking, it is told to
    /// play segment 1, once. Meanwhile neither it nor the speaker joined to
    /// it shows clients the STOPPED, in events or snapshots, and both are
    /// released once it plays segment 1.
    #[tokio::test(start_paused = true)]
    async fn a_speaker_that_played_out_its_segment_is_restarted_on_the_next_once() {
        let rig = Rig::new(true);
        rig.play_first_segment(PcmContinuation::Restart).await;
        assert!(rig.coordinator.in_handoff(COORDINATOR));
        assert!(rig.state.is_transport_held(MEMBER));

        rig.sonos.stopped_on(&rig.uri(0));
        assert!(!rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0))));
        assert!(!rig.gena(
            MEMBER,
            TransportState::Stopped,
            Some("x-rincon:RINCON_COORD")
        ));
        assert!(!rig.gena(MEMBER, TransportState::Transitioning, None));
        assert_eq!(rig.state.to_json()["transportStates"][MEMBER], "Playing");

        sleep_ms(600).await;
        assert!(
            rig.sonos.played().is_empty(),
            "not before a second of STOPPED"
        );
        sleep_ms(600).await;
        let base = format!("http://127.0.0.1:49400/stream/{}/live", rig.stream_id);
        assert_eq!(
            rig.sonos.played(),
            vec![(COORDINATOR.to_string(), format!("{base}/1"))]
        );

        let _next = rig.fetch(1).await;
        assert!(rig.gena(COORDINATOR, TransportState::Playing, Some(&rig.uri(1))));
        assert!(!rig.coordinator.in_handoff(COORDINATOR));
        assert!(!rig.state.is_transport_held(COORDINATOR));
        // The member stays held until it reports PLAYING itself, which is
        // then shown as usual.
        assert!(rig.state.is_transport_held(MEMBER));
        assert!(rig.gena(
            MEMBER,
            TransportState::Playing,
            Some("x-rincon:RINCON_COORD")
        ));
        assert!(!rig.state.is_transport_held(MEMBER));
        assert!(rig.told(MEMBER).is_empty(), "no held state replayed");

        sleep_ms(30_000).await;
        assert_eq!(rig.sonos.played().len(), 1, "no second restart");
        assert!(rig.stop_reasons().is_empty());
    }

    /// B9: a member whose last recorded state is the STOPPED of the segment's
    /// end, and whose own events lag the coordinator's, is not shown that
    /// STOPPED when the coordinator plays the next segment (the extension
    /// would drop it from the cast); its PLAYING, when it comes, is.
    #[tokio::test(start_paused = true)]
    async fn a_lagging_member_is_not_shown_its_stale_stop_after_the_switch() {
        let rig = Rig::new(true);
        rig.play_first_segment(PcmContinuation::Restart).await;
        rig.sonos.stopped_on(&rig.uri(0));
        rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0)));
        rig.gena(
            MEMBER,
            TransportState::Stopped,
            Some("x-rincon:RINCON_COORD"),
        );
        sleep_ms(1_200).await;
        assert_eq!(rig.sonos.played().len(), 1);

        let _next = rig.fetch(1).await;
        rig.gena(
            COORDINATOR,
            TransportState::Transitioning,
            Some(&rig.uri(1)),
        );
        assert!(rig.gena(COORDINATOR, TransportState::Playing, Some(&rig.uri(1))));
        sleep_ms(3_800).await;
        assert!(
            !rig.told(MEMBER).contains(&TransportState::Stopped),
            "the member's stale STOPPED must not be shown: {:?}",
            rig.told(MEMBER)
        );
        assert_eq!(rig.state.to_json()["transportStates"][MEMBER], "Playing");

        assert!(!rig.gena(MEMBER, TransportState::Transitioning, None));
        assert!(rig.gena(
            MEMBER,
            TransportState::Playing,
            Some("x-rincon:RINCON_COORD")
        ));
        sleep_ms(10_000).await;
        assert!(rig.told(MEMBER).is_empty());
        assert!(!rig.state.is_transport_held(MEMBER));
        assert!(rig.stop_reasons().is_empty());
    }

    /// A member that never reports PLAYING after the switch is released
    /// after [`MEMBER_GRACE`], and its recorded STOPPED is shown then.
    #[tokio::test(start_paused = true)]
    async fn a_member_that_never_plays_on_is_shown_its_stop_after_the_grace() {
        let rig = Rig::new(true);
        rig.play_first_segment(PcmContinuation::Restart).await;
        rig.sonos.stopped_on(&rig.uri(0));
        rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0)));
        rig.gena(
            MEMBER,
            TransportState::Stopped,
            Some("x-rincon:RINCON_COORD"),
        );
        sleep_ms(1_200).await;
        let _next = rig.fetch(1).await;
        rig.gena(COORDINATOR, TransportState::Playing, Some(&rig.uri(1)));

        sleep_ms(MEMBER_GRACE.as_millis() as u64 - 500).await;
        assert!(rig.told(MEMBER).is_empty());
        sleep_ms(1_000).await;
        assert_eq!(rig.told(MEMBER), vec![TransportState::Stopped]);
        assert!(!rig.state.is_transport_held(MEMBER));
    }

    /// With no STOPPED from GENA, a STOPPED found by asking must last
    /// [`STOP_CONFIRM`] and be confirmed again before the restart, as one
    /// GENA reports must.
    #[tokio::test(start_paused = true)]
    async fn a_stop_found_by_asking_must_last_before_the_restart() {
        let rig = Rig::new(false);
        rig.play_first_segment(PcmContinuation::Restart).await;
        rig.sonos.stopped_on(&rig.uri(0));
        sleep_ms(10_000).await;
        let polled = rig.sonos.polled_at.lock().clone();
        let played = rig.sonos.played_at.lock().clone();
        assert_eq!(played.len(), 1);
        assert!(polled.len() >= 2, "confirmed twice: {polled:?}");
        assert!(played[0] - polled[0] >= STOP_CONFIRM);
    }

    /// A speaker stopped with no media at all (a cleared queue) has nothing
    /// of ours to continue: it is not restarted, and its STOPPED is shown.
    #[tokio::test(start_paused = true)]
    async fn a_speaker_stopped_with_no_media_is_not_restarted() {
        let rig = Rig::new(false);
        rig.play_first_segment(PcmContinuation::Restart).await;
        rig.sonos.stopped_on("");
        assert!(!rig.gena(COORDINATOR, TransportState::Stopped, None));
        sleep_ms(5_000).await;
        assert!(rig.sonos.played().is_empty());
        assert!(!rig.coordinator.in_handoff(COORDINATOR));
        assert_eq!(rig.told(COORDINATOR), vec![TransportState::Stopped]);
    }

    /// Nothing is restarted while the speaker is still playing the end of
    /// the segment (GENA silent, polls say PLAYING), after a STOPPED blip,
    /// or once it has fetched the next segment itself: a restart then would
    /// throw away audio it holds.
    #[tokio::test(start_paused = true)]
    async fn no_restart_while_the_speaker_plays_on_or_has_fetched_by_itself() {
        let rig = Rig::new(false);
        rig.play_first_segment(PcmContinuation::Restart).await;

        // GENA silent: the timer asks, the speaker says PLAYING, again and
        // again.
        sleep_ms(5_000).await;
        assert!(rig.sonos.played().is_empty());

        // A STOPPED that does not last.
        rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0)));
        sleep_ms(400).await;
        rig.gena(COORDINATOR, TransportState::Playing, Some(&rig.uri(0)));
        sleep_ms(2_000).await;
        assert!(rig.sonos.played().is_empty());

        // The speaker fetches segment 1 by itself, then stops on segment 0
        // as it switches.
        let _next = rig.fetch(1).await;
        rig.sonos.stopped_on(&rig.uri(0));
        rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0)));
        sleep_ms(5_000).await;
        assert!(
            rig.sonos.played().is_empty(),
            "the fetch cancels the restart"
        );
        rig.gena(COORDINATOR, TransportState::Playing, Some(&rig.uri(1)));
        assert!(!rig.coordinator.in_handoff(COORDINATOR));
    }

    /// A paused speaker is left alone: no restart until it has played the
    /// segment out after all.
    #[tokio::test(start_paused = true)]
    async fn a_speaker_paused_at_the_end_of_a_segment_is_not_restarted() {
        let rig = Rig::new(false);
        rig.play_first_segment(PcmContinuation::Restart).await;
        assert!(rig.gena(COORDINATOR, TransportState::Paused, Some(&rig.uri(0))));
        *rig.sonos.transport.lock() = Some(TransportState::Paused);
        sleep_ms(20_000).await;
        assert!(rig.sonos.played().is_empty());

        rig.gena(COORDINATOR, TransportState::Playing, Some(&rig.uri(0)));
        rig.sonos.stopped_on(&rig.uri(0));
        rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0)));
        sleep_ms(1_500).await;
        assert_eq!(rig.sonos.played().len(), 1);
    }

    /// A speaker that will not play the next segment is told once more, and
    /// then the cast ends on it with its own reason, which the extension
    /// shows gently.
    #[tokio::test(start_paused = true)]
    async fn a_speaker_that_will_not_continue_ends_the_cast_with_its_own_reason() {
        let rig = Rig::new(false);
        rig.play_first_segment(PcmContinuation::Restart).await;
        rig.sonos.stopped_on(&rig.uri(0));
        rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0)));
        sleep_ms(1_200).await;
        assert_eq!(rig.sonos.played().len(), 1);
        sleep_ms(10_000).await;
        assert_eq!(rig.sonos.played().len(), 2, "told once more");
        assert!(rig.stop_reasons().is_empty());
        sleep_ms(10_000).await;
        assert_eq!(
            rig.stop_reasons(),
            vec![(
                COORDINATOR.to_string(),
                Some(SpeakerRemovalReason::ContinuationFailed)
            )]
        );
        assert!(!rig.state.is_transport_held(COORDINATOR));
        assert_eq!(rig.sonos.played().len(), 2);
    }

    /// With continuation off, a segment's end moves nobody and holds back
    /// nothing: the cast ends there, as it always did.
    #[tokio::test(start_paused = true)]
    async fn with_continuation_off_nothing_is_held_or_restarted() {
        let rig = Rig::new(true);
        rig.play_first_segment(PcmContinuation::Off).await;
        assert!(!rig.coordinator.in_handoff(COORDINATOR));
        rig.sonos.stopped_on(&rig.uri(0));
        assert!(rig.gena(COORDINATOR, TransportState::Stopped, Some(&rig.uri(0))));
        sleep_ms(5_000).await;
        assert!(rig.sonos.played().is_empty());
    }

    /// A foreign source during a handoff is not the switch: the coordinator
    /// is not restarted onto our stream.
    #[tokio::test(start_paused = true)]
    async fn a_speaker_taken_by_another_source_is_not_restarted() {
        let rig = Rig::new(false);
        rig.play_first_segment(PcmContinuation::Restart).await;
        let tv = "x-sonos-htastream:RINCON_COORD01400:spdif";
        rig.sonos.stopped_on(tv);
        rig.gena(COORDINATOR, TransportState::Stopped, Some(tv));
        sleep_ms(5_000).await;
        assert!(rig.sonos.played().is_empty());
    }
}
