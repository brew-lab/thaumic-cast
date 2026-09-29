//! Fractional resampling of one PCM connection, for clock drift correction.
//!
//! A speaker plays at its own sample clock. When that runs faster than the
//! clock we pace delivery by, the audio it holds in hand drains, a little
//! every minute (the Playbar in the field: about +20 ppm, 1.2 ms/min). A live
//! source cannot run ahead of real time, so the only way to hold that reserve
//! level is to hand the speaker slightly more samples than were captured (or
//! fewer, for a slow speaker). [`RateAdapter`] does that by resampling each
//! frame by a tiny ratio, `1 + ppm·10⁻⁶`, with a band-limited interpolator:
//! at 150 ppm it adds one sample in every 6 667, spread over all of them, so
//! nothing is ever dropped or repeated.
//!
//! The adapter is always engaged for the whole life of a connection it is
//! built for, even at 0 ppm, so its group delay is constant: it is paid once,
//! at connection start, and never steps. Nothing it does depends on where a
//! frame boundary falls, so frames of any size in any sequence give one
//! continuous output. A connection it is not built for keeps sending the
//! captured frames themselves, zero-copy.
//!
//! [`RateControl`] is where a drift controller leaves the command for one
//! connection, and where the cadence reports what the adapter has done.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

// Tokio's clock, which in production is the monotonic clock itself, so the
// watchdog can be tested (and simulated) on paused time.
use tokio::time::Instant;

use bytes::{BufMut, Bytes, BytesMut};

use super::{is_crossfade_compatible, AudioFormat};

/// Filter length in input samples. 16 taps would miss 70 dB at 15 kHz and
/// vary in treble response with the fractional phase; 32 does neither.
pub const RATE_ADAPTER_TAPS: usize = 32;

/// Fractional phases tabulated between two input samples. The filter for a
/// phase in between is linearly interpolated from its two neighbours.
pub const RATE_ADAPTER_PHASES: usize = 64;

/// Group delay of the adapter, in sample frames: each output sample is
/// centred this many input samples behind the newest one it uses. Paid once,
/// at connection start (0.33 ms at 48 kHz).
pub const RATE_ADAPTER_DELAY_FRAMES: usize = RATE_ADAPTER_TAPS / 2;

/// Largest rate change the adapter applies, in ppm either way. Commands
/// beyond it are clamped; the drift controller keeps well inside it.
pub const MAX_RATE_PPM: f64 = 300.0;

/// Kaiser window shape. At β = 9 the stopband sits near −90 dB.
const KAISER_BETA: f64 = 9.0;

/// Input samples kept from one call to the next: every tap but the newest.
const HISTORY_FRAMES: usize = RATE_ADAPTER_TAPS - 1;

/// Filter taps for every tabulated phase, row `p` for a fractional position
/// of `p / RATE_ADAPTER_PHASES`, with one extra row so phase `p + 1` always
/// exists. Built once per process and shared by every adapter.
static FILTER_TABLE: OnceLock<Vec<f32>> = OnceLock::new();

/// Zeroth-order modified Bessel function of the first kind, by its power
/// series; converges fast for the arguments a Kaiser window uses.
fn bessel_i0(x: f64) -> f64 {
    let quarter_x2 = x * x / 4.0;
    let mut term = 1.0;
    let mut sum = 1.0;
    let mut k = 1.0;
    while term > sum * 1e-17 {
        term *= quarter_x2 / (k * k);
        sum += term;
        k += 1.0;
    }
    sum
}

/// The windowed-sinc filter tabulated for every phase.
///
/// Tap `k` of row `p` weighs the input sample `k − 15` places from the one at
/// or before the output position, whose distance from it is
/// `k − 15 − p/64`. The sinc cuts off at Nyquist, so the taps are exactly
/// zero at whole-sample distances and phase 0 passes the input through
/// untouched. Each row is normalised to unit gain at DC.
fn filter_table() -> &'static [f32] {
    FILTER_TABLE.get_or_init(|| {
        let half = RATE_ADAPTER_DELAY_FRAMES as f64;
        let i0_beta = bessel_i0(KAISER_BETA);
        let mut table = vec![0.0f32; RATE_ADAPTER_TAPS * (RATE_ADAPTER_PHASES + 1)];
        for p in 0..=RATE_ADAPTER_PHASES {
            let mu = p as f64 / RATE_ADAPTER_PHASES as f64;
            let mut row = [0.0f64; RATE_ADAPTER_TAPS];
            for (k, tap) in row.iter_mut().enumerate() {
                let x = k as f64 - (half - 1.0) - mu;
                let sinc = if x == 0.0 {
                    1.0
                } else if x.fract() == 0.0 {
                    0.0
                } else {
                    let px = std::f64::consts::PI * x;
                    px.sin() / px
                };
                let r = x / half;
                let window = if r.abs() >= 1.0 {
                    0.0
                } else {
                    bessel_i0(KAISER_BETA * (1.0 - r * r).sqrt()) / i0_beta
                };
                *tap = sinc * window;
            }
            let gain: f64 = row.iter().sum();
            for (k, tap) in row.iter().enumerate() {
                table[p * RATE_ADAPTER_TAPS + k] = (tap / gain) as f32;
            }
        }
        table
    })
}

/// Per-connection fractional resampler for 16-bit PCM with at most two
/// channels.
///
/// Each call to [`RateAdapter::process`] resamples one frame by
/// `1 + ppm·10⁻⁶`: positive `ppm` makes the output longer than the input
/// (for a speaker that plays faster than we deliver), negative shorter. The
/// filter state carries from one frame to the next, so the output is the
/// same whatever the frame boundaries.
pub struct RateAdapter {
    /// Interleaved channel count, 1 or 2.
    channels: usize,
    /// Bytes per sample frame.
    block_align: usize,
    /// Input samples still needed, interleaved, starting with the history
    /// kept from earlier frames. Its capacity is reused from call to call.
    input: Vec<f32>,
    /// Position of the next output sample, in input sample frames from the
    /// start of `input`.
    position: f64,
    /// Output sample frames produced minus input sample frames consumed.
    net_frames: i64,
    /// Filter taps for the current output sample, reused.
    taps: [f32; RATE_ADAPTER_TAPS],
}

impl RateAdapter {
    /// Whether an adapter can be built for `fmt`: 16-bit PCM with one or
    /// two channels.
    pub fn supports(fmt: &AudioFormat) -> bool {
        is_crossfade_compatible(fmt) && fmt.channels > 0
    }

    /// An adapter for `fmt`, or `None` if it is not 16-bit PCM with one or
    /// two channels.
    pub fn new(fmt: &AudioFormat) -> Option<Self> {
        if !Self::supports(fmt) {
            return None;
        }
        let channels = usize::from(fmt.channels);
        let mut input = Vec::with_capacity(channels * (HISTORY_FRAMES + 2048));
        // The history starts silent, so the first output sample is centred
        // RATE_ADAPTER_DELAY_FRAMES before the first input sample.
        input.resize(channels * HISTORY_FRAMES, 0.0);
        Some(Self {
            channels,
            block_align: channels * 2,
            input,
            position: (RATE_ADAPTER_DELAY_FRAMES - 1) as f64,
            net_frames: 0,
            taps: [0.0; RATE_ADAPTER_TAPS],
        })
    }

    /// Resamples one frame at ratio `1 + ppm·10⁻⁶` and returns the output.
    ///
    /// `ppm` is clamped to ±[`MAX_RATE_PPM`], and anything not finite counts
    /// as 0. The output is a whole number of sample frames, within two of
    /// the input's length times the ratio; over many frames its total is the
    /// input's times the ratio, to within one sample frame. A trailing
    /// partial sample frame in `frame` (never produced by the cadence) is
    /// ignored.
    pub fn process(&mut self, frame: &[u8], ppm: f64) -> Bytes {
        debug_assert_eq!(
            frame.len() % self.block_align,
            0,
            "a PCM frame is a whole number of sample frames"
        );
        let ppm = if ppm.is_finite() {
            ppm.clamp(-MAX_RATE_PPM, MAX_RATE_PPM)
        } else {
            0.0
        };
        let step = 1.0 / (1.0 + ppm * 1e-6);

        let in_frames = frame.len() / self.block_align;
        self.input.extend(
            frame[..in_frames * self.block_align]
                .chunks_exact(2)
                .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]]))),
        );
        let available = self.input.len() / self.channels;

        let table = filter_table();
        let channels = self.channels;
        // Each output needs the input sample RATE_ADAPTER_DELAY_FRAMES after
        // the one at or before its position.
        let mut out = BytesMut::with_capacity((in_frames + 2) * self.block_align);
        let mut produced: i64 = 0;
        loop {
            let base = self.position.floor();
            let newest = base as usize + RATE_ADAPTER_DELAY_FRAMES;
            if newest >= available {
                break;
            }
            let phase = (self.position - base) * RATE_ADAPTER_PHASES as f64;
            let row = (phase as usize).min(RATE_ADAPTER_PHASES - 1);
            let weight = (phase - row as f64) as f32;
            let lower = &table[row * RATE_ADAPTER_TAPS..(row + 1) * RATE_ADAPTER_TAPS];
            let upper = &table[(row + 1) * RATE_ADAPTER_TAPS..(row + 2) * RATE_ADAPTER_TAPS];
            for ((tap, lo), hi) in self.taps.iter_mut().zip(lower).zip(upper) {
                *tap = lo + (hi - lo) * weight;
            }
            let first = (newest + 1 - RATE_ADAPTER_TAPS) * channels;
            for ch in 0..channels {
                let mut acc = 0.0f32;
                for (k, tap) in self.taps.iter().enumerate() {
                    acc += tap * self.input[first + k * channels + ch];
                }
                out.put_i16_le(acc.round().clamp(-32768.0, 32767.0) as i16);
            }
            produced += 1;
            self.position += step;
        }

        // Keep only what a later output can still use.
        let base = self.position.floor();
        let consumed = (base as usize + 1).saturating_sub(RATE_ADAPTER_DELAY_FRAMES);
        self.input.drain(..consumed * channels);
        self.position -= consumed as f64;
        self.net_frames += produced - in_frames as i64;

        debug_assert_eq!(out.len() % self.block_align, 0);
        out.freeze()
    }

    /// Net sample frames inserted (positive) or removed (negative) so far.
    pub fn net_frames(&self) -> i64 {
        self.net_frames
    }
}

/// Marks a [`RateControl`] command as never written.
const NEVER_WRITTEN: u64 = u64::MAX;

/// How long a command stands without being refreshed. The controller
/// rewrites it every monitor tick; one older than this means the monitor
/// has stopped, and the cadence treats it as 0.
pub const RATE_COMMAND_WATCHDOG: Duration = Duration::from_secs(30);

/// The rate command for one connection, and what its adapter has done.
///
/// Written by the drift controller on the main runtime and read once per
/// cadence tick on the streaming runtime, through plain atomics, so neither
/// side ever waits for the other.
pub struct RateControl {
    /// Origin of the command timestamps.
    origin: Instant,
    /// The command, in thousandths of a ppm.
    ppm_milli: AtomicI32,
    /// Milliseconds after `origin` the command was last written.
    written_at_ms: AtomicU64,
    /// Net sample frames the adapter has inserted (positive) or removed.
    net_inserted_frames: AtomicI64,
    /// Whether the cadence has pinned the adapter at 0 ppm because the net
    /// insertion passed its limit.
    pinned: AtomicBool,
    /// Whether the connection's cadence built an adapter that follows this
    /// control.
    engaged: AtomicBool,
    /// A command fixed for the connection's life, in thousandths of a ppm,
    /// for listening tests (see [`Self::forced`]): no controller write
    /// changes it and the watchdog never lapses it.
    forced_ppm_milli: Option<i32>,
}

impl Default for RateControl {
    fn default() -> Self {
        Self::new()
    }
}

impl RateControl {
    /// A control with no command written, which reads as 0 ppm.
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
            ppm_milli: AtomicI32::new(0),
            written_at_ms: AtomicU64::new(NEVER_WRITTEN),
            net_inserted_frames: AtomicI64::new(0),
            pinned: AtomicBool::new(false),
            engaged: AtomicBool::new(false),
            forced_ppm_milli: None,
        }
    }

    /// A control whose command is fixed at `ppm` (clamped to
    /// ±[`MAX_RATE_PPM`], anything not finite counting as 0) for the
    /// connection's life, whatever a controller writes and however long ago:
    /// for listening tests only. The net-insertion guard still applies.
    pub fn forced(ppm: f64) -> Self {
        let ppm = if ppm.is_finite() {
            ppm.clamp(-MAX_RATE_PPM, MAX_RATE_PPM)
        } else {
            0.0
        };
        Self {
            forced_ppm_milli: Some((ppm * 1000.0).round() as i32),
            ..Self::new()
        }
    }

    /// The fixed command of a [`Self::forced`] control, in ppm.
    pub fn forced_ppm(&self) -> Option<f64> {
        self.forced_ppm_milli.map(|m| f64::from(m) / 1000.0)
    }

    /// Sets the command to `ppm` (clamped to ±[`MAX_RATE_PPM`]) and marks
    /// it fresh. A controller calls this on every tick, changed or not, to
    /// keep the watchdog from expiring it.
    pub fn set_ppm(&self, ppm: f64) {
        self.set_ppm_at(ppm, Instant::now());
    }

    fn set_ppm_at(&self, ppm: f64, now: Instant) {
        if self.forced_ppm_milli.is_some() {
            return;
        }
        let ppm = if ppm.is_finite() {
            ppm.clamp(-MAX_RATE_PPM, MAX_RATE_PPM)
        } else {
            0.0
        };
        let at = now.saturating_duration_since(self.origin).as_millis() as u64;
        self.ppm_milli
            .store((ppm * 1000.0).round() as i32, Ordering::Relaxed);
        self.written_at_ms
            .store(at.min(NEVER_WRITTEN - 1), Ordering::Relaxed);
    }

    /// The command in force now: the fixed one of a [`Self::forced`]
    /// control, else 0 if none was ever written or the last one is older
    /// than [`RATE_COMMAND_WATCHDOG`].
    pub fn command_ppm(&self) -> f64 {
        self.command_ppm_at(Instant::now())
    }

    fn command_ppm_at(&self, now: Instant) -> f64 {
        if let Some(forced) = self.forced_ppm() {
            return forced;
        }
        if self.written_at_ms.load(Ordering::Relaxed) == NEVER_WRITTEN
            || self.watchdog_lapsed_at(now)
        {
            return 0.0;
        }
        f64::from(self.ppm_milli.load(Ordering::Relaxed)) / 1000.0
    }

    /// Net sample frames the connection's adapter has inserted (positive)
    /// or removed (negative) so far.
    pub fn net_inserted_frames(&self) -> i64 {
        self.net_inserted_frames.load(Ordering::Relaxed)
    }

    pub(crate) fn publish_net_frames(&self, frames: i64) {
        self.net_inserted_frames.store(frames, Ordering::Relaxed);
    }

    /// Whether the cadence has stopped following the command on this
    /// connection, because the audio inserted or removed passed its limit.
    /// The adapter stays engaged at 0 ppm, so the output stays continuous.
    pub fn is_pinned(&self) -> bool {
        self.pinned.load(Ordering::Relaxed)
    }

    pub(crate) fn pin(&self) {
        self.pinned.store(true, Ordering::Relaxed);
    }

    /// Whether the connection's cadence built an adapter that follows this
    /// control. False until the cadence body is built, and for good if the
    /// format could not be resampled.
    pub fn is_engaged(&self) -> bool {
        self.engaged.load(Ordering::Relaxed)
    }

    pub(crate) fn mark_engaged(&self) {
        self.engaged.store(true, Ordering::Relaxed);
    }

    /// Whether the command is being followed right now: the adapter is
    /// engaged, not pinned at 0 ppm, and the command has been refreshed
    /// within [`RATE_COMMAND_WATCHDOG`] (a command never written counts as
    /// refreshed, since it reads as 0 anyway).
    pub fn is_following(&self) -> bool {
        self.is_engaged() && !self.is_pinned() && !self.watchdog_lapsed_at(Instant::now())
    }

    fn watchdog_lapsed_at(&self, now: Instant) -> bool {
        if self.forced_ppm_milli.is_some() {
            return false;
        }
        let written = self.written_at_ms.load(Ordering::Relaxed);
        if written == NEVER_WRITTEN {
            return false;
        }
        let now_ms = now.saturating_duration_since(self.origin).as_millis() as u64;
        now_ms.saturating_sub(written) > RATE_COMMAND_WATCHDOG.as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    const RATE: f64 = 48_000.0;

    fn stereo() -> AudioFormat {
        AudioFormat::new(48_000, 2, 16)
    }

    /// Deterministic pseudo-random numbers for the property tests.
    struct SplitMix(u64);

    impl SplitMix {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    fn encode(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn decode(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    }

    /// A stereo signal, one closure value per sample frame, quantised to
    /// 16 bits; both channels carry it, the right one inverted.
    fn stereo_signal(frames: usize, f: impl Fn(f64) -> f64) -> Vec<i16> {
        (0..frames)
            .flat_map(|n| {
                let v = f(n as f64).round().clamp(-32768.0, 32767.0) as i16;
                [v, v.saturating_neg()]
            })
            .collect()
    }

    /// Runs `input` (interleaved stereo) through a fresh adapter in frames of
    /// `frame_frames` sample frames, with the command `ppm_at(frame index)`,
    /// and returns the output with each output sample's position in input
    /// sample frames (the ideal time it represents).
    fn run(
        input: &[i16],
        frame_frames: usize,
        ppm_at: impl Fn(usize) -> f64,
    ) -> (Vec<i16>, Vec<f64>) {
        let mut adapter = RateAdapter::new(&stereo()).unwrap();
        let mut out = Vec::new();
        let mut times = Vec::new();
        let mut t = -(RATE_ADAPTER_DELAY_FRAMES as f64);
        for (i, chunk) in input.chunks(frame_frames * 2).enumerate() {
            let ppm = ppm_at(i);
            let produced = decode(&adapter.process(&encode(chunk), ppm));
            let step = 1.0 / (1.0 + ppm * 1e-6);
            for _ in 0..produced.len() / 2 {
                times.push(t);
                t += step;
            }
            out.extend(produced);
        }
        (out, times)
    }

    /// Signal-to-noise ratio in dB of the left channel of `out` against
    /// `ideal` evaluated at each output's position, skipping the start-up.
    fn snr_db(out: &[i16], times: &[f64], ideal: impl Fn(f64) -> f64) -> f64 {
        let (mut signal, mut noise) = (0.0, 0.0);
        for (i, &t) in times.iter().enumerate().skip(4 * RATE_ADAPTER_TAPS) {
            let want = ideal(t);
            let err = f64::from(out[2 * i]) - want;
            signal += want * want;
            noise += err * err;
        }
        10.0 * (signal / noise).log10()
    }

    fn sine(freq: f64, amplitude: f64) -> impl Fn(f64) -> f64 {
        move |t: f64| amplitude * (2.0 * PI * freq * t / RATE).sin()
    }

    #[test]
    fn only_16_bit_mono_or_stereo_gets_an_adapter() {
        assert!(RateAdapter::new(&AudioFormat::new(48_000, 2, 16)).is_some());
        assert!(RateAdapter::new(&AudioFormat::new(44_100, 1, 16)).is_some());
        assert!(RateAdapter::new(&AudioFormat::new(48_000, 2, 24)).is_none());
        assert!(RateAdapter::new(&AudioFormat::new(48_000, 6, 16)).is_none());
        assert!(RateAdapter::new(&AudioFormat::new(48_000, 0, 16)).is_none());
    }

    #[test]
    fn output_is_whole_sample_frames_for_any_command_and_frame_size() {
        let mut rng = SplitMix(0x5EED);
        for format in [
            AudioFormat::new(48_000, 2, 16),
            AudioFormat::new(48_000, 1, 16),
        ] {
            let block = usize::from(format.channels) * 2;
            let mut adapter = RateAdapter::new(&format).unwrap();
            let (mut total_in, mut total_out) = (0i64, 0i64);
            for _ in 0..5_000 {
                let frames = rng.below(2_000) as usize;
                let ppm = (rng.unit() * 2.0 - 1.0) * 400.0;
                let bytes: Vec<u8> = (0..frames * block).map(|_| rng.next() as u8).collect();
                let out = adapter.process(&bytes, ppm);
                assert_eq!(out.len() % block, 0, "{frames} frames at {ppm} ppm");
                let expected = frames as f64 * (1.0 + ppm.clamp(-300.0, 300.0) * 1e-6);
                assert!(
                    ((out.len() / block) as f64 - expected).abs() <= 2.0,
                    "{} out for {frames} in at {ppm} ppm",
                    out.len() / block
                );
                total_in += frames as i64;
                total_out += (out.len() / block) as i64;
            }
            assert_eq!(adapter.net_frames(), total_out - total_in);
        }
    }

    #[test]
    fn net_frames_follow_the_integral_of_the_command() {
        let mut rng = SplitMix(42);
        let mut adapter = RateAdapter::new(&stereo()).unwrap();
        let (mut fed, mut integral) = (0usize, 0.0f64);
        let mut ppm = 0.0;
        while fed < 1_000_000 {
            if rng.below(8) == 0 {
                ppm = (rng.unit() * 2.0 - 1.0) * 300.0;
            }
            let frames = 1 + rng.below(960) as usize;
            let silence = vec![0u8; frames * 4];
            adapter.process(&silence, ppm);
            integral += frames as f64 * ppm * 1e-6;
            fed += frames;
            assert!(
                (adapter.net_frames() as f64 - integral).abs() <= 1.0,
                "net {} against ∫u {integral:.3} after {fed} frames",
                adapter.net_frames()
            );
        }
        // A constant +300 ppm over the same length inserts 300 frames.
        let mut adapter = RateAdapter::new(&stereo()).unwrap();
        for _ in 0..1_000_000 / 480 {
            adapter.process(&[0u8; 480 * 4], 300.0);
        }
        let expected = (1_000_000 / 480 * 480) as f64 * 300e-6;
        assert!((adapter.net_frames() as f64 - expected).abs() <= 1.0);
    }

    #[test]
    fn a_1khz_sine_at_plus_300ppm_matches_an_ideal_resample_to_90db() {
        let wave = sine(1_000.0, 0.9 * 32_767.0);
        let input = stereo_signal(96_000, &wave);
        let (out, times) = run(&input, 480, |_| 300.0);
        let snr = snr_db(&out, &times, &wave);
        assert!(snr >= 90.0, "1 kHz SNR {snr:.1} dB");
    }

    #[test]
    fn a_15khz_sine_at_plus_300ppm_matches_an_ideal_resample_to_70db() {
        let wave = sine(15_000.0, 0.9 * 32_767.0);
        let input = stereo_signal(96_000, &wave);
        let (out, times) = run(&input, 480, |_| 300.0);
        let snr = snr_db(&out, &times, &wave);
        assert!(snr >= 70.0, "15 kHz SNR {snr:.1} dB");
    }

    #[test]
    fn removing_audio_is_as_clean_as_inserting_it() {
        let wave = sine(15_000.0, 0.9 * 32_767.0);
        let input = stereo_signal(96_000, &wave);
        let (out, times) = run(&input, 480, |_| -300.0);
        let snr = snr_db(&out, &times, &wave);
        assert!(snr >= 70.0, "15 kHz SNR at −300 ppm {snr:.1} dB");
    }

    /// The largest second difference of the left channel, which a click or a
    /// dropped or repeated sample shows up in at once.
    fn max_second_difference(samples: &[i16], skip: usize) -> f64 {
        samples
            .iter()
            .step_by(2)
            .skip(skip)
            .map(|&s| f64::from(s))
            .collect::<Vec<_>>()
            .windows(3)
            .map(|w| (w[2] - 2.0 * w[1] + w[0]).abs())
            .fold(0.0, f64::max)
    }

    #[test]
    fn command_changes_leave_no_transient() {
        let chord = |t: f64| {
            let s = |f: f64| (2.0 * PI * f * t / RATE).sin();
            0.3 * 32_767.0 * (s(1_000.0) + s(8_000.0) + s(15_000.0))
        };
        let input = stereo_signal(48_000 * 4, chord);
        // One second at each command: 0, 40, 150 then back to 0 ppm.
        let schedule = |frame: usize| [0.0, 40.0, 150.0, 0.0][(frame / 100).min(3)];
        let (out, times) = run(&input, 480, schedule);
        let input_d2 = max_second_difference(&input, 0);
        let out_d2 = max_second_difference(&out, 4 * RATE_ADAPTER_TAPS);
        assert!(
            out_d2 <= 1.1 * input_d2,
            "output Δ² {out_d2:.0} against input Δ² {input_d2:.0}"
        );
        let snr = snr_db(&out, &times, chord);
        assert!(snr >= 70.0, "chord SNR across command changes {snr:.1} dB");
    }

    #[test]
    fn frame_boundaries_do_not_change_the_output() {
        let wave = sine(3_000.0, 20_000.0);
        let input = stereo_signal(20_000, &wave);
        let (whole, _) = run(&input, 20_000, |_| 120.0);
        let mut rng = SplitMix(7);
        let mut adapter = RateAdapter::new(&stereo()).unwrap();
        let mut pieces = Vec::new();
        let mut rest = &input[..];
        while !rest.is_empty() {
            let take = ((1 + rng.below(700)) as usize * 2).min(rest.len());
            pieces.extend(decode(&adapter.process(&encode(&rest[..take]), 120.0)));
            rest = &rest[take..];
        }
        assert_eq!(pieces.len(), whole.len());
        let worst = pieces
            .iter()
            .zip(&whole)
            .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
            .max()
            .unwrap();
        assert!(worst <= 1, "frame splits moved a sample by {worst} LSB");
    }

    #[test]
    fn at_0ppm_the_output_is_the_input_delayed_16_samples() {
        let mut rng = SplitMix(99);
        let input: Vec<i16> = (0..2 * 48_000).map(|_| rng.next() as i16).collect();
        let (out, _) = run(&input, 480, |_| 0.0);
        assert_eq!(out.len(), input.len(), "nothing inserted or removed");
        let delay = 2 * RATE_ADAPTER_DELAY_FRAMES;
        assert!(
            out[..delay].iter().all(|&s| s == 0),
            "the delay starts silent"
        );
        let residual: f64 = out[delay..]
            .iter()
            .zip(&input)
            .map(|(a, b)| (f64::from(*a) - f64::from(*b)).powi(2))
            .sum::<f64>()
            / (out.len() - delay) as f64;
        let residual_dbfs = 10.0 * (residual.max(1e-30) / (32_768.0f64 * 32_768.0)).log10();
        assert!(
            residual_dbfs <= -90.0,
            "null residual {residual_dbfs:.1} dBFS"
        );
        assert_eq!(&out[delay..], &input[..input.len() - delay]);
    }

    #[test]
    fn a_fractional_delay_left_by_an_earlier_command_nulls_below_90dbfs() {
        // 4.5 s at +300 ppm leaves the phase part-way between samples; from
        // then on, at 0 ppm, the output is the input delayed by a constant
        // fraction, and must match that ideal delay.
        let wave = |t: f64| {
            let s = |f: f64, a: f64| a * (2.0 * PI * f * t / RATE).sin();
            s(440.0, 9_000.0) + s(2_500.0, 6_000.0) + s(7_000.0, 3_000.0)
        };
        let input = stereo_signal(48_000 * 8, wave);
        let (out, times) = run(&input, 480, |frame| if frame < 450 { 300.0 } else { 0.0 });
        let start = times.iter().position(|&t| t > 48_000.0 * 6.0).unwrap();
        let fraction = times[start].fract();
        assert!(fraction > 0.01 && fraction < 0.99, "phase {fraction}");
        let residual: f64 = times[start..]
            .iter()
            .enumerate()
            .map(|(i, &t)| (f64::from(out[2 * (start + i)]) - wave(t)).powi(2))
            .sum::<f64>()
            / (times.len() - start) as f64;
        let residual_dbfs = 10.0 * (residual / (32_768.0f64 * 32_768.0)).log10();
        assert!(residual_dbfs <= -90.0, "residual {residual_dbfs:.1} dBFS");
    }

    /// Gain in dB of the taps `row`, spaced `spacing` input samples apart,
    /// at `freq` Hz.
    fn gain_db(row: &[f32], spacing: f64, freq: f64) -> f64 {
        let w = 2.0 * PI * freq / RATE * spacing;
        let (re, im) = row
            .iter()
            .enumerate()
            .fold((0.0, 0.0), |(re, im), (k, &tap)| {
                let a = w * k as f64;
                (re + f64::from(tap) * a.cos(), im - f64::from(tap) * a.sin())
            });
        10.0 * (re * re + im * im).log10()
    }

    #[test]
    fn the_passband_is_flat_to_18khz_at_every_phase() {
        let table = filter_table();
        for p in 0..=RATE_ADAPTER_PHASES {
            let row = &table[p * RATE_ADAPTER_TAPS..(p + 1) * RATE_ADAPTER_TAPS];
            for f in (0..=18_000).step_by(250) {
                let db = gain_db(row, 1.0, f as f64);
                assert!(db.abs() <= 0.1, "phase {p}/64 at {f} Hz: {db:.3} dB");
            }
        }
    }

    /// The whole filter, every phase interleaved in order of position, is
    /// the prototype sampled 64 times per input sample. Whatever it passes
    /// above 30 kHz (the image of 18 kHz) folds back into the audio as the
    /// resampling ratio moves, so it must be 90 dB down.
    #[test]
    fn images_above_30khz_are_rejected_by_90db() {
        let table = filter_table();
        // Position (k − 15 − p/64) in 64ths, from −16 up to +16.
        let mut prototype = vec![0.0f32; RATE_ADAPTER_TAPS * RATE_ADAPTER_PHASES + 1];
        for p in 0..RATE_ADAPTER_PHASES {
            for k in 0..RATE_ADAPTER_TAPS {
                let index = k * RATE_ADAPTER_PHASES + RATE_ADAPTER_PHASES - p;
                prototype[index] = table[p * RATE_ADAPTER_TAPS + k] / RATE_ADAPTER_PHASES as f32;
            }
        }
        let spacing = 1.0 / RATE_ADAPTER_PHASES as f64;
        let dc = gain_db(&prototype, spacing, 0.0);
        for f in (30_000..=400_000).step_by(100) {
            let db = gain_db(&prototype, spacing, f as f64) - dc;
            assert!(db <= -90.0, "{f} Hz passes at {db:.1} dB");
        }
    }

    #[test]
    fn phase_zero_is_a_pure_pass_through() {
        let table = filter_table();
        let centre = RATE_ADAPTER_DELAY_FRAMES - 1;
        for (k, &tap) in table[..RATE_ADAPTER_TAPS].iter().enumerate() {
            assert_eq!(tap, if k == centre { 1.0 } else { 0.0 });
        }
        let last = &table[RATE_ADAPTER_PHASES * RATE_ADAPTER_TAPS..];
        for (k, &tap) in last.iter().enumerate() {
            assert_eq!(tap, if k == centre + 1 { 1.0 } else { 0.0 });
        }
    }

    #[test]
    fn commands_are_clamped_and_expire() {
        let control = RateControl::new();
        let t0 = Instant::now();
        assert_eq!(control.command_ppm_at(t0), 0.0, "never written");
        control.set_ppm_at(40.5, t0);
        assert_eq!(control.command_ppm_at(t0 + Duration::from_secs(29)), 40.5);
        assert_eq!(
            control.command_ppm_at(t0 + Duration::from_secs(31)),
            0.0,
            "a command the monitor stopped refreshing lapses to 0"
        );
        control.set_ppm_at(1_000.0, t0 + Duration::from_secs(31));
        assert_eq!(
            control.command_ppm_at(t0 + Duration::from_secs(31)),
            MAX_RATE_PPM
        );
        control.set_ppm_at(f64::NAN, t0 + Duration::from_secs(31));
        assert_eq!(control.command_ppm_at(t0 + Duration::from_secs(31)), 0.0);
    }

    #[test]
    fn a_forced_command_ignores_writes_and_never_lapses() {
        let control = RateControl::forced(-150.0);
        let t0 = Instant::now();
        assert_eq!(control.forced_ppm(), Some(-150.0));
        assert_eq!(control.command_ppm_at(t0), -150.0);
        control.set_ppm_at(20.0, t0);
        assert_eq!(
            control.command_ppm_at(t0),
            -150.0,
            "a controller cannot move it"
        );
        assert_eq!(
            control.command_ppm_at(t0 + Duration::from_secs(3_600)),
            -150.0
        );
        control.mark_engaged();
        assert!(control.is_following());
        assert_eq!(RateControl::new().forced_ppm(), None);
        assert_eq!(
            RateControl::forced(1_000.0).forced_ppm(),
            Some(MAX_RATE_PPM)
        );
    }

    #[test]
    fn out_of_range_commands_are_clamped_by_the_adapter() {
        let mut a = RateAdapter::new(&stereo()).unwrap();
        let mut b = RateAdapter::new(&stereo()).unwrap();
        for _ in 0..1_000 {
            let x = a.process(&[0u8; 480 * 4], 10_000.0);
            let y = b.process(&[0u8; 480 * 4], MAX_RATE_PPM);
            assert_eq!(x.len(), y.len());
        }
        assert_eq!(a.net_frames(), b.net_frames());
        let mut c = RateAdapter::new(&stereo()).unwrap();
        assert_eq!(c.process(&[0u8; 480 * 4], f64::NAN).len(), 480 * 4);
    }
}
