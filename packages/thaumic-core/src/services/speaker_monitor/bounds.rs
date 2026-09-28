//! Turns one position poll into bounds on the speaker's playhead and reserve.
//!
//! A Sonos speaker reports its playhead (`RelTime`) in whole seconds, and it
//! reads it at some unknown moment between our request and its answer. One
//! poll therefore pins the playhead only to within a second, but it pins it
//! *hard*: the playhead at that moment lies in `[r, r + 1000)` for a
//! truncating clock. Many polls whose phase against the speaker's second is
//! spread at random (the monitor dithers its polls for this) narrow the
//! intersection of those intervals far below a second, which is what the
//! [`super::reserve`] and [`super::clock_fit`] estimators exploit.
//!
//! Times here are plain milliseconds on one monotonic clock (the monitor uses
//! milliseconds since the connection was accepted), so the arithmetic can be
//! tested without real time passing.

/// Width of the speaker's `RelTime` quantum.
pub const RELTIME_QUANTUM_MS: f64 = 1000.0;

/// One answered position poll, bracketed by what we had delivered on either
/// side of it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PollObservation {
    /// When the request was sent.
    pub ts: f64,
    /// When the answer arrived. The speaker read its playhead somewhere in
    /// `[ts, tr]`.
    pub tr: f64,
    /// The playhead the speaker reported, in milliseconds (whole seconds in
    /// practice).
    pub rel_ms: u64,
    /// Milliseconds of audio handed to the connection when the request was
    /// sent. Zero for a compressed codec, whose reserve is not measured.
    pub d_ts_ms: f64,
    /// Milliseconds of audio handed to the connection when the answer
    /// arrived.
    pub d_tr_ms: f64,
}

/// An interval a quantity is known to lie in at one moment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlayheadBound {
    /// Lower bound.
    pub lo: f64,
    /// Upper bound.
    pub hi: f64,
    /// The moment the bound describes: the middle of the poll.
    pub at: f64,
}

impl PlayheadBound {
    /// The same bound, moved to `at` assuming the quantity changes at
    /// `rate` (ms per ms) meanwhile.
    pub fn shifted_to(&self, at: f64, rate: f64) -> Self {
        let delta = rate * (at - self.at);
        Self {
            lo: self.lo + delta,
            hi: self.hi + delta,
            at,
        }
    }
}

impl PollObservation {
    /// The middle of the poll, the moment its bounds describe.
    pub fn mid(&self) -> f64 {
        (self.ts + self.tr) / 2.0
    }

    /// Bounds on the reserve `R = D − P` (delivered minus played), not
    /// widened for jitter.
    ///
    /// At the moment `t*` the speaker read its playhead, `r ≤ P(t*) < r +
    /// 1000` and, since delivery only moves forward, `d_ts ≤ D(t*) ≤ d_tr`.
    /// So `d_ts − r − 1000 < R(t*) ≤ d_tr − r`. The reserve changes by
    /// microseconds over one round trip, so the bound is placed at the
    /// middle of the poll.
    pub fn reserve_bound(&self) -> PlayheadBound {
        let r = self.rel_ms as f64;
        PlayheadBound {
            lo: self.d_ts_ms - r - RELTIME_QUANTUM_MS,
            hi: self.d_tr_ms - r,
            at: self.mid(),
        }
    }

    /// Bounds on the playhead's offset from our clock, `θ = P(t) − t`, not
    /// widened for jitter.
    ///
    /// `P(t*) ∈ [r, r + 1000)` for some `t* ∈ [ts, tr]`, so `θ ∈ [r − tr,
    /// r + 1000 − ts]`. The slope of `θ` against `t` is how much faster the
    /// speaker plays than our clock runs. It is built from the speaker's
    /// playhead and our clock alone, so nothing we do to the delivered audio
    /// (inserting or removing samples) can bias it.
    pub fn offset_bound(&self) -> PlayheadBound {
        let r = self.rel_ms as f64;
        PlayheadBound {
            lo: r - self.tr,
            hi: r + RELTIME_QUANTUM_MS - self.ts,
            at: self.mid(),
        }
    }
}

/// The `k`th largest of `values` (1-based), or `None` if there are fewer
/// than `k`. Reorders `values`.
pub fn kth_largest(values: &mut [f64], k: usize) -> Option<f64> {
    if k == 0 || values.len() < k {
        return None;
    }
    let idx = values.len() - k;
    let (_, v, _) = values.select_nth_unstable_by(idx, f64::total_cmp);
    Some(*v)
}

/// The `k`th smallest of `values` (1-based), or `None` if there are fewer
/// than `k`. Reorders `values`.
pub fn kth_smallest(values: &mut [f64], k: usize) -> Option<f64> {
    if k == 0 || values.len() < k {
        return None;
    }
    let (_, v, _) = values.select_nth_unstable_by(k - 1, f64::total_cmp);
    Some(*v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poll(ts: f64, rtt: f64, rel_ms: u64, d_ts: f64, d_tr: f64) -> PollObservation {
        PollObservation {
            ts,
            tr: ts + rtt,
            rel_ms,
            d_ts_ms: d_ts,
            d_tr_ms: d_tr,
        }
    }

    #[test]
    fn the_reserve_bound_contains_the_true_reserve() {
        // Delivered 10 000 ms at send, 10 020 ms at answer; the speaker read
        // P = 9 400.7 ms at some point, reporting 9 000.
        let p = poll(50_000.0, 20.0, 9_000, 10_000.0, 10_020.0);
        let b = p.reserve_bound();
        assert_eq!(b.lo, 10_000.0 - 9_000.0 - 1000.0);
        assert_eq!(b.hi, 10_020.0 - 9_000.0);
        let true_reserve = 10_010.0 - 9_400.7;
        assert!(b.lo < true_reserve && true_reserve <= b.hi);
        assert_eq!(b.at, 50_010.0);
    }

    #[test]
    fn the_offset_bound_contains_the_true_offset() {
        let p = poll(50_000.0, 20.0, 9_000, 0.0, 0.0);
        let b = p.offset_bound();
        // Read at t* = 50 012 with P = 9 400.
        let theta = 9_400.0 - 50_012.0;
        assert!(b.lo <= theta && theta <= b.hi, "{b:?}");
    }

    #[test]
    fn a_bound_shifts_along_the_given_rate() {
        let b = PlayheadBound {
            lo: 0.0,
            hi: 10.0,
            at: 1_000.0,
        };
        let s = b.shifted_to(61_000.0, -40e-6);
        assert!((s.lo + 2.4).abs() < 1e-9 && (s.hi - 7.6).abs() < 1e-9);
        assert_eq!(s.at, 61_000.0);
    }

    #[test]
    fn order_statistics_pick_the_kth_extreme() {
        let mut v = vec![5.0, 1.0, 4.0, 2.0, 3.0];
        assert_eq!(kth_largest(&mut v, 1), Some(5.0));
        assert_eq!(kth_largest(&mut v, 3), Some(3.0));
        assert_eq!(kth_smallest(&mut v, 2), Some(2.0));
        assert_eq!(kth_smallest(&mut v, 6), None);
        assert_eq!(kth_largest(&mut v, 0), None);
    }
}
