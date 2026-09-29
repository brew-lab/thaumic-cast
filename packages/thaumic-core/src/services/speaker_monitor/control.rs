//! Clock drift correction: how much audio to insert into (or remove from) a
//! speaker's stream to hold its reserve level.
//!
//! No two clocks agree exactly. A speaker that plays 20 ppm faster than we
//! deliver uses up its reserve at 1.2 ms a minute, and a live source cannot
//! run ahead of real time to make it up, so over a long cast the speaker head
//! start drains away. [`DriftController`] measures that from the speaker
//! monitor's 30 s reserve estimates and commands the connection's
//! [`RateAdapter`](crate::stream::RateAdapter) to stretch the audio by the
//! same few ppm, which the speaker then plays too.
//!
//! The loop is a PI controller on the reserve, held at the level each
//! connection settled at once its head start had gone out (the tracker's
//! target):
//!
//! ```text
//! e  = target − reserve
//! db = max(40, half_width)
//! P  = 0.5·clamp(e, ±db) + 0.833·sign(e)·max(0, |e| − db)
//! I += 0.0069·e per estimate, tight estimates only, not while u is pinned
//!      at the cap in the sign of e
//! u  = clamp(I + P, ±150) ppm, moving at most 10 ppm per estimate
//! ```
//!
//! The deadband follows the estimate's own uncertainty, so noise inside it
//! never meets the full proportional gain; inside it a gentler damping term
//! (see [`DAMPING_PPM_PER_MS`]) keeps the integral from swinging for ever
//! around its 3.6 h period. The integral
//! is the speaker's clock rate as the loop has learned it: it belongs to the
//! speaker, not the connection, and is kept across reconnects and casts (see
//! [`SpeakerControlState`]). A speaker the loop has learned nothing about
//! yet (its connection has no target, or a distrusted one) has it seeded
//! from the clock fit once that is precise. While the estimate is unlocked the command holds at the integral
//! with no proportional term, and only after 30 min unlocked, or 10 min with
//! the speaker not answering, does it ramp to 0.
//!
//! In [`DriftMode::Observe`] the controller runs exactly the same way but its
//! command is never applied: the reserve it steers by is the measured one
//! plus the audio its commands would have added, so the logged `would_cmd`
//! is what `on` would have commanded, and the output stays byte for byte
//! what it would be with correction off.

use std::collections::VecDeque;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::clock_fit::ClockEstimate;
use super::reserve::ReserveEstimate;
use crate::stream::RateControl;

/// Environment variable that overrides the drift correction setting: `on`,
/// `observe` or `off`.
pub const DRIFT_COMPENSATION_ENV: &str = "THAUMIC_DRIFT_COMPENSATION";

/// Environment variable that, for blind listening tests only, fixes every
/// monitored PCM connection's rate adapter at a number of ppm, whatever
/// the drift mode and the controller say. Read per connection.
pub const DRIFT_FORCE_PPM_ENV: &str = "THAUMIC_DRIFT_FORCE_PPM";

/// Largest command the controller gives, in ppm either way. At 150 ppm a
/// sample is added or dropped in every 6 667, spread across all of them,
/// far too little to hear; the adapter itself accepts twice as much.
pub const MAX_COMMAND_PPM: f64 = 150.0;

/// Most the command moves per estimate, in ppm.
pub const MAX_SLEW_PPM: f64 = 10.0;

/// Proportional gain, ppm per ms of error beyond the deadband (τ ≈ 20 min).
pub const PROPORTIONAL_PPM_PER_MS: f64 = 0.833;

/// Integral gain, ppm per ms of error per estimate (τᵢ ≈ 60 min).
pub const INTEGRAL_PPM_PER_MS: f64 = 0.0069;

/// Least deadband, in ms: the error the full proportional term ignores is
/// the larger of this and the estimate's half-width.
pub const DEADBAND_FLOOR_MS: f64 = 40.0;

/// Damping gain inside the deadband, ppm per ms of error.
///
/// With the proportional term shut out of the deadband, the loop inside it
/// would be pure integral, an undamped swing with a 3.6 h period whose
/// amplitude is whatever error it started from (the target is the mean of
/// two estimates, easily 40 ms out, and a fresh speaker drains another 40 ms
/// before the integral catches up): in simulation about ±55 ms of the true
/// reserve, for good. This term, `2ζ·√(Kᵢ/a)` for ζ ≈ 0.5, damps that
/// swing within a few hours. Estimate noise moves the command a few ppm
/// from one estimate to the next through it, which the reserve integrates
/// to nothing and nobody can hear.
pub const DAMPING_PPM_PER_MS: f64 = 0.5;

/// Standard error, in ppm, below which the clock fit seeds the integral of
/// a speaker the controller has not learned yet.
pub const SEED_MAX_SE_PPM: f64 = 10.0;

/// How long the estimate may stay unlocked before the command ramps to 0.
pub const RAMP_AFTER_UNLOCKED: Duration = Duration::from_secs(30 * 60);

/// How long the speaker may go unanswering before the command ramps to 0.
pub const RAMP_AFTER_STALE: Duration = Duration::from_secs(10 * 60);

/// How long the command must stay at the cap before correction counts as
/// saturated, and away from it before it no longer does.
pub const SATURATION_AFTER: Duration = Duration::from_secs(5 * 60);

/// How far, in ms, a connection's settled level may sit from where the
/// speaker's past connections settled (relative to the head start sent)
/// before the controller distrusts it and holds the integral only.
pub const CALIB_OUTLIER_MS: f64 = 150.0;

/// Where a speaker with no past connection is expected to settle relative
/// to its head start, in ms: its own share of the reserve is not counted
/// as delivered.
pub const FIRST_CONNECTION_BIAS_MS: f64 = -50.0;

/// The outlier test on a speaker's first connection, looser than
/// [`CALIB_OUTLIER_MS`] since its bias is a guess.
pub const FIRST_CONNECTION_OUTLIER_MS: f64 = 200.0;

/// Past connections whose settled level is remembered per speaker.
const CALIB_HISTORY: usize = 16;

/// A command this close to the cap counts as at it.
const CAP_EPSILON_PPM: f64 = 1e-6;

/// Clock drift correction for PCM streams.
///
/// Read once per connection, so a change never engages or releases an
/// adapter mid-connection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriftMode {
    /// Nothing measured for correction, nothing corrected.
    Off,
    /// The controller runs and logs what it would command; the audio is
    /// left exactly as captured.
    #[default]
    Observe,
    /// Every PCM connection's audio is stretched or squeezed to hold its
    /// speaker's reserve level.
    On,
}

impl DriftMode {
    /// The mode as its config and wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Observe => "observe",
            Self::On => "on",
        }
    }

    /// Parses `on`, `observe` or `off` (any case, surrounding space
    /// ignored), or `None` if it is none of them.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "on" => Some(Self::On),
            "observe" => Some(Self::Observe),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

impl std::fmt::Display for DriftMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The mode [`DRIFT_COMPENSATION_ENV`] forces the setting to, if it is set
/// to something recognisable. An unrecognisable value is ignored, with a
/// warning the first time it is seen.
pub fn drift_compensation_env_override() -> Option<DriftMode> {
    static WARNED: std::sync::Once = std::sync::Once::new();
    let raw = std::env::var(DRIFT_COMPENSATION_ENV).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let parsed = DriftMode::parse(&raw);
    if parsed.is_none() {
        WARNED.call_once(|| {
            log::warn!(
                "[DriftControl] Ignoring {}={:?}: expected on, observe or off",
                DRIFT_COMPENSATION_ENV,
                raw
            );
        });
    }
    parsed
}

/// Reads a [`DRIFT_FORCE_PPM_ENV`] value: `Ok(None)` when it is empty,
/// the ppm when it is a finite number within the adapter's
/// ±[`crate::stream::rate_adapter::MAX_RATE_PPM`], and why not otherwise.
pub fn parse_drift_force_ppm(raw: &str) -> Result<Option<f64>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let max = crate::stream::rate_adapter::MAX_RATE_PPM;
    match raw.parse::<f64>() {
        Ok(ppm) if ppm.is_finite() && ppm.abs() <= max => Ok(Some(ppm)),
        Ok(_) => Err(format!(
            "expected a number of ppm from -{max:.0} to {max:.0}"
        )),
        Err(_) => Err("expected a number of ppm".to_string()),
    }
}

/// The rate [`DRIFT_FORCE_PPM_ENV`] fixes a new connection's adapter at,
/// if it is set to a usable value; read afresh for each connection. A
/// value that is not is ignored with a warning (once per distinct value, not
/// on every connection), and the connection gets the drift correction it
/// would have had.
pub fn drift_force_ppm() -> Option<f64> {
    drift_force_ppm_from(std::env::var(DRIFT_FORCE_PPM_ENV).ok().as_deref())
}

/// [`drift_force_ppm`] for a given raw value (`None` when unset).
pub fn drift_force_ppm_from(raw: Option<&str>) -> Option<f64> {
    match parse_drift_force_ppm(raw?) {
        Ok(ppm) => ppm,
        Err(why) => {
            let raw = raw.unwrap_or_default();
            static WARNED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
            if first_warning_for(&WARNED, raw) {
                log::warn!(
                    "[Drift] Ignoring {}={:?}: {}",
                    DRIFT_FORCE_PPM_ENV,
                    raw,
                    why
                );
            }
            None
        }
    }
}

/// Whether `raw` differs from the last unusable value warned about, as kept
/// in `warned`, noting it as that value if so.
fn first_warning_for(warned: &std::sync::Mutex<Option<String>>, raw: &str) -> bool {
    let mut warned = warned
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if warned.as_deref() == Some(raw) {
        return false;
    }
    *warned = Some(raw.to_string());
    true
}

/// The drift correction mode a new connection runs under, given the
/// configured setting and whether speaker monitoring is on for it.
///
/// [`DRIFT_COMPENSATION_ENV`] overrides `configured` when set. Correction
/// steers by the speaker monitor's estimates, so with monitoring off it is
/// off whatever the setting says. Read once per connection.
pub fn drift_compensation_mode(configured: DriftMode, monitor: bool) -> DriftMode {
    resolve_drift_mode(configured, drift_compensation_env_override(), monitor)
}

/// [`drift_compensation_mode`] without the environment.
pub fn resolve_drift_mode(
    configured: DriftMode,
    env_override: Option<DriftMode>,
    monitor: bool,
) -> DriftMode {
    if monitor {
        env_override.unwrap_or(configured)
    } else {
        DriftMode::Off
    }
}

/// Whether drift correction is actually running on a connection: made
/// under [`DriftMode::On`], with an adapter built that follows `control`,
/// not pinned by the net-insertion guard and not lapsed by the watchdog.
/// A notice about drift is about what correction cannot make up only then.
pub fn drift_active(mode: DriftMode, control: Option<&RateControl>) -> bool {
    mode == DriftMode::On && control.is_some_and(RateControl::is_following)
}

/// What the controller keeps about one speaker across its connections and
/// casts, keyed by its RINCON UUID where the topology knows it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpeakerControlState {
    /// The integral term: the speaker's clock rate as the loop has learned
    /// it, in ppm.
    pub integral_ppm: f64,
    /// Whether the integral has been seeded from a precise clock fit, or
    /// taught by the loop itself; either way it is not seeded (again), so
    /// what the loop learns stands. A clock fit can read tens of ppm off
    /// long after its standard error says otherwise, while the integral
    /// only moves on tight estimates of the reserve itself.
    pub seeded: bool,
    /// Where each past connection settled relative to the head start it
    /// was sent (`target − H`), newest last.
    pub calibs_ms: VecDeque<f64>,
}

impl SpeakerControlState {
    /// The median of the past connections' `target − H`, if any.
    pub fn bias_ms(&self) -> Option<f64> {
        if self.calibs_ms.is_empty() {
            return None;
        }
        let mut sorted: Vec<f64> = self.calibs_ms.iter().copied().collect();
        sorted.sort_unstable_by(f64::total_cmp);
        let n = sorted.len();
        Some(if n % 2 == 1 {
            sorted[n / 2]
        } else {
            (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
        })
    }

    /// Remembers where a connection settled.
    fn push_calib(&mut self, calib_ms: f64) {
        if self.calibs_ms.len() >= CALIB_HISTORY {
            self.calibs_ms.pop_front();
        }
        self.calibs_ms.push_back(calib_ms);
    }
}

/// What one report hands the controller.
#[derive(Debug, Clone, Copy, Default)]
pub struct ControlInput {
    /// Seconds on a clock that runs on across the speaker's connections.
    pub now_s: f64,
    /// This report's reserve estimate, if it made one. `None` after a
    /// segment break, while paused, or before enough polls.
    pub estimate: Option<ReserveEstimate>,
    /// The level the current connection settled at, once learned.
    pub target_ms: Option<f64>,
    /// The head start the current connection was sent, in ms.
    pub head_start_ms: Option<u32>,
    /// The speaker's clock rate.
    pub clock: Option<ClockEstimate>,
    /// Whether the speaker has stopped answering.
    pub stale: bool,
}

/// Why the controller is doing what it does, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlHold {
    /// Steering on a locked estimate against the connection's target.
    Steering,
    /// No target yet on this connection: holding the integral.
    NoTarget,
    /// The connection settled too far from where the speaker usually does:
    /// holding the integral.
    CalibOutlier,
    /// The estimate is not locked: holding the integral.
    Unlocked,
    /// Unlocked or unanswered for too long: ramping to 0.
    Ramping,
}

impl ControlHold {
    /// The reason as a log token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steering => "steer",
            Self::NoTarget => "no_target",
            Self::CalibOutlier => "calib_outlier",
            Self::Unlocked => "hold",
            Self::Ramping => "ramp",
        }
    }
}

/// The PI controller for one speaker (see the module docs).
#[derive(Debug, Clone)]
pub struct DriftController {
    /// The mode the current connection was made under.
    mode: DriftMode,
    /// Whether the current connection has an adapter to command.
    has_adapter: bool,
    /// What persists across connections.
    state: SpeakerControlState,
    /// The command, applied or (observing) not, in ppm.
    command_ppm: f64,
    /// The proportional term of the latest update.
    proportional_ppm: f64,
    /// The current connection's target, once adopted.
    target_ms: Option<f64>,
    /// Whether the current connection's target is an outlier.
    calib_outlier: bool,
    /// Audio the observed commands would have inserted on this connection,
    /// in ms (observe only).
    virtual_inserted_ms: f64,
    /// When the controller last updated.
    last_update_s: Option<f64>,
    /// Since when the estimate has not been locked.
    unlocked_since: Option<f64>,
    /// Since when the speaker has not answered.
    stale_since: Option<f64>,
    /// Since when the command has sat at the cap, or left it.
    at_cap_since: Option<f64>,
    off_cap_since: Option<f64>,
    /// Whether the command has been pinned at the cap long enough to count
    /// as saturated (with hysteresis).
    saturated: bool,
    /// Why the latest update did what it did.
    hold: ControlHold,
}

impl Default for DriftController {
    fn default() -> Self {
        Self::new(SpeakerControlState::default())
    }
}

impl DriftController {
    /// A controller that starts from what is known about the speaker.
    pub fn new(state: SpeakerControlState) -> Self {
        Self {
            mode: DriftMode::Off,
            has_adapter: false,
            state,
            command_ppm: 0.0,
            proportional_ppm: 0.0,
            target_ms: None,
            calib_outlier: false,
            virtual_inserted_ms: 0.0,
            last_update_s: None,
            unlocked_since: None,
            stale_since: None,
            at_cap_since: None,
            off_cap_since: None,
            saturated: false,
            hold: ControlHold::NoTarget,
        }
    }

    /// Starts a new connection made under `mode`, with an adapter to command
    /// or not. The target and with it the proportional term are learned
    /// afresh, since the connection got its own head start; the integral
    /// and the command carry on.
    pub fn start_connection(&mut self, mode: DriftMode, has_adapter: bool) {
        self.mode = mode;
        self.has_adapter = has_adapter;
        self.target_ms = None;
        self.calib_outlier = false;
        self.proportional_ppm = 0.0;
        self.virtual_inserted_ms = 0.0;
        self.hold = ControlHold::NoTarget;
    }

    /// Steps the controller with one report and returns the command.
    pub fn update(&mut self, input: &ControlInput) -> f64 {
        if self.mode == DriftMode::Off {
            return 0.0;
        }
        let now = input.now_s;
        // What the observed commands since the last update would have added.
        if let Some(last) = self.last_update_s {
            if self.mode == DriftMode::Observe {
                self.virtual_inserted_ms += self.command_ppm * 1e-3 * (now - last).max(0.0);
            }
        }
        self.last_update_s = Some(now);

        if !self.state.seeded {
            if let Some(c) = input.clock.filter(|c| c.se_ppm < SEED_MAX_SE_PPM) {
                // A faster speaker (positive clock) needs audio inserted.
                self.state.integral_ppm = c.ppm.clamp(-MAX_COMMAND_PPM, MAX_COMMAND_PPM);
                self.state.seeded = true;
            }
        }
        self.adopt_target(input);

        let locked = input.estimate.filter(|e| e.locked());
        let unlocked_for = elapsed(&mut self.unlocked_since, locked.is_none(), now);
        let stale_for = elapsed(&mut self.stale_since, input.stale, now);
        let ramp = unlocked_for >= RAMP_AFTER_UNLOCKED.as_secs_f64()
            || stale_for >= RAMP_AFTER_STALE.as_secs_f64();

        let integral = self.state.integral_ppm;
        let (wanted, proportional, hold) = if ramp {
            (0.0, 0.0, ControlHold::Ramping)
        } else if let Some(est) = locked {
            match self.target_ms {
                Some(target) if !self.calib_outlier => {
                    let reserve = est.reserve_ms + self.virtual_inserted_ms;
                    let error = target - reserve;
                    let deadband = DEADBAND_FLOOR_MS.max(est.half_width_ms);
                    // Inside the deadband only the damping term; beyond it
                    // the full proportional gain on top, continuous at the
                    // edge.
                    let p = DAMPING_PPM_PER_MS * error.clamp(-deadband, deadband)
                        + PROPORTIONAL_PPM_PER_MS
                            * error.signum()
                            * (error.abs() - deadband).max(0.0);
                    // A held estimate may straddle a step: it steers, but
                    // does not teach the integral.
                    let pinned_same_way = self.command_ppm.abs()
                        >= MAX_COMMAND_PPM - CAP_EPSILON_PPM
                        && error.signum() == self.command_ppm.signum();
                    if est.tight() && !pinned_same_way {
                        self.state.integral_ppm = (self.state.integral_ppm
                            + INTEGRAL_PPM_PER_MS * error)
                            .clamp(-MAX_COMMAND_PPM, MAX_COMMAND_PPM);
                        self.state.seeded = true;
                    }
                    (self.state.integral_ppm + p, p, ControlHold::Steering)
                }
                Some(_) => (integral, 0.0, ControlHold::CalibOutlier),
                None => (integral, 0.0, ControlHold::NoTarget),
            }
        } else {
            (integral, 0.0, ControlHold::Unlocked)
        };
        let wanted = wanted.clamp(-MAX_COMMAND_PPM, MAX_COMMAND_PPM);
        self.command_ppm = (self.command_ppm
            + (wanted - self.command_ppm).clamp(-MAX_SLEW_PPM, MAX_SLEW_PPM))
        .clamp(-MAX_COMMAND_PPM, MAX_COMMAND_PPM);
        self.proportional_ppm = proportional;
        self.hold = hold;
        self.step_saturation(now);
        self.command_ppm
    }

    /// Adopts the connection's target once the tracker has learned it, and
    /// judges whether it is an outlier against where the speaker's past
    /// connections settled.
    fn adopt_target(&mut self, input: &ControlInput) {
        if self.target_ms.is_some() {
            return;
        }
        let (Some(target), Some(head_start)) = (input.target_ms, input.head_start_ms) else {
            return;
        };
        let calib = target - f64::from(head_start);
        let (bias, limit) = match self.state.bias_ms() {
            Some(bias) => (bias, CALIB_OUTLIER_MS),
            None => (FIRST_CONNECTION_BIAS_MS, FIRST_CONNECTION_OUTLIER_MS),
        };
        self.calib_outlier = (calib - bias).abs() > limit;
        if self.calib_outlier {
            log::warn!(
                "[DriftControl] Connection settled at {:.0}ms against a {}ms head start \
                 (calib {:+.0}ms, expected {:+.0}\u{b1}{:.0}ms); holding the integral only",
                target,
                head_start,
                calib,
                bias,
                limit
            );
        }
        self.state.push_calib(calib);
        self.target_ms = Some(target);
    }

    /// Moves the saturation flag on: set after the command has sat at the
    /// cap for [`SATURATION_AFTER`], cleared after it has been away as long.
    fn step_saturation(&mut self, now: f64) {
        let at_cap = self.command_ppm.abs() >= MAX_COMMAND_PPM - CAP_EPSILON_PPM;
        let after = SATURATION_AFTER.as_secs_f64();
        if at_cap {
            self.off_cap_since = None;
            let since = *self.at_cap_since.get_or_insert(now);
            if now - since >= after {
                self.saturated = true;
            }
        } else {
            self.at_cap_since = None;
            let since = *self.off_cap_since.get_or_insert(now);
            if now - since >= after {
                self.saturated = false;
            }
        }
    }

    /// The command, applied or not, in ppm: `cmd` in `on`, `would_cmd` in
    /// `observe`, 0 in `off`.
    pub fn command_ppm(&self) -> f64 {
        if self.mode == DriftMode::Off {
            0.0
        } else {
            self.command_ppm
        }
    }

    /// The command actually applied to the current connection's audio: the
    /// command in `on` with an adapter, 0 otherwise.
    pub fn applied_ppm(&self) -> f64 {
        if self.mode == DriftMode::On && self.has_adapter {
            self.command_ppm
        } else {
            0.0
        }
    }

    /// The integral term, in ppm.
    pub fn integral_ppm(&self) -> f64 {
        self.state.integral_ppm
    }

    /// The proportional term of the latest update, in ppm.
    pub fn proportional_ppm(&self) -> f64 {
        self.proportional_ppm
    }

    /// The target the current connection is steered to, once adopted.
    pub fn target_ms(&self) -> Option<f64> {
        self.target_ms
    }

    /// Whether the command has been pinned at the cap for
    /// [`SATURATION_AFTER`] and has not been away from it as long.
    pub fn saturated(&self) -> bool {
        self.saturated
    }

    /// Why the latest update did what it did.
    pub fn hold(&self) -> ControlHold {
        self.hold
    }

    /// The mode the current connection was made under.
    pub fn mode(&self) -> DriftMode {
        self.mode
    }

    /// What is kept about the speaker across connections.
    pub fn state(&self) -> &SpeakerControlState {
        &self.state
    }
}

/// How long a condition has held, advancing its start marker: 0 while it
/// does not hold.
fn elapsed(since: &mut Option<f64>, holds: bool, now: f64) -> f64 {
    if holds {
        now - *since.get_or_insert(now)
    } else {
        *since = None;
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::super::reserve::LockReason;
    use super::*;

    fn estimate(reserve_ms: f64, half_width_ms: f64, lock_reason: LockReason) -> ReserveEstimate {
        ReserveEstimate {
            at: 0.0,
            reserve_ms,
            half_width_ms,
            inconsistent: false,
            jitter_ms: 30.0,
            polls: 72,
            lock_reason,
        }
    }

    fn clock(ppm: f64, se_ppm: f64) -> ClockEstimate {
        ClockEstimate {
            ppm,
            se_ppm,
            span_ms: 3_600_000.0,
            dof: 40,
        }
    }

    /// A controller on a connection made under `mode` with an adapter,
    /// already steering to a 450 ms target against a 500 ms head start.
    fn steering(mode: DriftMode, state: SpeakerControlState) -> DriftController {
        let mut c = DriftController::new(state);
        c.start_connection(mode, true);
        c.update(&input(0.0, Some(estimate(450.0, 30.0, LockReason::Tight))));
        assert_eq!(c.target_ms(), Some(450.0));
        c
    }

    fn input(now_s: f64, estimate: Option<ReserveEstimate>) -> ControlInput {
        ControlInput {
            now_s,
            estimate,
            target_ms: Some(450.0),
            head_start_ms: Some(500),
            clock: None,
            stale: false,
        }
    }

    #[test]
    fn the_mode_parses_and_prints_its_config_strings() {
        for mode in [DriftMode::On, DriftMode::Observe, DriftMode::Off] {
            assert_eq!(DriftMode::parse(mode.as_str()), Some(mode));
            assert_eq!(
                serde_json::to_string(&mode).unwrap(),
                format!("\"{}\"", mode.as_str())
            );
        }
        assert_eq!(DriftMode::parse(" ON "), Some(DriftMode::On));
        assert_eq!(DriftMode::parse("sometimes"), None);
        assert_eq!(DriftMode::default(), DriftMode::Observe);
    }

    #[test]
    fn the_environment_outranks_the_setting_and_no_monitor_means_off() {
        use DriftMode::*;
        assert_eq!(resolve_drift_mode(Observe, None, true), Observe);
        assert_eq!(resolve_drift_mode(Observe, Some(On), true), On);
        assert_eq!(resolve_drift_mode(On, Some(Off), true), Off);
        assert_eq!(resolve_drift_mode(On, None, false), Off);
        assert_eq!(resolve_drift_mode(On, Some(On), false), Off);
    }

    #[test]
    fn a_forced_rate_must_be_a_number_the_adapter_takes() {
        assert_eq!(parse_drift_force_ppm("150"), Ok(Some(150.0)));
        assert_eq!(parse_drift_force_ppm(" -150 "), Ok(Some(-150.0)));
        assert_eq!(parse_drift_force_ppm("+300"), Ok(Some(300.0)));
        assert_eq!(parse_drift_force_ppm("0"), Ok(Some(0.0)));
        assert_eq!(parse_drift_force_ppm("  "), Ok(None));
        for bad in ["300.5", "-301", "fast", "150ppm", "NaN", "inf", "1e9"] {
            assert!(parse_drift_force_ppm(bad).is_err(), "{bad}");
            // Ignored, with a warning, rather than forcing anything.
            assert_eq!(drift_force_ppm_from(Some(bad)), None, "{bad}");
        }
        // Unset forces nothing.
        assert_eq!(drift_force_ppm_from(None), None);
        assert_eq!(drift_force_ppm_from(Some("-42.5")), Some(-42.5));
    }

    #[test]
    fn an_unusable_forced_rate_is_warned_about_once_per_value() {
        let warned = std::sync::Mutex::new(None);
        assert!(first_warning_for(&warned, "fast"));
        assert!(!first_warning_for(&warned, "fast"));
        assert!(first_warning_for(&warned, "1e9"));
        assert!(!first_warning_for(&warned, "1e9"));
    }

    #[test]
    fn off_commands_nothing() {
        let mut c = DriftController::default();
        c.start_connection(DriftMode::Off, false);
        let mut i = input(0.0, Some(estimate(100.0, 30.0, LockReason::Tight)));
        i.clock = Some(clock(40.0, 1.0));
        assert_eq!(c.update(&i), 0.0);
        assert_eq!(c.integral_ppm(), 0.0, "off does not even seed");
    }

    #[test]
    fn faster_speaker_seeds_positive_insert() {
        let mut c = DriftController::default();
        c.start_connection(DriftMode::On, true);
        let mut i = input(0.0, None);
        i.clock = Some(clock(20.0, 12.0));
        c.update(&i);
        assert_eq!(c.integral_ppm(), 0.0, "not precise enough to seed");
        i.clock = Some(clock(20.0, 6.0));
        i.now_s = 30.0;
        c.update(&i);
        // The speaker plays faster than we deliver, so audio is inserted.
        assert_eq!(c.integral_ppm(), 20.0);
        assert!(c.command_ppm() > 0.0);
        // Seeded once: a later fit does not overwrite what the loop learns.
        i.clock = Some(clock(35.0, 2.0));
        i.now_s = 60.0;
        c.update(&i);
        assert_eq!(c.integral_ppm(), 20.0);
    }

    #[test]
    fn deadband_tracks_half_width() {
        // 90 ms below target: inside a 100 ms half-width, no proportional
        // term; outside the 40 ms floor with a narrow estimate, 0.833 ppm
        // per ms beyond it.
        let mut wide = steering(DriftMode::On, SpeakerControlState::default());
        wide.update(&input(30.0, Some(estimate(360.0, 100.0, LockReason::Held))));
        assert!(
            (wide.proportional_ppm() - 0.5 * 90.0).abs() < 1e-9,
            "damping only"
        );

        let mut narrow = steering(DriftMode::On, SpeakerControlState::default());
        narrow.update(&input(30.0, Some(estimate(360.0, 25.0, LockReason::Tight))));
        let expected = 0.5 * 40.0 + 0.833 * 50.0;
        assert!((narrow.proportional_ppm() - expected).abs() < 1e-9);

        // Above the target, the other way, beyond a 60 ms half-width.
        let mut above = steering(DriftMode::On, SpeakerControlState::default());
        above.update(&input(30.0, Some(estimate(560.0, 60.0, LockReason::Tight))));
        let expected = 0.5 * 60.0 + 0.833 * 50.0;
        assert!((above.proportional_ppm() + expected).abs() < 1e-9);
    }

    #[test]
    fn held_estimate_freezes_i() {
        let mut c = steering(DriftMode::On, SpeakerControlState::default());
        let before = c.integral_ppm();
        c.update(&input(30.0, Some(estimate(300.0, 100.0, LockReason::Held))));
        assert_eq!(c.integral_ppm(), before, "a held estimate teaches nothing");
        assert!(c.proportional_ppm() > 0.0, "but still steers");
        c.update(&input(60.0, Some(estimate(300.0, 30.0, LockReason::Tight))));
        assert!((c.integral_ppm() - before - 0.0069 * 150.0).abs() < 1e-9);
    }

    #[test]
    fn unlocked_holds_i() {
        let state = SpeakerControlState {
            integral_ppm: 18.0,
            seeded: true,
            ..SpeakerControlState::default()
        };
        let mut c = DriftController::new(state);
        c.start_connection(DriftMode::On, true);
        // Slews up to the held integral, then holds it with no P.
        let mut t = 0.0;
        for _ in 0..4 {
            c.update(&input(t, None));
            t += 30.0;
        }
        assert_eq!(c.command_ppm(), 18.0);
        assert_eq!(c.hold(), ControlHold::Unlocked);
        // Still holding just short of 30 minutes unlocked...
        while t < 29.0 * 60.0 {
            c.update(&input(t, None));
            t += 30.0;
        }
        assert_eq!(c.command_ppm(), 18.0);
        // ...then ramps to 0 at 10 ppm an estimate, the integral kept.
        while t < 32.0 * 60.0 {
            c.update(&input(t, None));
            t += 30.0;
        }
        assert_eq!(c.command_ppm(), 0.0);
        assert_eq!(c.hold(), ControlHold::Ramping);
        assert_eq!(c.integral_ppm(), 18.0);

        // A speaker that stops answering ramps after 10 minutes, even while
        // its last estimate stood locked.
        let mut c = steering(DriftMode::On, SpeakerControlState::default());
        let mut i = input(30.0, Some(estimate(450.0, 30.0, LockReason::Tight)));
        c.state.integral_ppm = 18.0;
        i.stale = true;
        for n in 0..24 {
            i.now_s = 30.0 * f64::from(n + 1);
            c.update(&i);
        }
        assert_eq!(c.hold(), ControlHold::Ramping);
    }

    #[test]
    fn saturation_does_not_wind_up() {
        let mut c = steering(DriftMode::On, SpeakerControlState::default());
        // A speaker far faster than the cap: the reserve keeps falling.
        let mut t = 30.0;
        let mut reserve = 450.0;
        while t < 3.0 * 3600.0 {
            reserve -= 3.0;
            c.update(&input(t, Some(estimate(reserve, 30.0, LockReason::Tight))));
            t += 30.0;
        }
        assert_eq!(c.command_ppm(), MAX_COMMAND_PPM);
        assert!(c.saturated());
        let wound = c.integral_ppm();
        assert!(wound <= MAX_COMMAND_PPM);
        // Once the error turns, the integral comes off the cap at once: it
        // never integrated past it in the direction it was pinned.
        c.update(&input(t, Some(estimate(600.0, 30.0, LockReason::Tight))));
        assert!(c.integral_ppm() < wound);
        assert!(c.command_ppm() < MAX_COMMAND_PPM);
        // And the saturation flag clears only after five minutes off the cap.
        for n in 1..=9 {
            c.update(&input(
                t + 30.0 * f64::from(n),
                Some(estimate(460.0, 30.0, LockReason::Tight)),
            ));
        }
        assert!(c.saturated(), "under five minutes off the cap");
        {
            let n = 10;
            c.update(&input(
                t + 30.0 * f64::from(n),
                Some(estimate(460.0, 30.0, LockReason::Tight)),
            ));
        }
        assert!(!c.saturated());
    }

    #[test]
    fn reconnect_reburst_rebaselines_p_keeps_i() {
        let mut c = steering(DriftMode::On, SpeakerControlState::default());
        let mut t = 30.0;
        for _ in 0..20 {
            c.update(&input(t, Some(estimate(380.0, 30.0, LockReason::Tight))));
            t += 30.0;
        }
        let integral = c.integral_ppm();
        assert!(integral > 0.0 && c.proportional_ppm() > 0.0);

        // The reconnect re-bursts: the new connection settles at its own,
        // higher level, which becomes its target; nothing of the old error
        // survives in P, and I carries on.
        c.start_connection(DriftMode::On, true);
        assert_eq!(c.target_ms(), None);
        assert_eq!(c.proportional_ppm(), 0.0);
        assert_eq!(c.integral_ppm(), integral);
        let mut i = input(t, Some(estimate(480.0, 30.0, LockReason::Tight)));
        i.target_ms = None;
        c.update(&i);
        assert_eq!(c.hold(), ControlHold::NoTarget);
        assert_eq!(c.integral_ppm(), integral);
        i.target_ms = Some(480.0);
        i.now_s += 30.0;
        c.update(&i);
        assert_eq!(c.target_ms(), Some(480.0));
        assert_eq!(c.proportional_ppm(), 0.0);
        assert!(
            (c.integral_ppm() - integral).abs() < 1e-9,
            "no error, no change"
        );
    }

    #[test]
    fn first_connection_uses_default_bias() {
        // First connection: expected at H − 50 ± 200.
        let mut c = DriftController::default();
        c.start_connection(DriftMode::On, true);
        let mut i = input(0.0, Some(estimate(300.0, 30.0, LockReason::Tight)));
        i.target_ms = Some(300.0); // calib −200: 150 from −50, inside 200.
        c.update(&i);
        assert_eq!(c.hold(), ControlHold::Steering);

        let mut c = DriftController::default();
        c.start_connection(DriftMode::On, true);
        i.target_ms = Some(240.0); // calib −260: 210 from −50.
        c.update(&i);
        assert_eq!(c.hold(), ControlHold::CalibOutlier);
        assert_eq!(c.proportional_ppm(), 0.0);

        // With history the bias is its median and the test ±150.
        let state = SpeakerControlState {
            calibs_ms: [-40.0, -45.0, -50.0].into_iter().collect(),
            ..SpeakerControlState::default()
        };
        let mut c = DriftController::new(state);
        c.start_connection(DriftMode::On, true);
        i.target_ms = Some(300.0); // calib −200: 155 from −45.
        c.update(&i);
        assert_eq!(c.hold(), ControlHold::CalibOutlier);
        assert_eq!(c.state().calibs_ms.len(), 4);
    }

    #[test]
    fn observe_steers_a_virtual_reserve() {
        // Observing, the reserve drains as nothing is inserted; the
        // controller counts what it would have inserted, so its command
        // settles at the clock rate (seeded from a fit 3 ppm off) instead of
        // winding up to the cap.
        let mut c = steering(DriftMode::Observe, SpeakerControlState::default());
        let mut t = 30.0;
        let mut reserve = 450.0;
        let mut commands = Vec::new();
        while t < 8.0 * 3600.0 {
            reserve -= 20.0 * 1e-3 * 30.0;
            let mut i = input(t, Some(estimate(reserve, 30.0, LockReason::Tight)));
            i.clock = Some(clock(23.0, 5.0));
            commands.push(c.update(&i));
            t += 30.0;
        }
        assert!(
            commands[commands.len() / 2..]
                .iter()
                .all(|u| (u - 20.0).abs() < 4.0),
            "{commands:?}"
        );
        assert_eq!(c.applied_ppm(), 0.0, "observing applies nothing");
    }

    #[test]
    fn drift_is_active_only_when_an_engaged_adapter_follows() {
        let control = RateControl::new();
        assert!(!drift_active(DriftMode::On, None));
        assert!(!drift_active(DriftMode::On, Some(&control)), "not engaged");
        control.mark_engaged();
        assert!(drift_active(DriftMode::On, Some(&control)));
        assert!(!drift_active(DriftMode::Observe, Some(&control)));
        control.pin();
        assert!(!drift_active(DriftMode::On, Some(&control)), "pinned");
    }
}
