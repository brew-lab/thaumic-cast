//! Estimates how much audio a speaker holds ahead of its playhead.
//!
//! The reserve is `R = D − P`: audio delivered to the speaker's connection
//! minus audio it has played. Each poll bounds it to an interval about a
//! second wide (see [`PollObservation::reserve_bound`]). Over the last
//! [`RESERVE_WINDOW_MS`] of polls, with their phase against the speaker's
//! second dithered, the intersection of those intervals is a few tens of
//! milliseconds wide.
//!
//! A plain intersection is broken by a single bad answer, and a speaker's
//! second does not tick over at exactly the same point every time (about
//! ±50-100 ms per reading was measured). So the estimator takes the
//! [`TRIM_RANK`]th largest lower bound and the [`TRIM_RANK`]th smallest
//! upper bound, and widens every bound by a jitter allowance learnt from how
//! badly the un-widened bounds disagree.
//!
//! Locking is strict to acquire and loose to hold. An estimate locks only
//! once it is as narrow as a settled speaker's estimates are; a locked one
//! stays locked while it is merely wider than that (a few lost polls, an
//! unlucky spread of phases), and drops only after [`UNLOCK_AFTER_FAILS`]
//! estimates in a row too wide, or too thinly polled, to be trusted, or at
//! once on a segment break. [`LockReason`] says which of those an estimate
//! is, so that only estimates as narrow as acquiring needs set baselines.

use std::collections::VecDeque;

use super::bounds::{kth_largest, kth_smallest, PlayheadBound, PollObservation};

/// How far back polls count towards an estimate: about 72 polls at the
/// monitor-only cadence.
pub const RESERVE_WINDOW_MS: f64 = 180_000.0;

/// Which order statistic each side uses. The third extreme ignores up to two
/// outlying answers on each side.
pub const TRIM_RANK: usize = 3;

/// Fewest polls an estimate is made from.
pub const MIN_POLLS_FOR_ESTIMATE: usize = 2 * TRIM_RANK + 2;

/// Jitter allowance before anything has been learnt: the top of the
/// measured tick jitter.
pub const INITIAL_JITTER_MS: f64 = 100.0;

/// Bounds on the jitter allowance.
pub const MIN_JITTER_MS: f64 = 25.0;
/// Upper bound on the jitter allowance.
pub const MAX_JITTER_MS: f64 = 200.0;

/// Margin kept on top of the learnt disagreement, so a speaker whose jitter
/// is exactly what was learnt is not reported inconsistent half the time.
/// It is also the allowance for a speaker that shows no jitter at all.
pub const JITTER_MARGIN_MS: f64 = MIN_JITTER_MS;

/// Smoothing of the learnt disagreement, per estimate.
pub const JITTER_EMA_ALPHA: f64 = 0.3;

/// Span of polls a segment must cover before its estimate can lock.
pub const LOCK_MIN_SPAN_MS: f64 = 90_000.0;

/// Half-width an estimate may have and still lock, before jitter widens it.
///
/// The third extreme of ~72 phases spread over a 1000 ms quantum sits about
/// 41 ms inside the quantum on each side; the round trip adds up to its own
/// length on the upper side and delivery moves in 10 ms frames. With the
/// minimum jitter allowance, a jitter-free speaker's half-width is therefore
/// 75-85 ms, and no floor below that can ever be met.
pub const LOCK_HALF_WIDTH_FLOOR_MS: f64 = 110.0;

/// Multiple of the jitter allowance an estimate's half-width may reach and
/// still lock, for a speaker whose jitter dominates.
pub const LOCK_HALF_WIDTH_JITTER_FACTOR: f64 = 1.5;

/// Inconsistent estimates allowed among the last [`LOCK_RECENT_ESTIMATES`].
pub const LOCK_MAX_RECENT_INCONSISTENT: usize = 1;

/// How many recent estimates the consistency condition looks at.
pub const LOCK_RECENT_ESTIMATES: usize = 3;

/// Absolute half-width a locked estimate may widen to and stay locked.
///
/// There is no jitter term: the learnt jitter swells when a window straddles
/// a real step, and that must not hold the lock. Set from the simulator
/// (`hw_distribution_old_vs_new_dither`, 300 seeds, ±50 ms tick jitter):
/// the 99th percentile of the half-width from 36 polls, half a window, is
/// about 213 ms, clamped to the 160-200 ms the design allows. Estimates 30 s
/// apart share most of their window, so two failing in a row are nearly as
/// likely as one: the width is sized for a single estimate.
pub const HOLD_HALF_WIDTH_MS: f64 = 200.0;

/// Fewest polls in the window a locked estimate may stand on.
pub const HOLD_MIN_POLLS: usize = 30;

/// Consecutive estimates failing the hold test before the lock drops.
pub const UNLOCK_AFTER_FAILS: usize = 2;

/// Half-width an estimate may have and still acquire a lock, given the
/// jitter allowance it was widened by.
pub fn acquire_half_width_ms(jitter_ms: f64) -> f64 {
    LOCK_HALF_WIDTH_FLOOR_MS.max(LOCK_HALF_WIDTH_JITTER_FACTOR * jitter_ms)
}

/// Where an estimate stands against the lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LockReason {
    /// Not locked: the segment is too short, the estimate too wide or too
    /// often inconsistent, or the lock has just dropped.
    Unlocked,
    /// The estimate that acquired the lock.
    Acquired,
    /// Locked and as narrow as acquiring needs, against both the jitter
    /// allowance now and the one frozen when the lock was acquired.
    Tight,
    /// Locked, but wider than acquiring needs (or, for one estimate before
    /// the lock drops, failing the hold test). Good for the reserve's level;
    /// not for baselines or anything learnt from it.
    Held,
}

impl LockReason {
    /// Whether the estimate is locked.
    pub fn locked(self) -> bool {
        !matches!(self, Self::Unlocked)
    }

    /// Whether the estimate is locked and as narrow as acquiring needs, so
    /// it may set baselines and teach targets.
    pub fn tight(self) -> bool {
        matches!(self, Self::Acquired | Self::Tight)
    }

    /// The reason as a log token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unlocked => "unlocked",
            Self::Acquired => "acquired",
            Self::Tight => "tight",
            Self::Held => "held",
        }
    }
}

impl std::fmt::Display for LockReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One reserve estimate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReserveEstimate {
    /// The moment the estimate describes.
    pub at: f64,
    /// Best estimate of the reserve, in milliseconds.
    pub reserve_ms: f64,
    /// Half the width of the interval the reserve is known to lie in,
    /// jitter allowance included, and never less than the jitter allowance.
    pub half_width_ms: f64,
    /// Whether the widened bounds still did not overlap.
    pub inconsistent: bool,
    /// The jitter allowance the bounds were widened by.
    pub jitter_ms: f64,
    /// Polls the estimate was made from.
    pub polls: usize,
    /// Whether, and how firmly, the estimate is locked.
    pub lock_reason: LockReason,
}

impl ReserveEstimate {
    /// Whether the estimate is precise and settled enough to act on.
    pub fn locked(&self) -> bool {
        self.lock_reason.locked()
    }

    /// Whether the estimate is locked and as narrow as acquiring needs.
    pub fn tight(&self) -> bool {
        self.lock_reason.tight()
    }
}

/// Rolling reserve estimator for one speaker.
#[derive(Debug, Clone)]
pub struct ReserveEstimator {
    /// Un-widened reserve bounds of the polls in the window, oldest first.
    window: VecDeque<PlayheadBound>,
    /// How far back polls count, in ms: [`RESERVE_WINDOW_MS`] unless made
    /// with [`Self::fresh`].
    window_ms: f64,
    /// When the current segment's first poll was taken.
    segment_start: Option<f64>,
    /// Smoothed disagreement between the un-widened bounds.
    disagreement_ms: f64,
    /// Whether each of the last few estimates was inconsistent.
    recent: VecDeque<bool>,
    /// Estimates made and how many were inconsistent, since creation.
    estimates: u64,
    inconsistent: u64,
    /// The acquire half-width when the current lock was acquired, jitter
    /// frozen at that moment; `None` while unlocked.
    lock_width_ms: Option<f64>,
    /// Consecutive locked estimates that have failed the hold test.
    held_fails: usize,
}

impl Default for ReserveEstimator {
    fn default() -> Self {
        Self::new()
    }
}

impl ReserveEstimator {
    /// An estimator with no polls.
    pub fn new() -> Self {
        Self {
            window: VecDeque::with_capacity(96),
            window_ms: RESERVE_WINDOW_MS,
            segment_start: None,
            disagreement_ms: INITIAL_JITTER_MS - JITTER_MARGIN_MS,
            recent: VecDeque::with_capacity(LOCK_RECENT_ESTIMATES + 1),
            estimates: 0,
            inconsistent: 0,
            lock_width_ms: None,
            held_fails: 0,
        }
    }

    /// Adds a poll, forgetting any that have fallen out of the window.
    pub fn add(&mut self, obs: &PollObservation) {
        self.segment_start.get_or_insert(obs.ts);
        let bound = obs.reserve_bound();
        self.prune(bound.at);
        self.window.push_back(bound);
    }

    /// Forgets the polls that have fallen out of the window by `now`.
    fn prune(&mut self, now: f64) {
        while self
            .window
            .front()
            .is_some_and(|b| now - b.at > self.window_ms)
        {
            self.window.pop_front();
        }
    }

    /// Forgets every poll and drops the lock: the reserve is measured afresh
    /// from the next one. The learnt jitter is kept, since it belongs to the
    /// speaker.
    pub fn clear(&mut self) {
        self.window.clear();
        self.segment_start = None;
        self.recent.clear();
        self.lock_width_ms = None;
        self.held_fails = 0;
    }

    /// An estimator with no polls and no lock that starts from the jitter
    /// this one has learnt and counts polls over the last `window_ms`, for
    /// measuring one stretch of polls on its own. The estimate's precision
    /// comes from how closely the polls' phases (and tick jitter) approach
    /// either edge of the speaker's second, which improves with the number
    /// of polls: a longer window measures a level more finely than averaging
    /// the estimates of overlapping shorter ones.
    pub fn fresh(&self, window_ms: f64) -> Self {
        Self {
            disagreement_ms: self.disagreement_ms,
            window_ms,
            ..Self::new()
        }
    }

    /// Appends `other`'s polls, each bound moved by `shift_ms`, after this
    /// one's; the lock and learnt jitter stay this estimator's. `other`'s
    /// polls must all be newer than this one's.
    pub fn absorb(&mut self, other: &Self, shift_ms: f64) {
        if self.segment_start.is_none() {
            self.segment_start = other.segment_start;
        }
        self.window
            .extend(other.window.iter().map(|b| PlayheadBound {
                lo: b.lo + shift_ms,
                hi: b.hi + shift_ms,
                at: b.at,
            }));
    }

    /// Of the polls sent from `since` on whose bounds, carried to `now`
    /// along `clock_ppm` (see [`Self::estimate`]), lie wholly to one side of
    /// `level`, how many of the newest are all on the same side: counted back
    /// from the newest until one lies on the other side.
    pub fn newest_beyond(&self, now: f64, clock_ppm: f64, since: f64, level: f64) -> usize {
        let rate = -clock_ppm * 1e-6;
        let mut side = None;
        let mut run = 0;
        for b in self
            .window
            .iter()
            .rev()
            .take_while(|b| b.at >= since)
            .map(|b| b.shifted_to(now, rate))
        {
            let beyond = if b.lo > level {
                true
            } else if b.hi < level {
                false
            } else {
                continue;
            };
            if *side.get_or_insert(beyond) != beyond {
                break;
            }
            run += 1;
        }
        run
    }

    /// Moves every poll's bound in the window by `shift_ms`.
    pub fn shift(&mut self, shift_ms: f64) {
        for b in &mut self.window {
            b.lo += shift_ms;
            b.hi += shift_ms;
        }
    }

    /// Consecutive locked estimates that have failed the hold test.
    pub fn held_fails(&self) -> usize {
        self.held_fails
    }

    /// The jitter allowance currently applied.
    pub fn jitter_ms(&self) -> f64 {
        (self.disagreement_ms + JITTER_MARGIN_MS).clamp(MIN_JITTER_MS, MAX_JITTER_MS)
    }

    /// Estimates made and how many of them were inconsistent.
    pub fn counts(&self) -> (u64, u64) {
        (self.estimates, self.inconsistent)
    }

    /// Polls in the window.
    pub fn polls(&self) -> usize {
        self.window.len()
    }

    /// Estimates the reserve at `now`.
    ///
    /// `clock_ppm` is how much faster the speaker plays than our clock runs
    /// (see [`super::ClockFit`]); each bound is moved from its poll to `now`
    /// along the reserve's drift that implies. The shift is taken from the
    /// clock fit rather than from the reserve's own slope so that anything
    /// done to the delivered audio cannot feed back into it.
    ///
    /// An unlocked estimate locks when the segment spans
    /// [`LOCK_MIN_SPAN_MS`], its half-width is within
    /// [`acquire_half_width_ms`] and at most [`LOCK_MAX_RECENT_INCONSISTENT`]
    /// of the last [`LOCK_RECENT_ESTIMATES`] were inconsistent. A locked one
    /// holds while its half-width is within [`HOLD_HALF_WIDTH_MS`] (or the
    /// acquire width frozen at the lock, if wider), it stands on at least
    /// [`HOLD_MIN_POLLS`] polls and the same consistency condition holds;
    /// [`UNLOCK_AFTER_FAILS`] failures in a row drop it.
    ///
    /// Returns `None` until the window holds [`MIN_POLLS_FOR_ESTIMATE`] polls.
    pub fn estimate(&mut self, now: f64, clock_ppm: f64) -> Option<ReserveEstimate> {
        self.prune(now);
        let n = self.window.len();
        if n < MIN_POLLS_FOR_ESTIMATE {
            return None;
        }
        // Delivery runs at our clock and the playhead at the speaker's, so
        // the reserve changes by −ppm·1e-6 ms per ms.
        let rate = -clock_ppm * 1e-6;
        let (mut los, mut his): (Vec<f64>, Vec<f64>) = self
            .window
            .iter()
            .map(|b| {
                let s = b.shifted_to(now, rate);
                (s.lo, s.hi)
            })
            .unzip();
        let l0 = kth_largest(&mut los, TRIM_RANK)?;
        let u0 = kth_smallest(&mut his, TRIM_RANK)?;

        // How far the un-widened bounds overshoot each other says how much
        // jitter the speaker has; bounds that overlap say it has none.
        let needed = ((l0 - u0) / 2.0).max(0.0);
        self.disagreement_ms += JITTER_EMA_ALPHA * (needed - self.disagreement_ms);
        let jitter = self.jitter_ms();

        let (lo, hi) = (l0 - jitter, u0 + jitter);
        let inconsistent = lo > hi;
        // Under jitter the un-widened bounds cross, and how well the widened
        // ones then agree says nothing about where inside the jitter the
        // reserve lies: the estimate is never claimed to be better than the
        // jitter allowance.
        let half_width_ms = ((hi - lo) / 2.0).max(jitter);

        self.estimates += 1;
        if inconsistent {
            self.inconsistent += 1;
        }
        self.recent.push_back(inconsistent);
        while self.recent.len() > LOCK_RECENT_ESTIMATES {
            self.recent.pop_front();
        }

        let span = self.segment_start.map_or(0.0, |start| now - start);
        let recent_consistent =
            self.recent.iter().filter(|i| **i).count() <= LOCK_MAX_RECENT_INCONSISTENT;
        let lock_reason = self.step_lock(n, span, half_width_ms, jitter, recent_consistent);

        Some(ReserveEstimate {
            at: now,
            // The widening is symmetric, so the midpoint does not depend on it.
            reserve_ms: (l0 + u0) / 2.0,
            half_width_ms,
            inconsistent,
            jitter_ms: jitter,
            polls: n,
            lock_reason,
        })
    }

    /// Moves the lock on by one estimate of `half_width_ms` from `polls`
    /// polls over a segment of `span` ms, widened by `jitter`.
    fn step_lock(
        &mut self,
        polls: usize,
        span: f64,
        half_width_ms: f64,
        jitter: f64,
        recent_consistent: bool,
    ) -> LockReason {
        let acquire_width = acquire_half_width_ms(jitter);
        let Some(lock_width) = self.lock_width_ms else {
            if span >= LOCK_MIN_SPAN_MS && half_width_ms <= acquire_width && recent_consistent {
                self.lock_width_ms = Some(acquire_width);
                self.held_fails = 0;
                return LockReason::Acquired;
            }
            return LockReason::Unlocked;
        };
        let holds = half_width_ms <= HOLD_HALF_WIDTH_MS.max(lock_width)
            && polls >= HOLD_MIN_POLLS
            && recent_consistent;
        if !holds {
            self.held_fails += 1;
            if self.held_fails >= UNLOCK_AFTER_FAILS {
                self.lock_width_ms = None;
                self.held_fails = 0;
                return LockReason::Unlocked;
            }
            return LockReason::Held;
        }
        self.held_fails = 0;
        // Against the stricter of the two widths, so jitter swollen by a
        // window straddling a step cannot make that window's estimates tight.
        if half_width_ms <= acquire_width.min(lock_width) {
            LockReason::Tight
        } else {
            LockReason::Held
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::PollGen;
    use super::*;

    /// Runs `gen` for `minutes`, estimating every 30 s, and returns every
    /// estimate with the true reserve at its moment.
    fn run(gen: &mut PollGen, minutes: f64) -> (ReserveEstimator, Vec<(ReserveEstimate, f64)>) {
        let mut est = ReserveEstimator::new();
        let mut out = Vec::new();
        let mut next_estimate = 30_000.0;
        let end = minutes * 60_000.0;
        while next_estimate <= end {
            gen.run_until(next_estimate, |p| est.add(p));
            if let Some(e) = est.estimate(next_estimate, gen.ppm) {
                out.push((e, gen.reserve(next_estimate)));
            }
            next_estimate += 30_000.0;
        }
        (est, out)
    }

    #[test]
    fn converges_within_50ms_after_72_dithered_polls() {
        for seed in 0..8 {
            let mut gen = PollGen::new(seed);
            let (_, estimates) = run(&mut gen, 10.0);
            let (last, truth) = estimates.last().copied().expect("estimates");
            assert!(last.polls >= 70, "{last:?}");
            assert!(
                (last.reserve_ms - truth).abs() <= 50.0,
                "seed {seed}: estimated {:.1} vs true {truth:.1}",
                last.reserve_ms
            );
            assert!(last.locked(), "seed {seed}: {last:?}");
            assert!(!last.inconsistent);
            assert!(
                last.reserve_ms - last.half_width_ms <= truth
                    && truth <= last.reserve_ms + last.half_width_ms,
                "seed {seed}: the interval must contain the truth: {last:?} vs {truth}"
            );
        }
    }

    #[test]
    fn tick_jitter_of_100ms_widens_but_does_not_break_the_estimate() {
        let mut half_widths = Vec::new();
        let mut errors = Vec::new();
        let (mut incons, mut total) = (0u64, 0u64);
        for seed in 0..8 {
            let mut gen = PollGen::new(100 + seed);
            gen.tick_jitter_ms = 100.0;
            let (est, estimates) = run(&mut gen, 20.0);
            for (e, truth) in estimates.iter().filter(|(e, _)| e.polls >= 70) {
                half_widths.push(e.half_width_ms);
                errors.push((e.reserve_ms - truth).abs());
            }
            let (n, i) = est.counts();
            total += n;
            incons += i;
        }
        half_widths.sort_by(f64::total_cmp);
        errors.sort_by(f64::total_cmp);
        let median_half_width = half_widths[half_widths.len() / 2];
        assert!(
            median_half_width <= 70.0,
            "median half-width {median_half_width:.1} ms"
        );
        assert!(
            *half_widths.last().unwrap() <= LOCK_HALF_WIDTH_FLOOR_MS + 60.0,
            "worst half-width {:.1} ms",
            half_widths.last().unwrap()
        );
        assert!(
            errors[errors.len() / 2] <= 25.0,
            "median error {:.1}",
            errors[errors.len() / 2]
        );
        assert!(
            *errors.last().unwrap() <= 100.0,
            "worst error {:.1}",
            errors.last().unwrap()
        );
        assert!(
            incons * 20 <= total,
            "{incons} of {total} estimates inconsistent"
        );
    }

    #[test]
    fn jitter_estimate_tracks_injected_jitter() {
        // The allowance moves with every estimate, so compare its average
        // over the last ten minutes of each run.
        let jitter_after = |tick_jitter_ms: f64| {
            let mut gen = PollGen::new(7);
            gen.tick_jitter_ms = tick_jitter_ms;
            let (_, estimates) = run(&mut gen, 20.0);
            let tail = &estimates[estimates.len() - 20..];
            tail.iter().map(|(e, _)| e.jitter_ms).sum::<f64>() / tail.len() as f64
        };
        let calm = jitter_after(0.0);
        let rough = jitter_after(300.0);
        assert!(
            calm < MIN_JITTER_MS + 1.0,
            "no jitter learns the minimum: {calm:.1}"
        );
        assert!(
            rough > calm + 25.0 && rough < MAX_JITTER_MS,
            "300 ms of tick jitter learnt as {rough:.1} ms"
        );
    }

    #[test]
    fn two_outlier_polls_do_not_move_the_estimate() {
        let baseline = {
            let mut gen = PollGen::new(3);
            run(&mut gen, 6.0).1.last().copied().unwrap().0
        };
        let mut gen = PollGen::new(3);
        // Two answers a whole second early and two a whole second late, all
        // inside the last window.
        gen.outliers = vec![(100, -1), (110, -1), (105, 1), (115, 1)];
        let (_, estimates) = run(&mut gen, 6.0);
        let with_outliers = estimates.last().copied().unwrap().0;
        // The outliers push the good polls' extremes one rank inward on each
        // side, which moves the estimate by a few milliseconds; a plain
        // intersection would have moved by half a second, or broken.
        assert!(
            (with_outliers.reserve_ms - baseline.reserve_ms).abs() <= 25.0,
            "{with_outliers:?} vs {baseline:?}"
        );
        assert!(!with_outliers.inconsistent);
    }

    #[test]
    fn rounding_reltime_is_a_constant_offset_not_a_drift() {
        let mut gen = PollGen::new(11);
        gen.round = true;
        gen.ppm = 40.0;
        let (_, estimates) = run(&mut gen, 60.0);
        let offsets: Vec<f64> = estimates
            .iter()
            .filter(|(e, _)| e.locked())
            .map(|(e, truth)| e.reserve_ms - truth)
            .collect();
        let first = offsets[..10].iter().sum::<f64>() / 10.0;
        let last = offsets[offsets.len() - 10..].iter().sum::<f64>() / 10.0;
        assert!(
            (first + 500.0).abs() < 60.0,
            "rounding reads the reserve about half a quantum low: {first:.1}"
        );
        assert!(
            (last - first).abs() < 30.0,
            "the offset must not drift: {first:.1} then {last:.1}"
        );
    }

    #[test]
    fn nothing_is_estimated_from_too_few_polls_or_before_the_lock_span() {
        let mut gen = PollGen::new(5);
        let mut est = ReserveEstimator::new();
        gen.run_until(20_000.0, |p| est.add(p));
        assert!(est.estimate(20_000.0, 0.0).is_none());
        gen.run_until(60_000.0, |p| est.add(p));
        let e = est.estimate(60_000.0, 0.0).expect("estimate");
        assert!(!e.locked(), "under the lock span: {e:?}");
    }

    #[test]
    fn clearing_starts_the_segment_afresh_but_keeps_the_jitter() {
        let mut gen = PollGen::new(9);
        gen.tick_jitter_ms = 300.0;
        let (mut est, _) = run(&mut gen, 10.0);
        let learnt = est.jitter_ms();
        est.clear();
        assert_eq!(est.polls(), 0);
        assert_eq!(est.jitter_ms(), learnt);
    }
    /// An estimator whose lock has been acquired at the minimum jitter
    /// allowance (acquire width 110 ms), without any polls.
    fn locked_estimator() -> ReserveEstimator {
        let mut est = ReserveEstimator::new();
        assert_eq!(
            est.step_lock(72, LOCK_MIN_SPAN_MS, 60.0, MIN_JITTER_MS, true),
            LockReason::Acquired
        );
        est
    }

    #[test]
    fn a_locked_estimate_stays_locked_when_half_width_reaches_150ms() {
        let mut est = locked_estimator();
        for _ in 0..10 {
            assert_eq!(
                est.step_lock(40, 300_000.0, 150.0, MIN_JITTER_MS, true),
                LockReason::Held
            );
        }
        assert_eq!(est.held_fails(), 0);
        // Narrowing again is tight.
        assert_eq!(
            est.step_lock(72, 300_000.0, 80.0, MIN_JITTER_MS, true),
            LockReason::Tight
        );
    }

    #[test]
    fn lock_drops_after_two_estimates_over_the_hold_width() {
        let mut est = locked_estimator();
        let wide = HOLD_HALF_WIDTH_MS + 10.0;
        // One failure is held; a pass in between resets the count.
        assert_eq!(
            est.step_lock(72, 300_000.0, wide, MIN_JITTER_MS, true),
            LockReason::Held
        );
        assert_eq!(
            est.step_lock(72, 300_000.0, 150.0, MIN_JITTER_MS, true),
            LockReason::Held
        );
        assert_eq!(
            est.step_lock(72, 300_000.0, wide, MIN_JITTER_MS, true),
            LockReason::Held
        );
        assert_eq!(
            est.step_lock(72, 300_000.0, wide, MIN_JITTER_MS, true),
            LockReason::Unlocked
        );
        // Once dropped, the lock must be acquired again at the strict width.
        assert_eq!(
            est.step_lock(72, 300_000.0, 150.0, MIN_JITTER_MS, true),
            LockReason::Unlocked
        );
    }

    #[test]
    fn lock_drops_immediately_on_segment_break() {
        let mut gen = PollGen::new(21);
        let (mut est, estimates) = run(&mut gen, 6.0);
        assert!(estimates.last().unwrap().0.locked());
        est.clear();
        // The next estimate is judged as a fresh segment's: under the lock
        // span, it cannot be locked however narrow it is.
        gen.run_until(6.0 * 60_000.0 + 30_000.0, |p| est.add(p));
        let e = est
            .estimate(6.0 * 60_000.0 + 30_000.0, 0.0)
            .expect("estimate");
        assert_eq!(e.lock_reason, LockReason::Unlocked, "{e:?}");
    }

    #[test]
    fn too_few_polls_drops_the_lock() {
        let mut est = locked_estimator();
        let few = HOLD_MIN_POLLS - 1;
        assert_eq!(
            est.step_lock(few, 300_000.0, 80.0, MIN_JITTER_MS, true),
            LockReason::Held
        );
        assert_eq!(
            est.step_lock(few, 300_000.0, 80.0, MIN_JITTER_MS, true),
            LockReason::Unlocked
        );
    }

    #[test]
    fn acquiring_still_needs_the_strict_width() {
        let mut est = ReserveEstimator::new();
        let wider = LOCK_HALF_WIDTH_FLOOR_MS + 5.0;
        assert_eq!(
            est.step_lock(72, 300_000.0, wider, MIN_JITTER_MS, true),
            LockReason::Unlocked
        );
        assert_eq!(
            est.step_lock(72, LOCK_MIN_SPAN_MS - 1.0, 60.0, MIN_JITTER_MS, true),
            LockReason::Unlocked,
            "under the lock span"
        );
        assert_eq!(
            est.step_lock(72, 300_000.0, 60.0, MIN_JITTER_MS, false),
            LockReason::Unlocked,
            "too often inconsistent"
        );
        // Jitter still widens the acquire width, as before.
        assert_eq!(
            est.step_lock(72, 300_000.0, 140.0, 100.0, true),
            LockReason::Acquired
        );
    }

    #[test]
    fn swollen_jitter_does_not_widen_the_hold_gate() {
        // Locked at the minimum jitter; a window straddling a step then
        // swells the jitter to the maximum, which would let 300 ms acquire.
        let mut est = locked_estimator();
        let wide = HOLD_HALF_WIDTH_MS + 50.0;
        assert_eq!(
            est.step_lock(72, 300_000.0, wide, MAX_JITTER_MS, true),
            LockReason::Held
        );
        assert_eq!(
            est.step_lock(72, 300_000.0, wide, MAX_JITTER_MS, true),
            LockReason::Unlocked
        );
        // Nor can the swollen jitter make a held estimate tight: tight is
        // judged against the width frozen at the lock too.
        let mut est = locked_estimator();
        assert_eq!(
            est.step_lock(72, 300_000.0, 150.0, MAX_JITTER_MS, true),
            LockReason::Held
        );
    }

    #[test]
    fn a_lock_acquired_under_jitter_holds_to_its_own_acquire_width() {
        // Jitter of 150 ms acquired at 225 ms, above the absolute hold
        // width; the lock holds to that width however the jitter moves.
        let mut est = ReserveEstimator::new();
        assert_eq!(
            est.step_lock(72, 300_000.0, 220.0, 150.0, true),
            LockReason::Acquired
        );
        assert_eq!(
            est.step_lock(72, 300_000.0, 220.0, MIN_JITTER_MS, true),
            LockReason::Held
        );
        assert_eq!(est.held_fails(), 0);
    }

    #[test]
    fn losing_half_the_polls_keeps_lock_at_500ms_reserve() {
        for seed in 0..8 {
            let mut gen = PollGen::new(200 + seed);
            gen.start_ms = 500.0;
            gen.tick_jitter_ms = 50.0;
            let mut est = ReserveEstimator::new();
            let mut first_lock = None;
            let mut kept = 0usize;
            let mut t = 30_000.0;
            while t <= 30.0 * 60_000.0 {
                // From ten minutes on, every other answer is lost.
                gen.run_until(t, |p| {
                    kept += 1;
                    if p.ts < 10.0 * 60_000.0 || kept % 2 == 0 {
                        est.add(p);
                    }
                });
                if let Some(e) = est.estimate(t, 0.0) {
                    if e.locked() {
                        first_lock.get_or_insert(t);
                    } else if first_lock.is_some() {
                        panic!("seed {seed}: lock dropped at {t}: {e:?}");
                    }
                    if t >= 15.0 * 60_000.0 {
                        let truth = gen.reserve(t);
                        assert!(e.polls >= HOLD_MIN_POLLS, "{e:?}");
                        assert!(
                            (e.reserve_ms - truth).abs() <= e.half_width_ms,
                            "seed {seed}: {e:?} vs {truth:.0}"
                        );
                    }
                }
                t += 30_000.0;
            }
            assert!(
                first_lock.is_some_and(|at| at <= 5.0 * 60_000.0),
                "seed {seed}: locked at {first_lock:?}"
            );
        }
    }
}
