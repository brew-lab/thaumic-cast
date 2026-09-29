//! Whether a monitored speaker is playing, from evidence that can be trusted.
//!
//! A position poll only says something about the speaker's reserve while the
//! speaker is playing; a paused speaker's RelTime stands still while the
//! clock runs on. GENA reports the transport state, but not always reliably:
//! Sonos only notifies on change, and a subscription whose callback address
//! has become unreachable (a VPN coming up, issue 112) still renews
//! successfully, so its last state can be hours old and wrong. The gate
//! therefore trusts GENA only for a state it has heard since it started
//! watching, and otherwise falls back to what the polls themselves show:
//! RelTime moving on is proof of playing, and a `GetTransportInfo` every
//! [`TRANSPORT_POLL_INTERVAL`] answers the rest.
//!
//! A poll is discarded only when the speaker is positively known not to be
//! playing. Not knowing is not a reason to throw a measurement away.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::sonos::gena::GenaSubscriptionManager;
use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;
use crate::state::SonosState;

/// How long after it starts watching a speaker the gate waits before judging
/// GENA. The notification for a cast's own start (TRANSITIONING, then
/// PLAYING) can land a moment after the speaker's first fetch, so judging at
/// once would call every healthy subscription stale.
pub const GENA_GRACE: Duration = Duration::from_secs(10);

/// A GENA state heard this long before the gate started watching still
/// counts as heard since: the cast's own start notification can arrive just
/// before the speaker's first fetch registers it.
pub const GENA_FRESH_SLACK: Duration = Duration::from_secs(10);

/// How often the transport state is polled while GENA cannot be vouched for.
pub const TRANSPORT_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// How long a polled transport state is believed. Longer than the poll
/// interval, so an answer that arrives late does not leave a gap.
pub const POLLED_STATE_VALID_FOR: Duration = Duration::from_secs(45);

/// Span of polls over which RelTime must advance to prove the speaker is
/// playing. RelTime has whole-second resolution, so over two seconds of
/// playing it always moves on by at least one second.
pub const RELTIME_ADVANCE_SPAN: Duration = Duration::from_secs(2);

/// How far RelTime must move on across [`RELTIME_ADVANCE_SPAN`] to count.
pub const RELTIME_ADVANCE_MIN_MS: u64 = 1000;

/// How long proof of playing from RelTime is believed without fresh proof.
pub const RELTIME_EVIDENCE_VALID_FOR: Duration = Duration::from_secs(10);

/// RelTime going back by more than this is a restart, not jitter.
const RELTIME_BACKWARDS_TOLERANCE_MS: u64 = 100;

/// What GENA last said about a speaker's transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenaTransport {
    /// The last transport state notified.
    pub state: TransportState,
    /// When that notification arrived.
    pub received_at: Instant,
    /// Whether an AVTransport subscription for the speaker is currently held.
    pub subscribed: bool,
}

/// Read access to GENA's view of transport state, so the monitor can be
/// tested without a subscription manager.
pub trait TransportStateView: Send + Sync {
    /// What GENA last said about `speaker_ip`'s transport, if anything.
    fn gena_transport(&self, speaker_ip: &str) -> Option<GenaTransport>;

    /// The RINCON UUID of the speaker at `speaker_ip`, where the topology
    /// knows it. What drift correction learns about a speaker is kept under
    /// it, so a DHCP-reassigned address never inherits another speaker's
    /// correction.
    fn speaker_uuid(&self, _speaker_ip: &str) -> Option<String> {
        None
    }
}

/// [`TransportStateView`] over the live GENA state.
pub struct GenaTransportView {
    sonos_state: Arc<SonosState>,
    gena: Arc<GenaSubscriptionManager>,
}

impl GenaTransportView {
    /// Reads transport states from `sonos_state`, and subscription status
    /// from `gena`.
    pub fn new(sonos_state: Arc<SonosState>, gena: Arc<GenaSubscriptionManager>) -> Self {
        Self { sonos_state, gena }
    }
}

impl TransportStateView for GenaTransportView {
    fn gena_transport(&self, speaker_ip: &str) -> Option<GenaTransport> {
        let state = *self.sonos_state.transport_states.get(speaker_ip)?;
        let received_at = *self.sonos_state.transport_state_received.get(speaker_ip)?;
        Some(GenaTransport {
            state,
            received_at,
            subscribed: self
                .gena
                .is_subscribed(speaker_ip, SonosService::AVTransport),
        })
    }

    fn speaker_uuid(&self, speaker_ip: &str) -> Option<String> {
        self.sonos_state.get_member_uuid_by_ip(speaker_ip)
    }
}

/// What the gate concluded about the speaker's transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportVerdict {
    /// Known to be playing.
    Playing,
    /// Known not to be playing, in this state.
    NotPlaying(TransportState),
    /// Nothing trustworthy either way.
    Unknown,
}

/// Where a verdict came from, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportSource {
    /// RelTime moved on across recent polls.
    RelTime,
    /// A GENA notification heard since watching began.
    Gena,
    /// A recent `GetTransportInfo`.
    Polled,
    /// No trustworthy source.
    None,
}

impl std::fmt::Display for TransportSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::RelTime => "reltime",
            Self::Gena => "gena",
            Self::Polled => "polled",
            Self::None => "unknown",
        })
    }
}

/// Per-speaker transport judgement for the monitor.
#[derive(Debug, Clone)]
pub struct TransportGate {
    /// When the monitor started watching this speaker.
    watching_since: Instant,
    /// The RelTime reading RelTime progress is measured from.
    advance_anchor: Option<(u64, Instant)>,
    /// Whether RelTime last moved on across a full span, and when that was judged.
    advancing: Option<(bool, Instant)>,
    /// The last polled transport state and when it was answered.
    polled: Option<(TransportState, Instant)>,
    /// When a transport poll was last asked for, answered or not.
    last_transport_poll: Option<Instant>,
    /// Whether GENA has been reported stale for this speaker.
    stale_reported: bool,
}

impl TransportGate {
    /// A gate that starts watching at `now`.
    pub fn new(now: Instant) -> Self {
        Self {
            watching_since: now,
            advance_anchor: None,
            advancing: None,
            polled: None,
            last_transport_poll: None,
            stale_reported: false,
        }
    }

    /// Whether GENA is judged yet: not until [`GENA_GRACE`] after watching began.
    fn judging_gena(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.watching_since) >= GENA_GRACE
    }

    /// Whether `gena` holds a state heard since watching began, on a
    /// subscription that is still held.
    pub fn gena_is_fresh(&self, gena: Option<&GenaTransport>) -> bool {
        gena.is_some_and(|g| {
            g.subscribed && g.received_at + GENA_FRESH_SLACK >= self.watching_since
        })
    }

    /// Feeds a RelTime reading answered at `at`.
    pub fn observe_rel_time(&mut self, rel_ms: u64, at: Instant) {
        let Some((anchor_ms, anchor_at)) = self.advance_anchor else {
            self.advance_anchor = Some((rel_ms, at));
            return;
        };
        if rel_ms + RELTIME_BACKWARDS_TOLERANCE_MS < anchor_ms {
            // A restart: progress is measured afresh from here.
            self.advance_anchor = Some((rel_ms, at));
            self.advancing = None;
            return;
        }
        if at.saturating_duration_since(anchor_at) >= RELTIME_ADVANCE_SPAN {
            let moved_on = rel_ms.saturating_sub(anchor_ms) >= RELTIME_ADVANCE_MIN_MS;
            self.advancing = Some((moved_on, at));
            self.advance_anchor = Some((rel_ms, at));
        }
    }

    /// Feeds a polled transport state answered at `at`.
    pub fn observe_polled(&mut self, state: TransportState, at: Instant) {
        self.polled = Some((state, at));
    }

    /// Whether the next position poll should also ask for the transport
    /// state: GENA is being judged, cannot be vouched for, and the last
    /// transport poll was at least [`TRANSPORT_POLL_INTERVAL`] ago. Asking
    /// counts as a poll whether or not it is answered.
    pub fn take_transport_poll(&mut self, gena: Option<&GenaTransport>, now: Instant) -> bool {
        if !self.judging_gena(now) || self.gena_is_fresh(gena) {
            return false;
        }
        let due = self.last_transport_poll.map_or(true, |at| {
            now.saturating_duration_since(at) >= TRANSPORT_POLL_INTERVAL
        });
        if due {
            self.last_transport_poll = Some(now);
        }
        due
    }

    /// Returns `true` the first time GENA is found stale for this speaker,
    /// so the caller can say so once.
    pub fn take_stale_notice(&mut self, gena: Option<&GenaTransport>, now: Instant) -> bool {
        if self.stale_reported || !self.judging_gena(now) || self.gena_is_fresh(gena) {
            return false;
        }
        self.stale_reported = true;
        true
    }

    /// The speaker's transport as best it can be known at `now`.
    ///
    /// RelTime moving on wins over everything, since it is the speaker
    /// playing; then a fresh GENA state; then a recent polled state.
    pub fn verdict(
        &self,
        gena: Option<&GenaTransport>,
        now: Instant,
    ) -> (TransportVerdict, TransportSource) {
        if let Some((true, at)) = self.advancing {
            if now.saturating_duration_since(at) <= RELTIME_EVIDENCE_VALID_FOR {
                return (TransportVerdict::Playing, TransportSource::RelTime);
            }
        }
        if self.judging_gena(now) && self.gena_is_fresh(gena) {
            if let Some(g) = gena {
                return (Self::from_state(g.state), TransportSource::Gena);
            }
        }
        if let Some((state, at)) = self.polled {
            if now.saturating_duration_since(at) <= POLLED_STATE_VALID_FOR {
                return (Self::from_state(state), TransportSource::Polled);
            }
        }
        (TransportVerdict::Unknown, TransportSource::None)
    }

    fn from_state(state: TransportState) -> TransportVerdict {
        match state {
            TransportState::Playing => TransportVerdict::Playing,
            other => TransportVerdict::NotPlaying(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn gena(state: TransportState, received_at: Instant) -> GenaTransport {
        GenaTransport {
            state,
            received_at,
            subscribed: true,
        }
    }

    #[test]
    fn transport_gate_uses_polled_state_when_gena_is_stale() {
        let t0 = Instant::now() + secs(3600);
        let mut gate = TransportGate::new(t0);
        // PLAYING heard an hour before this speaker was watched: the callback
        // may have died since, so it proves nothing.
        let stale = gena(TransportState::Playing, t0 - secs(3600));
        let now = t0 + GENA_GRACE;

        assert!(!gate.gena_is_fresh(Some(&stale)));
        assert!(gate.take_transport_poll(Some(&stale), now));
        assert!(
            !gate.take_transport_poll(Some(&stale), now + secs(1)),
            "one transport poll per interval"
        );
        assert!(gate.take_transport_poll(Some(&stale), now + TRANSPORT_POLL_INTERVAL));

        gate.observe_polled(TransportState::Paused, now);
        assert_eq!(
            gate.verdict(Some(&stale), now + secs(1)),
            (
                TransportVerdict::NotPlaying(TransportState::Paused),
                TransportSource::Polled
            )
        );
        assert_eq!(
            gate.verdict(Some(&stale), now + POLLED_STATE_VALID_FOR + secs(1))
                .0,
            TransportVerdict::Unknown,
            "an old polled answer is not believed either"
        );
    }

    #[test]
    fn a_state_heard_since_watching_began_is_trusted_and_not_polled() {
        let t0 = Instant::now();
        let mut gate = TransportGate::new(t0);
        let fresh = gena(TransportState::Paused, t0 + secs(1));
        let now = t0 + GENA_GRACE;
        assert!(!gate.take_transport_poll(Some(&fresh), now));
        assert!(!gate.take_stale_notice(Some(&fresh), now));
        assert_eq!(
            gate.verdict(Some(&fresh), now),
            (
                TransportVerdict::NotPlaying(TransportState::Paused),
                TransportSource::Gena
            )
        );

        let unsubscribed = GenaTransport {
            subscribed: false,
            ..fresh
        };
        assert!(
            !gate.gena_is_fresh(Some(&unsubscribed)),
            "a dropped subscription can no longer vouch for its state"
        );
    }

    #[test]
    fn gena_is_not_judged_during_the_grace_period() {
        let t0 = Instant::now();
        let mut gate = TransportGate::new(t0);
        let early = t0 + GENA_GRACE - secs(1);
        assert!(!gate.take_transport_poll(None, early));
        assert!(!gate.take_stale_notice(None, early));
        assert!(gate.take_stale_notice(None, t0 + GENA_GRACE));
        assert!(
            !gate.take_stale_notice(None, t0 + GENA_GRACE + secs(60)),
            "said once per speaker"
        );
    }

    #[test]
    fn advancing_reltime_counts_as_playing() {
        let t0 = Instant::now();
        let mut gate = TransportGate::new(t0);
        // GENA says STOPPED, freshly: RelTime moving on still wins.
        let stopped = gena(TransportState::Stopped, t0 + secs(1));
        gate.observe_rel_time(10_000, t0 + secs(20));
        gate.observe_rel_time(11_000, t0 + secs(21));
        assert_ne!(
            gate.verdict(Some(&stopped), t0 + secs(21)).1,
            TransportSource::RelTime,
            "one second is not a full span"
        );
        gate.observe_rel_time(12_000, t0 + secs(22));
        assert_eq!(
            gate.verdict(Some(&stopped), t0 + secs(22)),
            (TransportVerdict::Playing, TransportSource::RelTime)
        );
        assert_eq!(
            gate.verdict(
                Some(&stopped),
                t0 + secs(22) + RELTIME_EVIDENCE_VALID_FOR + secs(1)
            )
            .1,
            TransportSource::Gena,
            "old proof of playing lapses"
        );
    }

    #[test]
    fn standing_reltime_is_not_proof_of_playing() {
        let t0 = Instant::now();
        let mut gate = TransportGate::new(t0);
        gate.observe_rel_time(10_000, t0);
        gate.observe_rel_time(10_000, t0 + secs(3));
        assert_eq!(
            gate.verdict(None, t0 + secs(3)).0,
            TransportVerdict::Unknown
        );
    }

    #[test]
    fn reltime_going_back_restarts_the_measurement() {
        let t0 = Instant::now();
        let mut gate = TransportGate::new(t0);
        gate.observe_rel_time(60_000, t0);
        gate.observe_rel_time(62_000, t0 + secs(2));
        assert_eq!(
            gate.verdict(None, t0 + secs(2)).0,
            TransportVerdict::Playing
        );
        gate.observe_rel_time(0, t0 + secs(3));
        assert_eq!(
            gate.verdict(None, t0 + secs(3)).0,
            TransportVerdict::Unknown,
            "a restart clears the old proof"
        );
    }
}
