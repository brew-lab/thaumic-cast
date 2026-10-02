//! The session's audio clock drift correction: stepping the controller with
//! each report's estimate and handing its rate command to the connection.

use std::net::IpAddr;
use std::time::Instant;

use crate::services::speaker_monitor::session::{SpeakerSession, BACKOFF_AFTER_FAILURES};
use crate::services::speaker_monitor::ControlInput;
use crate::stream::ConnectionTap;

impl SpeakerSession {
    /// Steps the drift controller with this report's estimate and hands the
    /// connection's adapter the command at once, rather than at the next
    /// monitor tick.
    pub(super) fn step_drift(
        &mut self,
        tap: &ConnectionTap,
        now: Instant,
        estimate: Option<crate::services::speaker_monitor::ReserveEstimate>,
    ) {
        // A forced rate drives the reserve for a listening test: the
        // controller would learn from a level it is not steering and wind its
        // integral up towards the cap, then hand that to the next connection.
        if tap.rate_control().is_some_and(|c| c.forced_ppm().is_some()) {
            return;
        }
        let stale = self.consecutive_failures >= BACKOFF_AFTER_FAILURES || self.is_stale();
        self.drift.update(&ControlInput {
            now_s: now
                .saturating_duration_since(self.drift_origin)
                .as_secs_f64(),
            estimate,
            target_ms: self.tracker.target_ms(),
            head_start_ms: self.tracker.head_start().map(|h| h.sent_ms),
            clock: self.tracker.clock(),
            stale,
            settling: self.tracker.control_hold(),
            carry: self.tracker.carry(),
        });
        self.refresh_rate_command(tap);
    }

    /// The rate correction in force on `tap`'s audio, in ppm: the rate
    /// `THAUMIC_DRIFT_FORCE_PPM` fixed its adapter at for a listening test,
    /// else what the controller applies. The reserve's net drain follows the
    /// audio actually sent, so a forced rate counts even with the mode off,
    /// and nothing counts once the net-insertion guard has pinned the
    /// adapter at 0 ppm.
    pub(super) fn command_in_force(&self, tap: &ConnectionTap) -> f64 {
        match tap.rate_control() {
            Some(c) if c.is_pinned() => 0.0,
            Some(c) => c.forced_ppm().unwrap_or_else(|| self.drift.applied_ppm()),
            None => self.drift.applied_ppm(),
        }
    }

    /// Writes the drift command into the connection's rate control, if its
    /// audio is corrected. Called on every monitor tick as well as each
    /// report, so the cadence's watchdog only lapses the command if the
    /// monitor has stopped.
    pub(crate) fn refresh_rate_command(&self, tap: &ConnectionTap) {
        if let Some(control) = tap.rate_control() {
            control.set_ppm(self.drift.applied_ppm());
        }
    }
}

/// How close to its target a reserve must come back for the latency a PCM
/// restart added to count as repaid, in ms.
const DEBT_REPAID_MS: f64 = 50.0;

/// Logs, once, that the latency a PCM restart added (see
/// [`crate::stream::Rejoin`]) has been paid back: the locked reserve is
/// back within [`DEBT_REPAID_MS`] of the target the connection settled at
/// before the restart.
pub(super) fn note_debt_repaid(
    stream_id: &str,
    speaker_ip: IpAddr,
    tap: &ConnectionTap,
    estimate: Option<crate::services::speaker_monitor::ReserveEstimate>,
    target_ms: Option<f64>,
) {
    let Some(debt) = tap.stats().playout.debt() else {
        return;
    };
    let (Some(est), Some(target)) = (estimate.filter(|e| e.locked()), target_ms) else {
        return;
    };
    if est.reserve_ms - target < DEBT_REPAID_MS {
        tap.stats().playout.clear_debt();
        log::info!(
            "[Stream] Continuation debt repaid: stream={} speaker={} seg={} debt_ms={} \
             after_s={}",
            stream_id,
            speaker_ip,
            debt.seg,
            debt.debt_ms,
            debt.since.elapsed().as_secs()
        );
    }
}
