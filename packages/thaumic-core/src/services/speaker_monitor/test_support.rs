//! An analytic speaker for the estimator tests: exact playhead and delivery
//! as functions of time, polled the way the monitor polls.

use super::bounds::PollObservation;

/// Small deterministic generator, so every test is repeatable.
#[derive(Debug, Clone)]
pub(crate) struct Lcg(u64);

impl Lcg {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed ^ 0x2545_f491_4f6c_dd1d)
    }

    /// Uniform in `[0, 1)`.
    pub(crate) fn unit(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in `[lo, hi)`.
    pub(crate) fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
}

/// A speaker whose playhead and our delivery are exact functions of time.
///
/// Delivery runs at our clock in whole 10 ms frames from `t = 0`; the
/// speaker starts playing at `start_ms` and plays at `1 + ppm·1e-6` of our
/// clock, so its reserve starts at about `start_ms` and changes by `−ppm`
/// microseconds per millisecond. It is polled every two seconds plus up to a
/// second of dither, each poll taking a random round trip and reading the
/// playhead at a random moment inside it.
#[derive(Debug, Clone)]
pub(crate) struct PollGen {
    /// How much faster the speaker plays than our clock runs.
    pub ppm: f64,
    /// When the speaker starts playing (its initial reserve).
    pub start_ms: f64,
    /// Round trip of each poll, drawn uniformly from this range.
    pub rtt_ms: (f64, f64),
    /// Uniform jitter, ± this, on the moment the speaker's reported second
    /// ticks over.
    pub tick_jitter_ms: f64,
    /// Whether the speaker rounds its playhead instead of truncating it.
    pub round: bool,
    /// Audio inserted into the delivered stream per millisecond, as a drift
    /// compensator would (the speaker plays it too, from its own clock).
    pub inserted_per_ms: f64,
    /// Playhead jumps: at each time, the playhead moves by the amount (an
    /// underrun stalls it, which is a negative jump).
    pub steps: Vec<(f64, f64)>,
    /// Outlier answers: poll indices whose reported second is off by the
    /// given amount.
    pub outliers: Vec<(usize, i64)>,
    rng: Lcg,
    next_at: f64,
    index: usize,
}

impl PollGen {
    pub(crate) fn new(seed: u64) -> Self {
        Self {
            ppm: 0.0,
            start_ms: 600.0,
            rtt_ms: (5.0, 40.0),
            tick_jitter_ms: 0.0,
            round: false,
            inserted_per_ms: 0.0,
            steps: Vec::new(),
            outliers: Vec::new(),
            rng: Lcg::new(seed),
            next_at: 5_000.0,
            index: 0,
        }
    }

    /// Audio handed over by `t`.
    pub(crate) fn delivered(&self, t: f64) -> f64 {
        (t / 10.0).floor() * 10.0 + self.inserted_per_ms * t
    }

    /// The speaker's true playhead at `t`.
    pub(crate) fn playhead(&self, t: f64) -> f64 {
        let base = (t - self.start_ms).max(0.0) * (1.0 + self.ppm * 1e-6);
        let stepped: f64 = self
            .steps
            .iter()
            .filter(|(at, _)| *at <= t)
            .map(|(_, d)| *d)
            .sum();
        (base + stepped).max(0.0)
    }

    /// The true reserve at `t`.
    pub(crate) fn reserve(&self, t: f64) -> f64 {
        self.delivered(t) - self.playhead(t)
    }

    /// The next poll and when it was taken.
    pub(crate) fn next_poll(&mut self) -> PollObservation {
        let ts = self.next_at;
        let rtt = self.rng.range(self.rtt_ms.0, self.rtt_ms.1);
        let read_at = ts + self.rng.unit() * rtt;
        let jitter = self.rng.range(
            -self.tick_jitter_ms,
            self.tick_jitter_ms.max(f64::MIN_POSITIVE),
        );
        let p = self.playhead(read_at) + jitter;
        let mut seconds = if self.round {
            (p / 1000.0).round()
        } else {
            (p / 1000.0).floor()
        }
        .max(0.0) as i64;
        if let Some((_, off)) = self.outliers.iter().find(|(i, _)| *i == self.index) {
            seconds = (seconds + off).max(0);
        }
        self.index += 1;
        self.next_at = ts + 2000.0 + self.rng.unit() * 1000.0;
        PollObservation {
            ts,
            tr: ts + rtt,
            rel_ms: seconds as u64 * 1000,
            d_ts_ms: self.delivered(ts),
            d_tr_ms: self.delivered(ts + rtt),
        }
    }

    /// Polls until `until`, handing each poll to `f`.
    pub(crate) fn run_until(&mut self, until: f64, mut f: impl FnMut(&PollObservation)) {
        while self.next_at <= until {
            let p = self.next_poll();
            f(&p);
        }
    }
}
