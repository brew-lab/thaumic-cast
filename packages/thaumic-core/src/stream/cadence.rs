//! Fixed-cadence audio streaming for PCM.
//!
//! This module contains the cadence streaming pipeline that maintains real-time
//! audio output regardless of input timing, and the statistics of the playout
//! it feeds. The delivery tracking guard that logs each connection's lifecycle
//! and timing diagnostics, for every codec, is in [`super::delivery`].

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use tokio::sync::broadcast;
use tokio::time::{interval, Instant as TokioInstant, MissedTickBehavior};

pub use crate::model::head_start::{
    parse_pcm_connect_burst_ms, pcm_connect_burst_ms, PCM_CONNECT_BURST_ENV,
};

#[cfg(test)]
pub(crate) use super::delivery::end_suffix;
use super::delivery::{
    CadenceWindow, ConnBinding, DeliveryWindow, PipelineSnapshot, ReceiveWindow,
    MAX_PIPELINE_SNAPSHOTS,
};
pub(crate) use super::delivery::{EpochHook, LoggingStreamGuard, PipelineSample};
use super::manager::TimestampedFrame;
use super::rate_adapter::{RateAdapter, RateControl};
use super::{
    apply_fade_in, create_fade_out_frame, crossfade_samples, extract_last_sample_pair,
    is_crossfade_compatible, AudioFormat, StreamState,
};

/// Logs a rate-limited warning when the broadcast receiver lags.
fn log_lagged(n: u64, last_log: &mut Option<TokioInstant>, context: &str) {
    let now = TokioInstant::now();
    if last_log.map_or(true, |t| now.duration_since(t).as_secs() >= 1) {
        log::warn!("[Stream] Lagged by {n} frames{context}");
        *last_log = Some(now);
    }
}

/// Counters from the cadence stream: kept for the whole playout by its
/// [`ChainStats`], and reported per connection as what changed while that
/// connection was served (see [`CadenceStats::since`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CadenceStats {
    /// Number of times silence mode was entered.
    pub silence_events: u64,
    /// Total silence frames injected.
    pub silence_frames: u64,
    /// Frames dropped due to cadence queue overflow.
    pub frames_dropped: u64,
    /// Times playback was held after an underrun until the queue refilled.
    pub rebuffer_events: u64,
}

impl CadenceStats {
    /// What the counters gained since `base` was taken.
    #[must_use]
    pub(crate) fn since(self, base: Self) -> Self {
        Self {
            silence_events: self.silence_events.saturating_sub(base.silence_events),
            silence_frames: self.silence_frames.saturating_sub(base.silence_frames),
            frames_dropped: self.frames_dropped.saturating_sub(base.frames_dropped),
            rebuffer_events: self.rebuffer_events.saturating_sub(base.rebuffer_events),
        }
    }
}

/// Statistics of one playout: everything about a speaker's audio that
/// outlives the HTTP connection it is carried on.
///
/// A PCM cast is played as a sequence of segments, each on its own
/// connection, from one cadence (see [`crate::stream::playout`]). What
/// belongs to that cadence and to the speaker behind it lives here, once:
/// the output position the speaker has been handed, the cadence counters,
/// the pipeline timeline, the speaker monitor's latest figures and where the
/// cadence reports audio reaching this machine late. What belongs to one
/// connection (its TCP link, its wire bytes, why it ended, its summary line)
/// stays on that connection's [`LoggingStreamGuard`], and the guard of the
/// connection being served is found here through [`Self::current_connection`].
///
/// A connection that carries no playout of its own (a compressed codec) is
/// given one of these too, with itself as the only connection (see
/// [`Self::for_connection`]), so the speaker monitor reads every connection
/// the same way.
pub struct ChainStats {
    stream_id: String,
    /// The speaker's address.
    pub(crate) client_ip: IpAddr,
    /// When the playout started: the origin of the pipeline timeline.
    reference_time: Instant,
    /// Output data bytes handed over up to the end of the last one given to
    /// a connection (see [`Self::set_position`]): the delivered side of the
    /// speaker's reserve.
    position: AtomicU64,
    /// For a playout that is no more than its one connection: the bytes that
    /// connection sends before its audio, its position then being read from
    /// its body count (see [`Self::for_connection`]).
    follows_connection: Option<u64>,
    /// The speaker monitor's latest figures for this playout.
    pub(crate) speaker: super::tap::SpeakerCell,
    /// Pipeline timeline, updated every 50 cadence ticks.
    pipeline_timeline: parking_lot::Mutex<VecDeque<PipelineSnapshot>>,
    /// Where the cadence reports audio reaching this machine late (see
    /// [`crate::stream::ingest_gaps`]). `None` reports nothing.
    events: Option<Arc<dyn crate::events::EventEmitter>>,
    silence_events: AtomicU64,
    silence_frames: AtomicU64,
    frames_dropped: AtomicU64,
    rebuffer_events: AtomicU64,
    /// The connection being served, held weakly: it belongs to its response
    /// body.
    connection: parking_lot::RwLock<std::sync::Weak<LoggingStreamGuard>>,
    /// Bumped each time another connection starts being served, so the
    /// cadence can tell its delivery counters apart.
    connection_seq: AtomicU64,
    /// What the playout says about its segments, for the speaker monitor.
    pub(crate) playout: super::playout::PlayoutView,
}

impl ChainStats {
    /// Statistics for a new playout to `client_ip` on `stream_id`.
    pub fn new(stream_id: impl Into<String>, client_ip: IpAddr) -> Self {
        Self {
            stream_id: stream_id.into(),
            client_ip,
            reference_time: Instant::now(),
            position: AtomicU64::new(0),
            follows_connection: None,
            speaker: super::tap::SpeakerCell::default(),
            pipeline_timeline: parking_lot::Mutex::new(VecDeque::new()),
            events: None,
            silence_events: AtomicU64::new(0),
            silence_frames: AtomicU64::new(0),
            frames_dropped: AtomicU64::new(0),
            rebuffer_events: AtomicU64::new(0),
            connection: parking_lot::RwLock::new(std::sync::Weak::new()),
            connection_seq: AtomicU64::new(0),
            playout: super::playout::PlayoutView::default(),
        }
    }

    /// Statistics whose only connection is `guard`, for a connection that
    /// carries no playout beyond itself: its position is the audio its body
    /// has handed over, after the first `header_bytes`.
    pub fn for_connection(
        stream_id: impl Into<String>,
        guard: &Arc<LoggingStreamGuard>,
        header_bytes: u32,
    ) -> Arc<Self> {
        Self::new(stream_id, guard.client_ip).following(guard, header_bytes)
    }

    /// These statistics, with `guard` as their only connection (see
    /// [`Self::for_connection`]).
    pub fn following(mut self, guard: &Arc<LoggingStreamGuard>, header_bytes: u32) -> Arc<Self> {
        self.follows_connection = Some(u64::from(header_bytes));
        let stats = Arc::new(self);
        stats.attach_connection(guard);
        stats
    }

    /// Attaches the emitter the cadence reports audio reaching this machine
    /// late to, as a stream event for the stream's owner.
    #[must_use]
    pub fn with_events(mut self, emitter: Arc<dyn crate::events::EventEmitter>) -> Self {
        self.events = Some(emitter);
        self
    }

    /// Makes `guard` the connection being served: its link is the one the
    /// speaker monitor reads acknowledgements from, its delivery counters
    /// feed the pipeline snapshots, and its summary covers the playout from
    /// here until it is dropped.
    pub fn attach_connection(self: &Arc<Self>, guard: &Arc<LoggingStreamGuard>) {
        guard.bind(ConnBinding {
            stats: Arc::clone(self),
            since_ms: self.elapsed_ms(),
            cadence_base: self.cadence_totals(),
        });
        *self.connection.write() = Arc::downgrade(guard);
        self.connection_seq.fetch_add(1, Ordering::Relaxed);
    }

    /// The connection being served, or the last one while it lingers.
    pub(crate) fn connection(&self) -> Option<Arc<LoggingStreamGuard>> {
        self.connection.read().upgrade()
    }

    /// The connection being served, while its body is open: the one whose
    /// socket may be read.
    pub(crate) fn current_connection(&self) -> Option<Arc<LoggingStreamGuard>> {
        self.connection
            .read()
            .upgrade()
            .filter(|guard| !guard.body_closed.load(Ordering::Acquire))
    }

    /// Changes each time another connection starts being served.
    fn connection_seq(&self) -> u64 {
        self.connection_seq.load(Ordering::Relaxed)
    }

    /// Output data bytes handed over, up to the end of the last one given
    /// to a connection. Headers are not counted, and audio a speaker is sent
    /// again (see [`crate::stream::playout`]) is counted once.
    pub fn position(&self) -> u64 {
        match self.follows_connection {
            Some(header) => self.connection().map_or(0, |guard| {
                guard
                    .bytes_sent
                    .load(Ordering::Relaxed)
                    .saturating_sub(header)
            }),
            None => self.position.load(Ordering::Relaxed),
        }
    }

    /// Records that the last data byte handed to a connection ends at output
    /// byte `position`.
    pub(crate) fn set_position(&self, position: u64) {
        self.position.store(position, Ordering::Relaxed);
    }

    /// Milliseconds since the playout started.
    fn elapsed_ms(&self) -> u64 {
        self.reference_time.elapsed().as_millis() as u64
    }

    /// The cadence counters so far.
    pub(crate) fn cadence_totals(&self) -> CadenceStats {
        CadenceStats {
            silence_events: self.silence_events.load(Ordering::Relaxed),
            silence_frames: self.silence_frames.load(Ordering::Relaxed),
            frames_dropped: self.frames_dropped.load(Ordering::Relaxed),
            rebuffer_events: self.rebuffer_events.load(Ordering::Relaxed),
        }
    }

    /// Counts a silence event (the queue running empty), with its first
    /// silence frame.
    fn count_silence_event(&self) {
        self.silence_events.fetch_add(1, Ordering::Relaxed);
        self.silence_frames.fetch_add(1, Ordering::Relaxed);
    }

    /// Counts one more silence frame.
    fn count_silence_frame(&self) {
        self.silence_frames.fetch_add(1, Ordering::Relaxed);
    }

    /// Counts a frame dropped from a full queue.
    fn count_dropped_frame(&self) {
        self.frames_dropped.fetch_add(1, Ordering::Relaxed);
    }

    /// Counts playback held after an underrun until the queue refilled.
    fn count_rebuffer(&self) {
        self.rebuffer_events.fetch_add(1, Ordering::Relaxed);
    }

    /// Reports gaps in the audio's arrival to the stream's owner, if an
    /// emitter is attached.
    fn report_ingest_gaps(&self, report: super::ingest_gaps::IngestGapsReport) {
        log::warn!(
            "[Stream] Audio reached this machine late: stream={}, {} gap(s) in the last minute, \
             worst {}ms against {}ms of smoothing; every speaker on the stream had a gap{}",
            self.stream_id,
            report.gaps_last_minute,
            report.worst_gap_ms,
            report.smoothing_ms,
            report.suggested_smoothing_ms.map_or_else(
                || ", more than smoothing can cover".to_string(),
                |ms| format!(", {ms}ms of smoothing would cover it")
            )
        );
        if let Some(emitter) = &self.events {
            emitter.emit_stream(crate::events::StreamEvent::IngestGaps {
                stream_id: self.stream_id.clone(),
                gaps_last_minute: report.gaps_last_minute,
                worst_gap_ms: report.worst_gap_ms,
                smoothing_ms: report.smoothing_ms,
                suggested_smoothing_ms: report.suggested_smoothing_ms,
                timestamp: crate::utils::now_millis(),
            });
        }
    }

    /// Appends a snapshot to the pipeline timeline (called every 50 ticks from
    /// the cadence stream).
    fn push_pipeline_snapshot(&self, snapshot: PipelineSnapshot) {
        let mut timeline = self.pipeline_timeline.lock();
        timeline.push_back(snapshot);
        if timeline.len() > MAX_PIPELINE_SNAPSHOTS {
            timeline.pop_front();
        }
    }

    /// The pipeline snapshots taken in the last `window`, oldest first.
    pub(crate) fn recent_pipeline(&self, window: Duration) -> Vec<PipelineSample> {
        let since_ms = (self.reference_time.elapsed().saturating_sub(window)).as_millis() as u64;
        self.pipeline_timeline
            .lock()
            .iter()
            .filter(|s| s.elapsed_ms >= since_ms)
            .map(|s| PipelineSample {
                queue_len: s.cadence.queue_len,
                max_gap_ms: s.delivery.max_gap_ms,
                retransmitted: s.link.map(|l| l.retransmitted),
                unacked_bytes: s.link.and_then(|l| l.unacked_bytes),
            })
            .collect()
    }

    /// The pipeline snapshots taken since `since_ms` on the playout's clock,
    /// as JSON, or an empty string if there are none: a connection's share
    /// of the timeline, for its summary.
    pub(super) fn timeline_json_since(&self, since_ms: u64) -> String {
        let timeline = self.pipeline_timeline.lock();
        let first = timeline.partition_point(|s| s.elapsed_ms < since_ms);
        if first == timeline.len() {
            return String::new();
        }
        let (a, b) = timeline.as_slices();
        let slice: Vec<&PipelineSnapshot> = a.iter().chain(b.iter()).skip(first).collect();
        serde_json::to_string(&slice).unwrap_or_default()
    }
}

/// Manages crossfade state for smooth audio/silence transitions.
///
/// Tracks the last audio sample pair so that entering silence produces a
/// fade-out frame instead of an abrupt cut, and exiting silence applies a
/// fade-in to the first audio frame.
struct CrossfadeState {
    enabled: bool,
    fade_samples: usize,
    samples_per_frame: usize,
    channels: u16,
    last_sample_pair: Option<(i16, i16)>,
}

impl CrossfadeState {
    fn new(audio_format: &AudioFormat, frame_duration_ms: u32) -> Self {
        let enabled = is_crossfade_compatible(audio_format);
        if !enabled {
            log::warn!(
                "[Stream] Crossfade disabled: requires 16-bit PCM, got {}-bit",
                audio_format.bits_per_sample
            );
        }
        Self {
            enabled,
            fade_samples: crossfade_samples(audio_format.sample_rate),
            samples_per_frame: audio_format.frame_samples(frame_duration_ms),
            channels: audio_format.channels,
            last_sample_pair: None,
        }
    }

    /// Updates tracking with the last sample pair from a real audio frame.
    fn track_frame(&mut self, frame: &Bytes) {
        if self.enabled {
            self.last_sample_pair = extract_last_sample_pair(frame, self.channels);
        }
    }

    /// Applies fade-in to a frame following silence. Returns the frame
    /// unchanged when crossfade is disabled.
    fn maybe_fade_in(&self, frame: Bytes) -> Bytes {
        if self.enabled {
            let mut faded = frame.to_vec();
            apply_fade_in(&mut faded, self.channels, self.fade_samples);
            Bytes::from(faded)
        } else {
            frame
        }
    }

    /// Generates the first silence frame: a fade-out when last samples are
    /// available, otherwise plain silence.
    fn enter_silence(&mut self, silence_frame: &Bytes) -> Bytes {
        if self.enabled {
            if let Some((left, right)) = self.last_sample_pair.take() {
                return create_fade_out_frame(
                    left,
                    right,
                    self.channels,
                    self.fade_samples,
                    self.samples_per_frame,
                );
            }
        }
        silence_frame.clone()
    }
}

/// Most audio drift correction may insert into or remove from one
/// connection. Past it the command is no longer followed: something is
/// wrong with the controller or the speaker, and a few seconds of speed
/// change would start to be felt in lip sync and grouped playback.
pub const MAX_NET_INSERTED: Duration = Duration::from_secs(2);

/// Drift correction on one connection's cadence.
///
/// Every frame the cadence emits passes through the adapter: connect-burst,
/// metronome, rebuffer-hold silence, fade-out and fade-in frames alike, so
/// the filter state runs on unbroken from the first byte to the last and
/// its group delay never steps. Silence costs nothing audible to filter.
struct DriftHook {
    adapter: RateAdapter,
    control: Arc<RateControl>,
    /// Sample frames per second.
    sample_rate: u32,
    /// [`MAX_NET_INSERTED`] in sample frames.
    net_limit_frames: i64,
    /// The net insertion last published to `control`.
    published: i64,
}

impl DriftHook {
    /// The hook for a connection with `control`, or `None` (logged) if the
    /// format cannot be resampled, which leaves the stream as it was.
    fn new(
        control: Arc<RateControl>,
        audio_format: &AudioFormat,
        client_ip: IpAddr,
    ) -> Option<Self> {
        let Some(adapter) = RateAdapter::new(audio_format) else {
            log::info!(
                "[Cadence] Drift correction unavailable for {}: needs 16-bit PCM with at most 2 \
                 channels, got {}-bit with {} channels",
                client_ip,
                audio_format.bits_per_sample,
                audio_format.channels
            );
            return None;
        };
        let net_limit_frames =
            (MAX_NET_INSERTED.as_millis() as i64) * i64::from(audio_format.sample_rate) / 1000;
        control.mark_engaged();
        Some(Self {
            adapter,
            control,
            sample_rate: audio_format.sample_rate.max(1),
            net_limit_frames,
            published: 0,
        })
    }

    /// Resamples one emitted frame at the command in force.
    fn apply(&mut self, frame: &Bytes) -> Bytes {
        let ppm = if self.control.is_pinned() {
            0.0
        } else {
            self.control.command_ppm()
        };
        let out = self.adapter.process(frame, ppm);
        let net = self.adapter.net_frames();
        if net != self.published {
            self.control.publish_net_frames(net);
            self.published = net;
            if net.abs() > self.net_limit_frames && !self.control.is_pinned() {
                self.control.pin();
                log::warn!(
                    "[Cadence] Drift correction has {} {:.0} ms, more than the {} ms limit; holding \
                     at 0 ppm for the rest of this connection",
                    if net > 0 { "inserted" } else { "removed" },
                    self.net_ms().abs(),
                    MAX_NET_INSERTED.as_millis()
                );
            }
        }
        out
    }

    /// The audio inserted (positive) or removed so far, in milliseconds.
    fn net_ms(&self) -> f64 {
        self.adapter.net_frames() as f64 * 1000.0 / f64::from(self.sample_rate)
    }
}

/// Passes an emitted frame through the connection's drift correction, or
/// returns it untouched (the same buffer, zero-copy) when there is none.
fn shape(drift: &mut Option<DriftHook>, frame: Bytes) -> Bytes {
    match drift {
        Some(hook) => hook.apply(&frame),
        None => frame,
    }
}

/// Configuration for the cadence streaming pipeline.
pub struct CadenceConfig {
    /// Silence frame emitted when no audio is queued.
    pub silence_frame: Bytes,
    /// Maximum queue depth in frames before the oldest frame is dropped.
    /// Sized generously relative to the intended buffer depth (via
    /// [`JITTER_OVERFLOW_MULTIPLIER`]) so short producer bursts don't
    /// immediately drop frames, while still bounding memory.
    ///
    /// [`JITTER_OVERFLOW_MULTIPLIER`]: crate::protocol_constants::JITTER_OVERFLOW_MULTIPLIER
    pub overflow_cap: usize,
    /// Intended queue depth in frames (`jitter_buffer_ms / frame_duration_ms`).
    /// After an underrun, playback is held until the queue refills to this
    /// depth so one source gap does not leave the stream with no jitter
    /// margin. After a consumer stall, the backlog is trimmed back to it.
    /// 0 means pass-through: resume on the first frame, never trim.
    pub buffer_depth: usize,
    /// Duration of each output frame in milliseconds.
    pub frame_duration_ms: u32,
    /// Audio format (sample rate, channels, bit depth).
    pub audio_format: AudioFormat,
    /// Frames sent the moment the body is first polled, as fast as the
    /// connection takes them, before real-time pacing starts: the connect
    /// burst, oldest first. They immediately precede `prefill_frames`, so the
    /// speaker holds this much audio ahead of its playhead from the start.
    /// Empty when the burst is off or the ring held no more than the jitter
    /// buffer.
    pub burst_frames: Vec<Bytes>,
    /// Initial frames pre-populated in the queue to eliminate handoff gap.
    /// Trimmed by [`CadenceConfig::new`] so the initial queue depth stays
    /// bounded by the intended jitter buffer size.
    pub prefill_frames: Vec<Bytes>,
    /// Capture time of the first frame served: the first burst frame, or the
    /// first of `prefill_frames` without a burst. The speaker plays it at
    /// RelTime 0, and the epoch hook anchors the playback epoch here. `None`
    /// when no prefill survived, in which case the epoch falls back as
    /// described on [`crate::stream::StreamTiming::start_new_epoch`].
    ///
    /// It must be taken *after* trimming. The ring holds more frames than the
    /// burst and jitter buffer, so its oldest frame can predate the first
    /// frame served by seconds on a reconnect, and an epoch anchored there
    /// reads every later latency and cushion that much too high.
    pub epoch_candidate: Option<Instant>,
    /// Where the connection's drift correction reads its rate command. With
    /// `Some`, every frame the stream emits is resampled by a
    /// [`RateAdapter`] built before the connect burst; with `None` (drift
    /// correction off or only observing) no adapter exists and frames go
    /// out as the very buffers that were captured.
    pub rate_control: Option<Arc<RateControl>>,
}

impl CadenceConfig {
    /// Constructs a config from a jitter buffer depth in milliseconds.
    ///
    /// Derives `overflow_cap` from the intended buffer depth
    /// (`jitter_buffer_ms / frame_duration_ms`) multiplied by
    /// [`crate::protocol_constants::JITTER_OVERFLOW_MULTIPLIER`], clamped to
    /// [`crate::protocol_constants::MAX_CADENCE_QUEUE_SIZE`] with a floor of
    /// [`crate::protocol_constants::MIN_OVERFLOW_CAP`].
    ///
    /// The prefill is trimmed to the newest `connect_burst_ms` plus the
    /// intended buffer depth, so a resume with a full ring buffer doesn't
    /// replay stale audio before catching up to live. The newest
    /// `buffer_depth` frames of what is kept are queued, exactly as without a
    /// burst, so the queue keeps its full jitter margin; everything older
    /// becomes the connect burst. A ring holding less than both bursts only
    /// what it has beyond the buffer depth, and never pads with silence. The
    /// epoch candidate is the capture time of the first frame kept, since
    /// that is the first frame served.
    ///
    /// `connect_burst_ms` is rounded up to whole frames and clamped to
    /// [`crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS`]; `0` gives
    /// exactly the unburst behaviour.
    pub fn new(
        silence_frame: Bytes,
        jitter_buffer_ms: u64,
        connect_burst_ms: u64,
        frame_duration_ms: u32,
        audio_format: AudioFormat,
        prefill_frames: Vec<TimestampedFrame>,
    ) -> Self {
        use crate::protocol_constants::{
            JITTER_OVERFLOW_MULTIPLIER, MAX_CADENCE_QUEUE_SIZE, MAX_PCM_CONNECT_BURST_MS,
            MIN_OVERFLOW_CAP,
        };

        let frame_ms = u64::from(frame_duration_ms.max(1));
        let buffer_depth = jitter_buffer_ms.div_ceil(frame_ms) as usize;
        let overflow_cap = buffer_depth
            .saturating_mul(JITTER_OVERFLOW_MULTIPLIER)
            .clamp(MIN_OVERFLOW_CAP, MAX_CADENCE_QUEUE_SIZE);
        let burst_wanted = connect_burst_ms
            .min(MAX_PCM_CONNECT_BURST_MS)
            .div_ceil(frame_ms) as usize;

        let mut kept = trim_prefill(prefill_frames, buffer_depth + burst_wanted);
        let epoch_candidate = kept.first().map(|f| f.captured_at);
        let queued = kept.split_off(kept.len().saturating_sub(buffer_depth));
        let burst_frames = kept.into_iter().map(|f| f.data).collect();
        let prefill_frames = queued.into_iter().map(|f| f.data).collect();

        Self {
            silence_frame,
            overflow_cap,
            buffer_depth,
            frame_duration_ms,
            audio_format,
            burst_frames,
            prefill_frames,
            epoch_candidate,
            rate_control: None,
        }
    }

    /// Resamples every frame this connection emits, following the command
    /// left in `control`.
    #[must_use]
    pub fn with_rate_control(mut self, control: Arc<RateControl>) -> Self {
        self.rate_control = Some(control);
        self
    }

    /// Milliseconds of audio in the connect burst.
    #[must_use]
    pub fn burst_ms(&self) -> u64 {
        self.burst_frames.len() as u64 * u64::from(self.frame_duration_ms)
    }
}

/// Trims prefill frames so the initial queue depth does not exceed `buffer_depth`.
///
/// When `buffer_depth` is 0, returns an empty vec. When the prefill is already
/// at or below the depth, the input is returned unchanged. When it exceeds,
/// the oldest frames are dropped, keeping the most recent `buffer_depth` frames.
fn trim_prefill<T>(mut prefill_frames: Vec<T>, buffer_depth: usize) -> Vec<T> {
    if buffer_depth == 0 {
        prefill_frames.clear();
        return prefill_frames;
    }
    if prefill_frames.len() > buffer_depth {
        let excess = prefill_frames.len() - buffer_depth;
        prefill_frames.drain(..excess);
    }
    prefill_frames
}

/// Creates a WAV audio stream with fixed-cadence output and crossfade on silence transitions.
///
/// Maintains real-time cadence regardless of input timing:
/// - Incoming frames are queued (bounded to `queue_size`)
/// - Metronome ticks every `frame_duration_ms`
/// - On each tick: send queued frame if available, else send silence
///
/// Crossfade on silence transitions:
/// - When entering silence: emits a fade-out frame from the last audio sample to zero
/// - When exiting silence: applies fade-in to the first audio frame
///
/// Silence and overflow statistics are counted into `stats` as they happen,
/// so each connection the stream is carried on can report its share (see
/// [`ChainStats`]). Pipeline snapshots read the delivery counters and TCP
/// link of whichever connection is being served at the time.
///
/// Epoch tracking (optional): when `epoch_hook` is `Some`, the stream fires
/// it on the first real audio frame, which starts the epoch anchored to
/// [`CadenceConfig::epoch_candidate`] and registers a monitored connection
/// with the speaker monitor, then discards the hook.
/// The hook holds a `Weak` reference so the response body never keeps the
/// `StreamState` (and with it the broadcast sender) alive; if the upgrade
/// fails the stream has been removed and the hook is dropped unfired.
///
/// Drift correction (optional): with [`CadenceConfig::rate_control`] set,
/// every frame the stream emits, connect burst and silence included, is
/// resampled by one [`RateAdapter`] at the command in force. Without it the
/// stream yields the captured buffers themselves.
///
/// This ensures Sonos always receives continuous data with smooth transitions,
/// eliminating pops from abrupt audio/silence boundaries.
pub fn create_wav_stream_with_cadence(
    mut rx: broadcast::Receiver<Bytes>,
    stats: Arc<ChainStats>,
    config: CadenceConfig,
    stream_state: Option<std::sync::Weak<StreamState>>,
    epoch_hook: Option<EpochHook>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    stream! {
        let CadenceConfig {
            silence_frame,
            overflow_cap,
            buffer_depth,
            frame_duration_ms,
            audio_format,
            burst_frames,
            prefill_frames,
            epoch_candidate,
            rate_control,
        } = config;
        let cadence_duration = Duration::from_millis(frame_duration_ms as u64);
        // Upper bound on holding playback after an underrun: twice the jitter
        // buffer. A producer that never refills the queue must not hold
        // silence forever.
        let rebuffer_timeout = cadence_duration * (2 * buffer_depth).max(1) as u32;

        // Pre-populate queue with (trimmed) prefill frames so the first tick
        // immediately yields real audio rather than silence.
        let mut queue: VecDeque<Bytes> =
            VecDeque::with_capacity(overflow_cap.max(prefill_frames.len()));
        for frame in prefill_frames {
            queue.push_back(frame);
        }

        // Startup diagnostics: records whether the cadence loop began with
        // a populated queue (audio-first first yield) or empty (silence-first).
        // Correlate with `speaker_stopped` events to validate or falsify the
        // "empty prefill → silence-first → Sonos stops" hypothesis.
        log::info!(
            "[Cadence] Startup: burst_frames={}, prefill_frames={}, overflow_cap={}, frame_ms={}",
            burst_frames.len(),
            queue.len(),
            overflow_cap,
            frame_duration_ms
        );

        // Fire first tick immediately to get audio flowing before Sonos times out.
        // Startup buffering to protect against an empty prefill is handled by the
        // caller via a bounded pre-subscribe sleep in `api/stream.rs`.
        //
        // Started before the connect burst, so real-time pacing is anchored to
        // the moment the body is first polled: if the connection is slow to
        // take the burst, the missed ticks replay afterwards and the speaker
        // still ends up the whole burst ahead of real time.
        let mut metronome = interval(cadence_duration);
        metronome.set_missed_tick_behavior(MissedTickBehavior::Burst);
        let metronome_started = TokioInstant::now();

        // Extra room above `overflow_cap` while the ticks missed during a
        // slow connect burst replay. Live frames keep arriving while the
        // connection takes the burst, and the first tick after it drains them
        // all at once; the replayed ticks then pay them back out one per tick.
        // Without this room the oldest of them, the frames that directly
        // follow the burst, would be dropped as overflow. Counts down by one
        // per tick, so the normal cap is back once the backlog is replayed.
        let mut catch_up_headroom: usize = 0;

        let mut rx_closed = false;
        let mut in_silence = false;
        let mut silence_start: Option<TokioInstant> = None;
        // One-shot marker: logs the kind of the first yielded frame (audio
        // vs silence) so field logs identify cold-start starvation directly.
        let mut first_yield_logged = false;

        // Cadence-specific counters (written to guard at stream end)
        let mut silence_events: u64 = 0;
        let mut silence_frames: u64 = 0;
        let mut frames_dropped: u64 = 0;
        let mut rebuffer_events: u64 = 0;

        // Recovery state. `rebuffering` holds playback after an underrun that
        // interrupted real audio until the queue is back at `buffer_depth`;
        // startup starvation is deliberately not gated (see api/stream.rs
        // prefill delay). `rebuffer_started` is set when frames begin to
        // arrive again, so the timeout bounds a trickling producer without
        // expiring during a long source pause.
        let mut has_played_audio = false;
        let mut rebuffering = false;
        let mut rebuffer_started: Option<TokioInstant> = None;
        // Underruns over the last minute, for the ingest-gap notice.
        let mut ingest_gaps = super::ingest_gaps::IngestGapWindow::new();

        let mut crossfade = CrossfadeState::new(&audio_format, frame_duration_ms);

        // Built before the connect burst, so burst and metronome frames share
        // one filter state. The crossfade keeps tracking the frames the
        // adapter is fed, not what it emits: a fade-out frame goes through
        // the adapter too, and it is the adapter's input that must be
        // continuous for its output to be.
        let mut drift = rate_control.and_then(|control| DriftHook::new(control, &audio_format, stats.client_ip));

        // Rate-limit lagged warnings (max once per second)
        let mut last_lagged_log: Option<TokioInstant> = None;

        // One-shot epoch hook: fires on the first real audio frame, then consumed
        let mut epoch_hook = epoch_hook;

        // Pipeline snapshot state
        let mut tick_count: u64 = 0;
        let mut prev_delivery_frames: u64 = 0;
        let mut prev_delivery_bytes: u64 = 0;
        let mut prev_delivery_gaps: u64 = 0;
        let mut prev_snapshot_ms: u64 = 0;
        // Which connection the delivery counters above were read from.
        let mut delivery_seq = stats.connection_seq();

        // Connect burst: already-captured audio, sent as fast as the
        // connection takes it, so the speaker starts with that much in hand.
        // The first burst frame is the first frame served, so it starts the
        // epoch, anchored to it. The queue still holds the full jitter
        // buffer, which the metronome paces out from here exactly as it
        // would have without a burst.
        if !burst_frames.is_empty() {
            if let Some(hook) = epoch_hook.take() {
                hook.fire(epoch_candidate);
            }
            log::info!("[Cadence] First yield: audio (connect burst of {} frames)", burst_frames.len());
            first_yield_logged = true;
            has_played_audio = true;
            for frame in burst_frames {
                crossfade.track_frame(&frame);
                yield Ok(shape(&mut drift, frame));
            }
            // One frame arrives per missed tick, plus the immediate first
            // tick, which has not fired yet either.
            let burst_took = metronome_started.elapsed();
            let missed_ticks = (burst_took.as_nanos() / cadence_duration.as_nanos().max(1)) as usize;
            if missed_ticks > 0 {
                catch_up_headroom = missed_ticks + 1;
                log::info!(
                    "[Cadence] Connect burst took {}ms; allowing {} extra queued frames while the \
                     missed ticks replay",
                    burst_took.as_millis(),
                    catch_up_headroom
                );
            }
        }

        loop {
            // Exit when channel closed AND queue drained
            if rx_closed && queue.is_empty() {
                break;
            }

            tokio::select! {
                biased;

                // PRIORITY 1: Metronome tick - MUST emit something every frame_duration_ms
                _ = metronome.tick() => {
                    // Drain pending frames BEFORE deciding what to emit, so a
                    // frame that landed just before the tick counts as
                    // available instead of being treated as an underrun. With
                    // biased select, ticks always win, so without this drain
                    // frames could pile up in rx while we emit silence.
                    //
                    // A consumer stall is left to `MissedTickBehavior::Burst`:
                    // the missed ticks replay the backlog (and silence for the
                    // rest), which keeps the byte timeline Sonos expects, and
                    // the rebuffer gate below restores the depth afterwards.
                    if !rx_closed {
                        loop {
                            match rx.try_recv() {
                                Ok(frame) => {
                                    if queue.len() >= overflow_cap + catch_up_headroom {
                                        queue.pop_front();
                                        frames_dropped += 1;
                                        stats.count_dropped_frame();
                                    }
                                    queue.push_back(frame);
                                }
                                Err(broadcast::error::TryRecvError::Empty) => break,
                                Err(broadcast::error::TryRecvError::Lagged(n)) => {
                                    log_lagged(n, &mut last_lagged_log, " (during drain)");
                                }
                                Err(broadcast::error::TryRecvError::Closed) => {
                                    rx_closed = true;
                                    log::debug!("[Stream] Channel closed, draining {} queued frames", queue.len());
                                    break;
                                }
                            }
                        }
                    }

                    // Post-underrun rebuffer gate: keep emitting silence until
                    // the queue is back at the target depth (or the timeout
                    // elapses, counted from when frames resumed), so playback
                    // resumes with real jitter margin. A closed channel ends
                    // the hold so the queued tail plays out and the stream ends.
                    let hold_for_rebuffer = rebuffering && {
                        if rebuffer_started.is_none() && !queue.is_empty() {
                            rebuffer_started = Some(TokioInstant::now());
                            // Frames are arriving again: the gap in their
                            // arrival was the smoothing that ran dry plus
                            // the silence played since.
                            let smoothing_ms = stream_state
                                .as_ref()
                                .and_then(|w| w.upgrade())
                                .map_or(buffer_depth as u64 * u64::from(frame_duration_ms), |ss| {
                                    ss.jitter_buffer_ms
                                });
                            let silent_ms = silence_start.map_or(0, |t| t.elapsed().as_millis() as u64);
                            let now = Instant::now();
                            if let Some(report) = ingest_gaps.record(now, smoothing_ms + silent_ms, smoothing_ms) {
                                let claimed = stream_state
                                    .as_ref()
                                    .and_then(|w| w.upgrade())
                                    .is_some_and(|ss| ss.ingest_gap_notices.claim(now));
                                if claimed {
                                    stats.report_ingest_gaps(report);
                                }
                            }
                        }
                        let waited = rebuffer_started.map(|t| t.elapsed()).unwrap_or_default();
                        if rx_closed || queue.len() >= buffer_depth || waited >= rebuffer_timeout {
                            rebuffering = false;
                            rebuffer_events += 1;
                            stats.count_rebuffer();
                            log::info!(
                                "[Cadence] Rebuffered: depth={} after {}ms",
                                queue.len(),
                                waited.as_millis()
                            );
                            false
                        } else {
                            true
                        }
                    };

                    if hold_for_rebuffer {
                        silence_frames += 1;
                        stats.count_silence_frame();
                        yield Ok(shape(&mut drift, silence_frame.clone()));
                    } else if let Some(frame) = queue.pop_front() {
                        // Real audio available
                        let was_in_silence = in_silence;
                        if in_silence {
                            if let Some(start) = silence_start.take() {
                                log::info!(
                                    "[Stream] Exiting silence (cadence) after {:.1}s (queue_depth={})",
                                    start.elapsed().as_secs_f32(),
                                    queue.len()
                                );
                            }
                            in_silence = false;
                        }

                        crossfade.track_frame(&frame);

                        // Fire epoch hook on first real audio frame. A failed
                        // upgrade means the stream was removed, so there is no
                        // epoch left to start - drop the hook either way.
                        //
                        // After a connect burst the hook has already fired.
                        // Otherwise, with prefill queued this is the first
                        // tick (the metronome fires as soon as the body is
                        // polled) and the frame is the first prefill frame,
                        // the one `epoch_candidate` was captured from. The
                        // overflow cap leaves room for twice the jitter
                        // buffer of live frames on top of the prefill, so
                        // none is dropped before that first tick.
                        if let Some(hook) = epoch_hook.take() {
                            hook.fire(epoch_candidate);
                        }

                        if !first_yield_logged {
                            log::info!("[Cadence] First yield: audio (queue_depth={})", queue.len());
                            first_yield_logged = true;
                        }
                        has_played_audio = true;

                        if was_in_silence {
                            yield Ok(shape(&mut drift, crossfade.maybe_fade_in(frame)));
                        } else {
                            yield Ok(shape(&mut drift, frame));
                        }
                    } else if !rx_closed {
                        // No frame available, emit silence
                        if !in_silence {
                            log::info!("[Stream] Entering silence (cadence) - queue empty");
                            in_silence = true;
                            silence_start = Some(TokioInstant::now());
                            silence_events += 1;
                            silence_frames += 1;
                            stats.count_silence_event();
                            if !first_yield_logged {
                                log::warn!("[Cadence] First yield: silence (empty prefill at startup)");
                                first_yield_logged = true;
                            }
                            // Only an underrun that interrupted real audio is
                            // gated; startup starvation resumes on the first
                            // frame as before.
                            if has_played_audio && buffer_depth > 0 {
                                rebuffering = true;
                                rebuffer_started = None;
                            }
                            yield Ok(shape(&mut drift, crossfade.enter_silence(&silence_frame)));
                        } else {
                            silence_frames += 1;
                            stats.count_silence_frame();
                            yield Ok(shape(&mut drift, silence_frame.clone()));
                        }
                    }
                    // If rx_closed and queue empty, don't yield - loop will break

                    catch_up_headroom = catch_up_headroom.saturating_sub(1);

                    // Pipeline snapshot every 50 ticks (500 ms at the default 10 ms frame)
                    tick_count += 1;
                    if tick_count % 50 == 0 {
                        let elapsed_ms = stats.elapsed_ms();
                        let connection = stats.current_connection();
                        let seq = stats.connection_seq();
                        if seq != delivery_seq {
                            // Another connection is being served: its
                            // counters start from nothing.
                            delivery_seq = seq;
                            prev_delivery_frames = 0;
                            prev_delivery_bytes = 0;
                            prev_delivery_gaps = 0;
                        }

                        // Receive window: snapshot and reset from StreamState
                        // Uses Weak ref - if StreamState was dropped (channel closing), skip
                        let receive = if let Some(ss) = stream_state.as_ref().and_then(|w| w.upgrade()) {
                            let rs = ss.snapshot_and_reset_receive_stats();
                            ReceiveWindow {
                                frames_received: rs.frames_received,
                                min_gap_ms: if rs.min_gap_ms == u64::MAX { 0 } else { rs.min_gap_ms },
                                max_gap_ms: rs.max_gap_ms,
                                gaps_over_threshold: rs.gaps_over_threshold,
                            }
                        } else {
                            ReceiveWindow { frames_received: 0, min_gap_ms: 0, max_gap_ms: 0, gaps_over_threshold: 0 }
                        };

                        // Cadence window: current counters (cumulative, not reset)
                        let cadence_window = CadenceWindow {
                            queue_len: queue.len(),
                            silence_events,
                            silence_frames,
                            drops: frames_dropped,
                        };

                        // Delivery window: deltas from the served
                        // connection's atomics (none while no connection is).
                        let (cur_frames, cur_bytes, cur_gaps, interval_max) = connection
                            .as_ref()
                            .map_or((prev_delivery_frames, prev_delivery_bytes, prev_delivery_gaps, 0), |guard| {
                                (
                                    guard.frames_sent.load(Ordering::Relaxed),
                                    guard.bytes_sent.load(Ordering::Relaxed),
                                    guard.gaps_over_threshold.load(Ordering::Relaxed),
                                    guard.interval_max_gap_ms.swap(0, Ordering::Relaxed),
                                )
                            });

                        let delta_bytes = cur_bytes.saturating_sub(prev_delivery_bytes);
                        let interval_ms = elapsed_ms.saturating_sub(prev_snapshot_ms);
                        let bytes_per_second = (delta_bytes * 1000).checked_div(interval_ms).unwrap_or(0);

                        let delivery = DeliveryWindow {
                            frames_sent: cur_frames.saturating_sub(prev_delivery_frames),
                            bytes_per_second,
                            max_gap_ms: interval_max,
                            gaps_over_threshold: cur_gaps.saturating_sub(prev_delivery_gaps),
                        };

                        prev_delivery_frames = cur_frames;
                        prev_delivery_bytes = cur_bytes;
                        prev_delivery_gaps = cur_gaps;
                        prev_snapshot_ms = elapsed_ms;

                        stats.push_pipeline_snapshot(PipelineSnapshot {
                            elapsed_ms,
                            receive,
                            cadence: cadence_window,
                            delivery,
                            // Read against the byte count loaded above: no
                            // frame is yielded while this snapshot is taken.
                            // The loop runs only while hyper polls the body,
                            // so a send buffer that stays full takes no
                            // samples: the stall is seen in the first one
                            // after it clears, not while it lasts.
                            link: connection.as_ref().and_then(|guard| guard.sample_link()),
                            speaker: stats.speaker.snapshot(),
                        });
                    }
                }

                // PRIORITY 2: Receive frames into queue (when channel open and tick not ready)
                result = rx.recv(), if !rx_closed => {
                    match result {
                        Ok(frame) => {
                            if queue.len() >= overflow_cap + catch_up_headroom {
                                // Queue full - drop oldest to maintain bounded latency
                                queue.pop_front();
                                frames_dropped += 1;
                                stats.count_dropped_frame();
                                log::trace!("[Stream] Queue full, dropped oldest frame");
                            }
                            queue.push_back(frame);
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            log_lagged(n, &mut last_lagged_log, "");
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            rx_closed = true;
                            log::debug!("[Stream] Channel closed, draining {} queued frames", queue.len());
                        }
                    }
                }
            }
        }

        log::debug!(
            "[Cadence] Ended: silence_events={}, silence_frames={}, frames_dropped={}, rebuffers={}",
            silence_events,
            silence_frames,
            frames_dropped,
            rebuffer_events
        );
        if let Some(hook) = drift {
            log::info!(
                "[Cadence] Drift correction on {}: net {:+} sample frames ({:+.1} ms){}",
                stats.client_ip,
                hook.adapter.net_frames(),
                hook.net_ms(),
                if hook.control.is_pinned() { ", pinned at 0 ppm" } else { "" }
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream::Stream;
    use futures::StreamExt;
    use std::future::poll_fn;
    use std::net::Ipv4Addr;
    use std::pin::Pin;
    use std::task::Poll;
    use tokio::time::{self, Duration};

    use crate::protocol_constants::SILENCE_FRAME_DURATION_MS;

    /// Default queue size for tests (10 frames = 100ms at 10ms/frame).
    const TEST_QUEUE_SIZE: usize = 10;

    /// Test silence frame for assertions.
    fn test_silence_frame() -> Bytes {
        Bytes::from_static(&[0u8; 64])
    }

    /// Test audio frame for assertions.
    fn test_audio_frame() -> Bytes {
        Bytes::from_static(&[1u8; 64])
    }

    /// Creates a test guard for cadence stream tests.
    fn test_guard() -> Arc<ChainStats> {
        Arc::new(ChainStats::new(
            "test-stream",
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ))
    }

    /// Creates a default CadenceConfig for tests.
    fn test_config() -> CadenceConfig {
        CadenceConfig {
            silence_frame: test_silence_frame(),
            overflow_cap: TEST_QUEUE_SIZE,
            buffer_depth: 0,
            frame_duration_ms: SILENCE_FRAME_DURATION_MS,
            audio_format: test_audio_format(),
            burst_frames: vec![],
            prefill_frames: vec![],
            epoch_candidate: None,
            rate_control: None,
        }
    }

    /// Creates a test audio format for cadence stream tests.
    fn test_audio_format() -> AudioFormat {
        AudioFormat::new(48000, 2, 16)
    }

    /// Polls the stream once to register internal timers, then advances time.
    ///
    /// With `start_paused = true`, timers must be polled before `time::advance`
    /// will affect them. This helper ensures the stream's internal select! loop
    /// registers its timers before we manipulate time.
    async fn poll_and_advance<S>(stream: &mut Pin<&mut S>, duration: Duration)
    where
        S: Stream + ?Sized,
    {
        // Poll stream once to register timers (should return Pending since no data/timeout yet)
        poll_fn(|cx| {
            let _ = stream.as_mut().poll_next(cx);
            Poll::Ready(())
        })
        .await;

        time::advance(duration).await;
    }

    /// Registers the metronome and consumes its immediate first tick (which
    /// yields silence on an empty queue, or the first prefill frame) so tests
    /// can queue frames and reason about the following ticks. Does not
    /// advance time: the next tick is still a full frame duration away.
    async fn prime<S>(stream: &mut Pin<&mut S>)
    where
        S: Stream + ?Sized,
    {
        poll_fn(|cx| {
            let _ = stream.as_mut().poll_next(cx);
            Poll::Ready(())
        })
        .await;
    }

    /// Advances one frame duration and yields the next frame.
    async fn next_tick<S>(stream: &mut Pin<&mut S>) -> Bytes
    where
        S: Stream<Item = Result<Bytes, std::io::Error>> + ?Sized,
    {
        poll_and_advance(
            stream,
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;
        stream.next().await.expect("stream should yield").unwrap()
    }

    /// Drains a cadence stream to completion by advancing time and polling.
    ///
    /// The channel must be closed (tx dropped) before calling this, so the
    /// stream can detect closure and terminate.
    ///
    /// Returns whether the stream ended within the polling budget.
    async fn drain_to_end<S>(stream: &mut Pin<&mut S>) -> bool
    where
        S: Stream + ?Sized,
    {
        for _ in 0..50 {
            time::advance(Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64)).await;
            let done = poll_fn(|cx| match stream.as_mut().poll_next(cx) {
                Poll::Ready(None) => Poll::Ready(true),
                _ => Poll::Ready(false),
            })
            .await;
            if done {
                return true;
            }
        }
        false
    }

    #[tokio::test(start_paused = true)]
    async fn emits_frames_at_cadence() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let audio = test_audio_frame();
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Register the metronome (first tick yields startup silence), then
        // queue frames before the next tick.
        prime(&mut stream.as_mut()).await;
        tx.send(audio.clone()).expect("send should succeed");
        tx.send(audio.clone()).expect("send should succeed");

        // Frames queued before a tick are yielded on that tick (may have
        // fade-in applied after the startup silence)
        let frame = next_tick(&mut stream.as_mut()).await;
        assert!(
            !frame.iter().all(|&b| b == 0),
            "expected audio frame at cadence tick"
        );

        // Should get second audio frame
        let frame = next_tick(&mut stream.as_mut()).await;
        assert_eq!(frame, audio, "expected second audio frame at cadence tick");

        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn fills_gaps_with_silence() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Don't send any frames - queue will be empty

        // Poll to register metronome, advance one tick
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Should get silence frame since queue is empty
        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            frame.iter().all(|&b| b == 0),
            "expected silence frame when queue is empty"
        );

        // Another tick should also yield silence
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            frame.iter().all(|&b| b == 0),
            "expected silence frame on continued empty queue"
        );

        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn queue_drains_at_cadence() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Register the metronome, then queue 3 frames as a burst
        prime(&mut stream.as_mut()).await;
        for i in 0..3 {
            tx.send(Bytes::from(vec![i; 64]))
                .expect("send should succeed");
        }

        // Each tick should drain one frame (the last byte is untouched by
        // the fade-in applied after startup silence)
        for expected_byte in 0..3u8 {
            let bytes = next_tick(&mut stream.as_mut()).await;
            assert_eq!(
                bytes[bytes.len() - 1],
                expected_byte,
                "frames should drain in order at cadence"
            );
        }

        // Queue is now empty, next tick should yield silence
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Queue empty → silence/keepalive (may be a crossfade fade-out frame)
        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            !frame.is_empty(),
            "expected non-empty frame after queue drained"
        );

        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn drops_oldest_on_overflow() {
        let (tx, rx) = broadcast::channel::<Bytes>(32);
        let guard = test_guard();
        let guard_for_check = Arc::clone(&guard);

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Send 12 frames (queue_size + 2), should drop 2 oldest
        for i in 0..12u8 {
            tx.send(Bytes::from(vec![i; 64]))
                .expect("send should succeed");
        }

        // Poll multiple times to ensure frames are received via the rx.recv() branch
        // and overflow logic is triggered
        for _ in 0..15 {
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;
        }

        // Close channel and drain to completion (writes cadence stats)
        drop(tx);
        drain_to_end(&mut stream.as_mut()).await;

        // Verify that exactly 2 frames were dropped
        let stats = guard_for_check.cadence_totals();
        assert_eq!(
            stats.frames_dropped, 2,
            "should have dropped 2 oldest frames, dropped {}",
            stats.frames_dropped
        );
    }

    #[tokio::test(start_paused = true)]
    async fn tracks_dropped_frames() {
        let (tx, rx) = broadcast::channel::<Bytes>(32);
        let guard = test_guard();
        let guard_for_check = Arc::clone(&guard);

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Overflow queue by TEST_QUEUE_SIZE + 3 frames
        let overflow_count = 3;
        for i in 0..(TEST_QUEUE_SIZE + overflow_count) as u8 {
            tx.send(Bytes::from(vec![i; 64]))
                .expect("send should succeed");
        }

        // Give time for frames to be received and processed
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Consume a frame to ensure internal processing has happened
        let _ = stream.next().await;

        // Close channel and drain to completion (writes cadence stats)
        drop(tx);
        drain_to_end(&mut stream.as_mut()).await;

        // Check the cadence stats - should have recorded dropped frames
        let stats = guard_for_check.cadence_totals();
        assert_eq!(
            stats.frames_dropped, overflow_count as u64,
            "guard should track {} dropped frames",
            overflow_count
        );
    }

    #[tokio::test(start_paused = true)]
    async fn drains_queue_on_channel_close() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Register the metronome, then queue some frames
        prime(&mut stream.as_mut()).await;
        tx.send(Bytes::from(vec![1; 64]))
            .expect("send should succeed");
        tx.send(Bytes::from(vec![2; 64]))
            .expect("send should succeed");

        let _ = next_tick(&mut stream.as_mut()).await; // consume first frame

        // Close the channel
        drop(tx);

        // Advance and drain remaining frame
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Should still get the queued frame
        let frame = stream
            .next()
            .await
            .expect("stream should yield queued frame");
        let bytes = frame.expect("should be Ok");
        assert_eq!(bytes[0], 2, "should drain remaining queued frame");

        // Now stream should end (channel closed AND queue empty)
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await;
        assert!(
            frame.is_none(),
            "stream should end when channel closed and queue empty"
        );
    }

    /// A connection whose source never produces audio keeps its epoch hook armed
    /// for the life of the stream. The hook must hold the stream weakly, or the
    /// broadcast sender outlives the coordinator's `Arc` and the metronome emits
    /// silence to the speaker forever.
    #[tokio::test(start_paused = true)]
    async fn armed_epoch_hook_does_not_keep_the_stream_alive() {
        let state = Arc::new(StreamState::new(
            "test-stream".to_string(),
            crate::stream::AudioCodec::Pcm,
            test_audio_format(),
            8,
            16,
            200,
            SILENCE_FRAME_DURATION_MS,
        ));
        let weak = Arc::downgrade(&state);
        let (_, rx) = state.subscribe();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            test_config(),
            Some(Arc::downgrade(&state)),
            Some(EpochHook::new(
                Arc::downgrade(&state),
                Instant::now(),
                IpAddr::V4(Ipv4Addr::LOCALHOST),
            )),
        ));

        // Start the metronome with the hook still armed - no audio ever arrives.
        prime(&mut stream.as_mut()).await;

        // The coordinator removes the stream.
        drop(state);
        assert!(
            weak.upgrade().is_none(),
            "the cadence stream must not hold the coordinator's stream alive"
        );

        // The sender went with the stream, so the channel is closed and the
        // metronome stops instead of emitting silence forever.
        assert!(
            drain_to_end(&mut stream.as_mut()).await,
            "cadence stream must end once the stream is removed"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn exits_silence_when_frames_arrive() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let audio = test_audio_frame();
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // First tick with empty queue -> silence
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            frame.iter().all(|&b| b == 0),
            "expected silence when queue empty"
        );

        // Queue a frame
        tx.send(audio.clone()).expect("send should succeed");

        // Next tick should yield audio (exit silence)
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            !frame.iter().all(|&b| b == 0),
            "expected audio when frame queued after silence"
        );

        drop(tx);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Recovery: rebuffer after underrun
    // ─────────────────────────────────────────────────────────────────────

    /// Frame large enough that a fade-in leaves its last bytes untouched.
    const BIG_FRAME: usize = 4096;

    fn big_frame(tag: u8) -> Bytes {
        Bytes::from(vec![tag; BIG_FRAME])
    }

    /// Silence, including the fade-out frame that begins a silence run: both
    /// end in zero samples, while test audio frames end in their tag byte.
    fn is_silence(frame: &Bytes) -> bool {
        frame[frame.len() - 1] == 0
    }

    /// Config with a real jitter buffer: 3-frame target depth, 6-frame cap.
    fn buffered_config(prefill: Vec<Bytes>) -> CadenceConfig {
        CadenceConfig {
            silence_frame: Bytes::from(vec![0u8; BIG_FRAME]),
            overflow_cap: 6,
            buffer_depth: 3,
            frame_duration_ms: SILENCE_FRAME_DURATION_MS,
            audio_format: test_audio_format(),
            burst_frames: vec![],
            prefill_frames: prefill,
            epoch_candidate: None,
            rate_control: None,
        }
    }

    /// After an underrun interrupts playback, the stream keeps emitting
    /// silence until the queue is back at `buffer_depth`, so a producer that
    /// delivers exactly one frame per tick (WASAPI capture) resumes with a
    /// full jitter margin instead of at depth zero.
    #[tokio::test(start_paused = true)]
    async fn rebuffers_to_target_depth_after_underflow() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();
        let guard_for_check = Arc::clone(&guard);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            buffered_config(vec![big_frame(1), big_frame(2), big_frame(3)]),
            None,
            None,
        ));

        // Prefill plays out: tick 1 (consumed by prime), ticks 2-3
        prime(&mut stream.as_mut()).await;
        assert!(!is_silence(&next_tick(&mut stream.as_mut()).await));
        assert!(!is_silence(&next_tick(&mut stream.as_mut()).await));

        // Underrun: queue empty -> silence, playback now gated
        assert!(is_silence(&next_tick(&mut stream.as_mut()).await));

        // Producer resumes at one frame per tick. Depth 1 and 2 are held...
        tx.send(big_frame(10)).unwrap();
        assert!(
            is_silence(&next_tick(&mut stream.as_mut()).await),
            "depth 1 held"
        );
        tx.send(big_frame(11)).unwrap();
        assert!(
            is_silence(&next_tick(&mut stream.as_mut()).await),
            "depth 2 held"
        );

        // ...depth 3 reaches the target and playback resumes with fade-in
        tx.send(big_frame(12)).unwrap();
        let frame = next_tick(&mut stream.as_mut()).await;
        assert_eq!(
            frame[BIG_FRAME - 1],
            10,
            "resumes from the oldest queued frame"
        );

        // A missed producer tick is now absorbed by the margin: no silence
        let frame = next_tick(&mut stream.as_mut()).await;
        assert_eq!(frame[BIG_FRAME - 1], 11, "margin absorbs a late frame");

        drop(tx);
        drain_to_end(&mut stream.as_mut()).await;
        let stats = guard_for_check.cadence_totals();
        assert_eq!(stats.rebuffer_events, 1);
        assert_eq!(
            stats.silence_events, 1,
            "one underrun, not one per held tick"
        );
    }

    /// Records the stream events a guard reports.
    #[derive(Default)]
    struct StreamEvents(parking_lot::Mutex<Vec<crate::events::StreamEvent>>);

    impl crate::events::EventEmitter for StreamEvents {
        fn emit_stream(&self, event: crate::events::StreamEvent) {
            self.0.lock().push(event);
        }
        fn emit_sonos(&self, _: crate::events::SonosEvent) {}
        fn emit_network(&self, _: crate::events::NetworkEvent) {}
        fn emit_topology(&self, _: crate::events::TopologyEvent) {}
        fn emit_latency(&self, _: crate::events::LatencyEvent) {}
    }

    /// Two underruns within a minute are reported once as late audio, for
    /// the stream as a whole, with the smoothing the stream runs with.
    #[tokio::test(start_paused = true)]
    async fn two_underruns_in_a_minute_report_ingest_gaps_once() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let events = Arc::new(StreamEvents::default());
        let guard = Arc::new(
            ChainStats::new("test-stream", IpAddr::V4(Ipv4Addr::LOCALHOST))
                .with_events(Arc::clone(&events) as Arc<dyn crate::events::EventEmitter>),
        );
        let state = Arc::new(StreamState::new(
            "test-stream".to_string(),
            crate::stream::AudioCodec::Pcm,
            test_audio_format(),
            8,
            16,
            30,
            SILENCE_FRAME_DURATION_MS,
        ));
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            buffered_config(vec![big_frame(1), big_frame(2), big_frame(3)]),
            Some(Arc::downgrade(&state)),
            None,
        ));
        prime(&mut stream.as_mut()).await;
        for round in 0..3u8 {
            // Play the queue out until it runs dry, then refill it.
            while !is_silence(&next_tick(&mut stream.as_mut()).await) {}
            for i in 0..3 {
                tx.send(big_frame(10 * (round + 1) + i)).unwrap();
            }
            for _ in 0..3 {
                next_tick(&mut stream.as_mut()).await;
            }
        }
        let reported: Vec<_> = events.0.lock().drain(..).collect();
        assert_eq!(reported.len(), 1, "{reported:?}");
        match &reported[0] {
            crate::events::StreamEvent::IngestGaps {
                stream_id,
                gaps_last_minute,
                smoothing_ms,
                worst_gap_ms,
                suggested_smoothing_ms,
                ..
            } => {
                assert_eq!(stream_id, "test-stream");
                assert_eq!(*gaps_last_minute, 2);
                assert_eq!(*smoothing_ms, 30);
                assert!(*worst_gap_ms >= 30);
                assert_eq!(*suggested_smoothing_ms, Some(100));
            }
            other => panic!("unexpected {other:?}"),
        }
        drop(tx);
        drain_to_end(&mut stream.as_mut()).await;
    }

    /// Startup starvation is not gated: with an empty prefill the first
    /// frame plays as soon as it arrives (the pre-subscribe delay in
    /// api/stream.rs handles startup buffering).
    #[tokio::test(start_paused = true)]
    async fn startup_starvation_resumes_on_first_frame() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            buffered_config(vec![]),
            None,
            None,
        ));

        prime(&mut stream.as_mut()).await; // startup silence
        tx.send(big_frame(7)).unwrap();
        let frame = next_tick(&mut stream.as_mut()).await;
        assert!(
            !is_silence(&frame),
            "first frame plays without waiting for depth"
        );
        drop(tx);
    }

    /// The rebuffer gate gives up after twice the jitter buffer so a producer
    /// that trickles below the target depth does not hold silence forever.
    #[tokio::test(start_paused = true)]
    async fn rebuffer_gate_times_out() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            buffered_config(vec![big_frame(1)]),
            None,
            None,
        ));

        prime(&mut stream.as_mut()).await; // plays the single prefill frame
        assert!(
            is_silence(&next_tick(&mut stream.as_mut()).await),
            "underrun"
        );

        // One frame arrives and nothing more. Timeout = 2 x 3 frames = 60ms.
        tx.send(big_frame(9)).unwrap();
        let mut held = 0;
        let frame = loop {
            let frame = next_tick(&mut stream.as_mut()).await;
            if !is_silence(&frame) {
                break frame;
            }
            held += 1;
            assert!(held <= 8, "gate never released");
        };
        assert_eq!(frame[BIG_FRAME - 1], 9);
        assert!(
            held >= 4,
            "gate held for most of the timeout, held {held} ticks"
        );
        drop(tx);
    }

    /// The rebuffer timeout counts from when frames resume, not from the
    /// underrun, so a long source pause still resumes with a full margin.
    #[tokio::test(start_paused = true)]
    async fn rebuffer_timeout_counts_from_frame_resume() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            buffered_config(vec![big_frame(1)]),
            None,
            None,
        ));

        prime(&mut stream.as_mut()).await; // plays the single prefill frame
        assert!(
            is_silence(&next_tick(&mut stream.as_mut()).await),
            "underrun"
        );

        // Source pause far longer than the 60ms timeout
        for _ in 0..30 {
            assert!(is_silence(&next_tick(&mut stream.as_mut()).await));
        }

        // Frames resume one per tick: still held until depth 3
        tx.send(big_frame(10)).unwrap();
        assert!(
            is_silence(&next_tick(&mut stream.as_mut()).await),
            "depth 1 held"
        );
        tx.send(big_frame(11)).unwrap();
        assert!(
            is_silence(&next_tick(&mut stream.as_mut()).await),
            "depth 2 held"
        );
        tx.send(big_frame(12)).unwrap();
        assert_eq!(next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1], 10);
        drop(tx);
    }

    /// Closing the channel while rebuffering releases the hold so the
    /// queued tail plays out immediately and the stream ends.
    #[tokio::test(start_paused = true)]
    async fn channel_close_releases_rebuffer_gate() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            buffered_config(vec![big_frame(1)]),
            None,
            None,
        ));

        prime(&mut stream.as_mut()).await;
        assert!(
            is_silence(&next_tick(&mut stream.as_mut()).await),
            "underrun"
        );

        tx.send(big_frame(5)).unwrap();
        assert!(is_silence(&next_tick(&mut stream.as_mut()).await), "held");
        drop(tx);

        // Channel closed: the tail plays without waiting for depth/timeout
        assert_eq!(next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1], 5);
        drain_to_end(&mut stream.as_mut()).await;
    }

    // ─────────────────────────────────────────────────────────────────────
    // CadenceConfig / trim_prefill unit tests
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn cadence_config_new_computes_overflow_cap() {
        let cfg = CadenceConfig::new(
            test_silence_frame(),
            200, // 200ms jitter buffer
            0,   // no connect burst
            20,  // 20ms frames
            test_audio_format(),
            vec![],
        );
        // buffer_depth = 200 / 20 = 10; overflow_cap = 10 * JITTER_OVERFLOW_MULTIPLIER (3)
        assert_eq!(cfg.overflow_cap, 30);
    }

    #[test]
    fn cadence_config_new_respects_min_overflow_cap() {
        // jitter_buffer_ms = 0 → buffer_depth = 0 → overflow_cap clamped to MIN_OVERFLOW_CAP (1)
        let cfg = CadenceConfig::new(test_silence_frame(), 0, 0, 20, test_audio_format(), vec![]);
        assert_eq!(cfg.overflow_cap, 1);
    }

    /// Prefill frames captured one frame duration apart, oldest first, the way
    /// `StreamState::subscribe` returns them.
    fn timestamped(frames: Vec<Bytes>, frame_ms: u64) -> Vec<TimestampedFrame> {
        let start = Instant::now();
        frames
            .into_iter()
            .enumerate()
            .map(|(i, data)| TimestampedFrame {
                captured_at: start + Duration::from_millis(i as u64 * frame_ms),
                data,
            })
            .collect()
    }

    #[test]
    fn cadence_config_new_trims_prefill_to_buffer_depth() {
        let prefill = timestamped((0..20u8).map(|i| Bytes::from(vec![i; 4])).collect(), 20);
        let cfg = CadenceConfig::new(
            test_silence_frame(),
            200, // 200ms / 20ms = 10 frames buffer_depth
            0,
            20,
            test_audio_format(),
            prefill,
        );
        assert_eq!(cfg.prefill_frames.len(), 10, "trimmed to buffer_depth");
        assert_eq!(cfg.prefill_frames[0][0], 10, "oldest frames dropped");
        assert_eq!(cfg.prefill_frames[9][0], 19, "newest frame preserved");
    }

    #[test]
    fn cadence_config_new_anchors_epoch_to_first_kept_frame() {
        let prefill = timestamped((0..20u8).map(|i| Bytes::from(vec![i; 4])).collect(), 20);
        let kept_first = prefill[10].captured_at;
        let cfg = CadenceConfig::new(
            test_silence_frame(),
            200,
            0,
            20,
            test_audio_format(),
            prefill,
        );
        assert_eq!(
            cfg.epoch_candidate,
            Some(kept_first),
            "the epoch is the first frame served, not the oldest in the ring"
        );
    }

    #[test]
    fn cadence_config_new_without_prefill_has_no_epoch_candidate() {
        let cfg = CadenceConfig::new(
            test_silence_frame(),
            200,
            0,
            20,
            test_audio_format(),
            vec![],
        );
        assert_eq!(cfg.epoch_candidate, None);

        // Zero depth serves no prefill, so no prefill frame may anchor it.
        let prefill = timestamped(vec![test_audio_frame(); 3], 20);
        let cfg = CadenceConfig::new(test_silence_frame(), 0, 0, 20, test_audio_format(), prefill);
        assert_eq!(cfg.epoch_candidate, None);
    }

    /// A reconnect finds the ring full: 500 ms of frames against a 200 ms jitter
    /// buffer. The cadence serves only the newest 200 ms, so the epoch must be
    /// the capture time of the first of those, the frame the speaker plays at
    /// RelTime 0. Anchoring to the oldest ring frame read every later latency
    /// and cushion 300 ms too high.
    #[tokio::test(start_paused = true)]
    async fn epoch_anchors_to_first_frame_kept_after_trim_prefill() {
        const RING_FRAMES: usize = 50;
        const FRAME_MS: u32 = 10;
        const JITTER_MS: u64 = 200;
        let state = Arc::new(StreamState::new(
            "test-stream".to_string(),
            crate::stream::AudioCodec::Pcm,
            test_audio_format(),
            RING_FRAMES,
            RING_FRAMES * 2,
            JITTER_MS,
            FRAME_MS,
        ));
        let _keepalive = state.tx.subscribe();
        for i in 0..RING_FRAMES {
            // Capture times come from the real clock; space the frames so the
            // oldest and the first kept frame are distinguishable.
            if i == 1 {
                std::thread::sleep(Duration::from_millis(2));
            }
            state.push_frame(big_frame(i as u8 + 1));
        }

        let (prefill, rx) = state.subscribe();
        assert_eq!(prefill.len(), RING_FRAMES, "the ring is full");
        let oldest = prefill[0].captured_at;
        let kept = RING_FRAMES - (JITTER_MS / FRAME_MS as u64) as usize;
        let first_kept = prefill[kept].captured_at;
        assert!(first_kept > oldest);

        let remote = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));
        let config = CadenceConfig::new(
            test_silence_frame(),
            JITTER_MS,
            0,
            FRAME_MS,
            test_audio_format(),
            prefill,
        );
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            config,
            Some(Arc::downgrade(&state)),
            Some(EpochHook::new(
                Arc::downgrade(&state),
                Instant::now(),
                remote,
            )),
        ));

        let first = stream.next().await.expect("first tick").expect("ok");
        assert_eq!(
            first[BIG_FRAME - 1],
            kept as u8 + 1,
            "the first frame served is the first kept after trimming"
        );
        let epoch = state
            .timing
            .current_epoch_for(remote)
            .expect("the first real frame starts an epoch");
        assert_eq!(epoch.audio_epoch, first_kept);
        assert_ne!(epoch.audio_epoch, oldest);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Connect burst
    // ─────────────────────────────────────────────────────────────────────

    /// Every frame the stream yields without time moving on: the connect
    /// burst and the metronome's immediate first tick.
    async fn ready_now<S>(stream: &mut Pin<&mut S>) -> Vec<Bytes>
    where
        S: Stream<Item = Result<Bytes, std::io::Error>> + ?Sized,
    {
        poll_fn(|cx| {
            let mut frames = Vec::new();
            while let Poll::Ready(Some(item)) = stream.as_mut().poll_next(cx) {
                frames.push(item.expect("ok"));
            }
            Poll::Ready(frames)
        })
        .await
    }

    /// `n` big frames tagged `1..=n`, captured 10 ms apart.
    fn tagged_prefill(n: u8) -> Vec<TimestampedFrame> {
        timestamped((1..=n).map(big_frame).collect(), 10)
    }

    fn tags(frames: &[Bytes]) -> Vec<u8> {
        frames.iter().map(|f| f[f.len() - 1]).collect()
    }

    /// 30 ms jitter buffer (3 frames) and a 50 ms burst (5 frames) out of a
    /// 10-frame ring: the oldest two frames are dropped, the next five are
    /// burst, and the newest three stay queued.
    fn burst_config(prefill: Vec<TimestampedFrame>, burst_ms: u64) -> CadenceConfig {
        CadenceConfig::new(
            Bytes::from(vec![0u8; BIG_FRAME]),
            30,
            burst_ms,
            SILENCE_FRAME_DURATION_MS,
            test_audio_format(),
            prefill,
        )
    }

    /// The burst goes out before the metronome has moved at all, then the
    /// queue, still a full jitter buffer deep, is paced out one frame per
    /// tick. Without the burst only the first tick's frame is ready at once.
    #[tokio::test(start_paused = true)]
    async fn connect_burst_is_sent_at_once_then_paced() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            burst_config(tagged_prefill(10), 50),
            None,
            None,
        ));

        assert_eq!(
            tags(&ready_now(&mut stream.as_mut()).await),
            vec![3, 4, 5, 6, 7, 8],
            "five burst frames and the first tick, before any time passes"
        );
        assert!(
            ready_now(&mut stream.as_mut()).await.is_empty(),
            "nothing more until the next tick"
        );

        // The queue holds exactly the jitter buffer: three frames, one per
        // tick (the first went out on the immediate tick), then an underrun.
        tx.send(big_frame(11)).unwrap();
        assert_eq!(next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1], 9);
        assert!(ready_now(&mut stream.as_mut()).await.is_empty());
        assert_eq!(next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1], 10);
        assert_eq!(
            next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1],
            11,
            "live frames follow the queue with no gap or repeat"
        );
        assert!(is_silence(&next_tick(&mut stream.as_mut()).await));
        drop(tx);
    }

    /// A connection slow to take the burst loses nothing at the handover:
    /// the live frames that pile up meanwhile are all queued, the missed
    /// ticks replay them in order, and the queue is back at the jitter buffer
    /// afterwards. Here the burst stalls for 200 ms after two frames, far
    /// longer than twice the 30 ms jitter buffer the overflow cap allows for.
    #[tokio::test(start_paused = true)]
    async fn slow_connect_burst_drops_nothing_at_the_handover() {
        let (tx, rx) = broadcast::channel::<Bytes>(32);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            burst_config(tagged_prefill(10), 50),
            None,
            None,
        ));

        // The connection takes two burst frames, then stalls.
        let taken: Vec<Bytes> = poll_fn(|cx| {
            let mut frames = Vec::new();
            for _ in 0..2 {
                if let Poll::Ready(Some(item)) = stream.as_mut().poll_next(cx) {
                    frames.push(item.expect("ok"));
                }
            }
            Poll::Ready(frames)
        })
        .await;
        assert_eq!(tags(&taken), vec![3, 4]);

        // 200 ms pass (21 ticks counting the immediate first one), and 21
        // live frames arrive, before the connection takes anything more.
        for tag in 11..=31 {
            tx.send(big_frame(tag)).unwrap();
        }
        time::advance(Duration::from_millis(200)).await;

        assert_eq!(
            tags(&ready_now(&mut stream.as_mut()).await),
            (5..=28).collect::<Vec<u8>>(),
            "the rest of the burst, then the queue and live frames, with no gap"
        );

        // Three frames, the jitter buffer, are still queued.
        assert_eq!(next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1], 29);
        assert_eq!(next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1], 30);
        assert_eq!(next_tick(&mut stream.as_mut()).await[BIG_FRAME - 1], 31);
        assert!(is_silence(&next_tick(&mut stream.as_mut()).await));
        drop(tx);
    }

    /// The queue after the burst is the configured jitter buffer, however
    /// large the burst.
    #[test]
    fn connect_burst_leaves_the_jitter_buffer_queued() {
        let cfg = burst_config(tagged_prefill(10), 50);
        assert_eq!(cfg.buffer_depth, 3);
        assert_eq!(tags(&cfg.burst_frames), vec![3, 4, 5, 6, 7]);
        assert_eq!(tags(&cfg.prefill_frames), vec![8, 9, 10]);
        assert_eq!(cfg.burst_ms(), 50);
    }

    /// A ring holding less than the burst plus the jitter buffer keeps the
    /// jitter buffer and bursts only what is left; one holding no more than
    /// the jitter buffer bursts nothing. No silence is invented either way.
    #[test]
    fn connect_burst_is_clamped_to_the_audio_available() {
        let cfg = burst_config(tagged_prefill(5), 50);
        assert_eq!(tags(&cfg.burst_frames), vec![1, 2]);
        assert_eq!(tags(&cfg.prefill_frames), vec![3, 4, 5]);

        let cfg = burst_config(tagged_prefill(2), 50);
        assert!(cfg.burst_frames.is_empty());
        assert_eq!(tags(&cfg.prefill_frames), vec![1, 2]);
        assert!(cfg.epoch_candidate.is_some());
    }

    /// Asking for more than the maximum bursts the maximum.
    #[test]
    fn connect_burst_is_capped_at_the_maximum() {
        use crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
        let frames = (MAX_PCM_CONNECT_BURST_MS / 10) as usize + 3 + 50;
        let prefill = timestamped(vec![test_audio_frame(); frames], 10);
        let cfg = CadenceConfig::new(
            test_silence_frame(),
            30,
            u64::MAX,
            SILENCE_FRAME_DURATION_MS,
            test_audio_format(),
            prefill,
        );
        assert_eq!(cfg.burst_ms(), MAX_PCM_CONNECT_BURST_MS);
        assert_eq!(cfg.prefill_frames.len(), 3);
    }

    /// A burst of 0 is the stream as it was: the prefill trimmed to the
    /// jitter buffer, the first of it on the immediate tick and one frame per
    /// tick after, byte for byte.
    #[tokio::test(start_paused = true)]
    async fn zero_connect_burst_is_the_unburst_stream() {
        let prefill = tagged_prefill(10);
        let expected: Vec<Bytes> = prefill[7..].iter().map(|f| f.data.clone()).collect();
        let cfg = burst_config(prefill, 0);
        assert!(cfg.burst_frames.is_empty());
        assert_eq!(cfg.prefill_frames, expected);

        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            cfg,
            None,
            None,
        ));
        let mut out = ready_now(&mut stream.as_mut()).await;
        assert_eq!(out.len(), 1, "only the first tick is ready at once");
        out.push(next_tick(&mut stream.as_mut()).await);
        out.push(next_tick(&mut stream.as_mut()).await);
        assert_eq!(out, expected);
        drop(tx);
    }

    /// The first frame the speaker plays with a burst is the first burst
    /// frame, so the epoch, and every latency and reserve reckoned from it,
    /// is anchored there.
    #[tokio::test(start_paused = true)]
    async fn epoch_anchors_to_the_first_burst_frame() {
        let state = Arc::new(StreamState::new(
            "test-stream".to_string(),
            crate::stream::AudioCodec::Pcm,
            test_audio_format(),
            50,
            100,
            30,
            SILENCE_FRAME_DURATION_MS,
        ));
        let _keepalive = state.tx.subscribe();
        for i in 0..20u8 {
            if i == 12 {
                // Separate the first burst frame's capture time from the
                // first queued frame's.
                std::thread::sleep(Duration::from_millis(2));
            }
            state.push_frame(big_frame(i + 1));
        }
        let (prefill, rx) = state.subscribe();
        let first_burst = prefill[12].captured_at;
        let first_queued = prefill[17].captured_at;
        assert!(first_queued > first_burst);

        let remote = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));
        let cfg = burst_config(prefill, 50);
        assert_eq!(cfg.epoch_candidate, Some(first_burst));
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            cfg,
            Some(Arc::downgrade(&state)),
            Some(EpochHook::new(
                Arc::downgrade(&state),
                Instant::now(),
                remote,
            )),
        ));
        let first = stream.next().await.expect("first frame").expect("ok");
        assert_eq!(
            first[BIG_FRAME - 1],
            13,
            "the first burst frame is served first"
        );
        let epoch = state
            .timing
            .current_epoch_for(remote)
            .expect("the burst starts the epoch");
        assert_eq!(epoch.audio_epoch, first_burst);
    }

    #[test]
    fn trim_prefill_keeps_newest_when_overflowing() {
        let prefill: Vec<Bytes> = (0..5u8).map(|i| Bytes::from(vec![i; 4])).collect();
        let trimmed = trim_prefill(prefill, 3);
        assert_eq!(trimmed.len(), 3, "trim to buffer_depth");
        assert_eq!(trimmed[0][0], 2, "oldest frames dropped");
        assert_eq!(trimmed[1][0], 3);
        assert_eq!(trimmed[2][0], 4, "newest frame preserved");
    }

    #[test]
    fn trim_prefill_zero_depth_drops_all() {
        let prefill: Vec<Bytes> = (0..3u8).map(|i| Bytes::from(vec![i; 4])).collect();
        let trimmed = trim_prefill(prefill, 0);
        assert!(trimmed.is_empty(), "buffer_depth=0 drops all prefill");
    }

    #[test]
    fn trim_prefill_under_depth_preserves_all() {
        let prefill: Vec<Bytes> = (0..2u8).map(|i| Bytes::from(vec![i; 4])).collect();
        let trimmed = trim_prefill(prefill, 5);
        assert_eq!(trimmed.len(), 2, "prefill under depth is preserved");
        assert_eq!(trimmed[0][0], 0);
        assert_eq!(trimmed[1][0], 1);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Drift correction
    // ─────────────────────────────────────────────────────────────────────

    /// Sample frames in 10 ms of 48 kHz audio.
    const PCM_FRAME_SAMPLES: usize = 480;

    /// Frame `i` of one continuous two-tone signal, 10 ms of 48 kHz stereo,
    /// the right channel the left inverted.
    fn pcm_frame(i: usize) -> Bytes {
        let mut out = Vec::with_capacity(PCM_FRAME_SAMPLES * 4);
        for n in 0..PCM_FRAME_SAMPLES {
            let t = (i * PCM_FRAME_SAMPLES + n) as f64 / 48_000.0;
            let tone = |f: f64, a: f64| a * (2.0 * std::f64::consts::PI * f * t).sin();
            let v = (tone(1_000.0, 9_000.0) + tone(6_000.0, 4_000.0)).round() as i16;
            out.extend_from_slice(&v.to_le_bytes());
            out.extend_from_slice(&(-v).to_le_bytes());
        }
        Bytes::from(out)
    }

    fn pcm_silence() -> Bytes {
        Bytes::from(vec![0u8; PCM_FRAME_SAMPLES * 4])
    }

    /// The samples of `frames`, end to end.
    fn samples(frames: &[Bytes]) -> Vec<i16> {
        frames
            .iter()
            .flat_map(|f| f.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])))
            .collect()
    }

    /// What one adapter fed `frames` in order at `ppm` emits for each.
    fn through_one_adapter(frames: &[Bytes], ppm: f64) -> Vec<Bytes> {
        let mut adapter = RateAdapter::new(&test_audio_format()).unwrap();
        frames.iter().map(|f| adapter.process(f, ppm)).collect()
    }

    fn control_at(ppm: f64) -> Arc<RateControl> {
        let control = Arc::new(RateControl::new());
        control.set_ppm(ppm);
        control
    }

    /// Ten frames of ring, a 30 ms jitter buffer and a 50 ms connect burst:
    /// frames 2..=6 are burst, 7..=9 queued.
    fn pcm_burst_config(control: Option<Arc<RateControl>>) -> (CadenceConfig, Vec<Bytes>) {
        let ring: Vec<Bytes> = (0..10).map(pcm_frame).collect();
        let config = CadenceConfig::new(
            pcm_silence(),
            30,
            50,
            SILENCE_FRAME_DURATION_MS,
            test_audio_format(),
            timestamped(ring.clone(), 10),
        );
        let config = match control {
            Some(control) => config.with_rate_control(control),
            None => config,
        };
        (config, ring)
    }

    /// The connect burst, the first tick, then three more ticks with one
    /// live frame (10) sent: everything the stream emits for frames 2..=10.
    async fn burst_then_ticks(config: CadenceConfig) -> Vec<Bytes> {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            config,
            None,
            None,
        ));
        let mut out = ready_now(&mut stream.as_mut()).await;
        assert_eq!(out.len(), 6, "five burst frames and the first tick");
        tx.send(pcm_frame(10)).unwrap();
        for _ in 0..3 {
            out.push(next_tick(&mut stream.as_mut()).await);
        }
        drop(tx);
        out
    }

    /// The adapter is built before the burst: burst and metronome frames go
    /// through one filter, so at 0 ppm the whole connection is the input
    /// delayed by the adapter's 16 samples, once, with nothing lost, added
    /// or restarted at the handover.
    #[tokio::test(start_paused = true)]
    async fn burst_and_tick_frames_share_filter_state() {
        let (config, ring) = pcm_burst_config(Some(control_at(0.0)));
        let out = burst_then_ticks(config).await;

        let mut sent: Vec<Bytes> = ring[2..].to_vec();
        sent.push(pcm_frame(10));
        let input = samples(&sent);
        let output = samples(&out);
        assert_eq!(output.len(), input.len());
        let delay = 2 * crate::stream::rate_adapter::RATE_ADAPTER_DELAY_FRAMES;
        assert!(output[..delay].iter().all(|&s| s == 0));
        assert_eq!(
            &output[delay..],
            &input[..input.len() - delay],
            "one continuous filter from the first burst frame to the last tick"
        );

        // At a real rate the stream matches one adapter fed the same frames.
        let (config, _) = pcm_burst_config(Some(control_at(150.0)));
        let out = burst_then_ticks(config).await;
        assert_eq!(out, through_one_adapter(&sent, 150.0));
    }

    /// Runs an underrun and recovery through a 3-frame jitter buffer and
    /// returns every frame emitted: prefill, the fade-out that starts the
    /// silence, held silence while rebuffering, the faded-in frame that
    /// resumes, and the fade-out after it.
    async fn underrun_and_recovery(control: Option<Arc<RateControl>>) -> Vec<Bytes> {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let config = CadenceConfig {
            silence_frame: pcm_silence(),
            overflow_cap: 6,
            buffer_depth: 3,
            frame_duration_ms: SILENCE_FRAME_DURATION_MS,
            audio_format: test_audio_format(),
            burst_frames: vec![],
            prefill_frames: (0..3).map(pcm_frame).collect(),
            epoch_candidate: None,
            rate_control: control,
        };
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            test_guard(),
            config,
            None,
            None,
        ));
        let mut out = ready_now(&mut stream.as_mut()).await;
        for _ in 0..3 {
            out.push(next_tick(&mut stream.as_mut()).await);
        }
        for i in 10..13 {
            tx.send(pcm_frame(i)).unwrap();
            out.push(next_tick(&mut stream.as_mut()).await);
        }
        for _ in 0..4 {
            out.push(next_tick(&mut stream.as_mut()).await);
        }
        drop(tx);
        out
    }

    /// Silence, fade-out and fade-in frames pass the adapter like audio
    /// does, in order, through the same filter state: the corrected stream
    /// is exactly the uncorrected one fed through one adapter.
    #[tokio::test(start_paused = true)]
    async fn silence_and_fade_frames_pass_the_adapter() {
        let plain = underrun_and_recovery(None).await;
        let first = |f: &Bytes| i16::from_le_bytes([f[0], f[1]]);
        let last = |f: &Bytes| i16::from_le_bytes([f[f.len() - 4], f[f.len() - 3]]);
        // The scenario covers every kind of frame the cadence makes.
        assert_eq!(&plain[..3], &(0..3).map(pcm_frame).collect::<Vec<_>>()[..]);
        assert!(first(&plain[3]) != 0 && last(&plain[3]) == 0, "fade-out");
        assert!(
            plain[4..6].iter().all(|f| f == &pcm_silence()),
            "held silence"
        );
        let fade_in = &plain[6];
        assert!(first(fade_in) == 0 && fade_in != &pcm_frame(10), "fade-in");
        assert_eq!(
            fade_in[fade_in.len() - 4..],
            pcm_frame(10)[pcm_frame(10).len() - 4..]
        );
        assert!(
            first(&plain[9]) != 0 && last(&plain[9]) == 0,
            "second fade-out"
        );
        assert_eq!(plain[10], pcm_silence());

        let shaped = underrun_and_recovery(Some(control_at(200.0))).await;
        assert_eq!(shaped.len(), plain.len());
        assert_eq!(shaped, through_one_adapter(&plain, 200.0));
    }

    /// Drift correction off, or only observing, builds no adapter: every
    /// frame, connect burst included, goes out as the very buffer that was
    /// captured. An adapter, even at 0 ppm, would change every byte.
    #[tokio::test(start_paused = true)]
    async fn observe_output_byte_identical_including_burst() {
        let (config, ring) = pcm_burst_config(None);
        let out = burst_then_ticks(config).await;
        let mut sent: Vec<Bytes> = ring[2..].to_vec();
        sent.push(pcm_frame(10));
        assert_eq!(out, sent);
        for (got, want) in out.iter().zip(&ring[2..]) {
            assert_eq!(got.as_ptr(), want.as_ptr(), "zero-copy");
        }

        let (config, _) = pcm_burst_config(Some(control_at(0.0)));
        assert_ne!(burst_then_ticks(config).await, sent);
    }

    /// Past the net-insertion limit the adapter holds at 0 ppm for the rest
    /// of the connection, still engaged, and says so on the control.
    #[test]
    fn net_insertion_past_the_limit_pins_the_adapter_at_0ppm() {
        let control = control_at(300.0);
        let mut hook = DriftHook::new(
            Arc::clone(&control),
            &test_audio_format(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        )
        .unwrap();
        assert_eq!(hook.net_limit_frames, 96_000, "two seconds at 48 kHz");
        hook.net_limit_frames = 10;
        let frame = pcm_frame(0);
        for _ in 0..100 {
            hook.apply(&frame);
        }
        assert!(control.is_pinned());
        let net = control.net_inserted_frames();
        assert_eq!(net, hook.adapter.net_frames());
        assert!(net > 10 && net <= 12, "{net}");
        for _ in 0..100 {
            let out = hook.apply(&frame);
            assert_eq!(out.len(), frame.len(), "0 ppm once pinned");
        }
        assert_eq!(control.net_inserted_frames(), net);
    }

    #[test]
    fn a_format_the_adapter_cannot_take_gets_no_drift_correction() {
        let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert!(DriftHook::new(control_at(100.0), &AudioFormat::new(48_000, 2, 24), ip).is_none());
        assert!(DriftHook::new(control_at(100.0), &AudioFormat::new(48_000, 6, 16), ip).is_none());
    }
}
