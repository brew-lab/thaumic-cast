//! Fixed-cadence audio streaming with delivery tracking.
//!
//! This module contains the cadence streaming pipeline that maintains real-time
//! audio output regardless of input timing, and the delivery tracking guard that
//! logs stream lifecycle and timing diagnostics.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::{interval, Instant as TokioInstant, MissedTickBehavior};

use super::framing::{BodyFraming, EndedBy};
use super::manager::TimestampedFrame;
use super::tap::{ConnectionTap, MonitorRegistrar};
use super::{
    apply_fade_in, create_fade_out_frame, crossfade_samples, extract_last_sample_pair,
    is_crossfade_compatible, AudioFormat, StreamState,
};

/// One-shot epoch hook: the stream to time, the moment the client connected,
/// the client address, and, for a monitored connection, its tap and where to
/// register it.
///
/// The epoch's content T0 is not part of the hook. It is the capture time of
/// the first frame the connection actually serves, which only the pipeline
/// knows once it has trimmed the prefill (see [`CadenceConfig::epoch_candidate`]).
///
/// Holds a [`std::sync::Weak`] reference to the stream on purpose. The response
/// body outlives the handler, so a strong `Arc` here would keep the
/// [`StreamState`] — and with it the broadcast sender — alive after the
/// coordinator removed the stream, leaving the connection streaming to a
/// stream that no longer exists. The tap holds nothing of the stream.
pub struct EpochHook {
    stream: std::sync::Weak<StreamState>,
    connected_at: Instant,
    remote_ip: IpAddr,
    monitor: Option<(Arc<ConnectionTap>, MonitorRegistrar)>,
}

impl EpochHook {
    /// A hook that starts the connection's playback epoch.
    pub fn new(
        stream: std::sync::Weak<StreamState>,
        connected_at: Instant,
        remote_ip: IpAddr,
    ) -> Self {
        Self {
            stream,
            connected_at,
            remote_ip,
            monitor: None,
        }
    }

    /// Also registers the connection with the speaker monitor once its epoch
    /// has started.
    #[must_use]
    pub fn with_monitor(mut self, tap: Arc<ConnectionTap>, registrar: MonitorRegistrar) -> Self {
        self.monitor = Some((tap, registrar));
        self
    }

    /// Whether the stream the hook would time still exists.
    pub(crate) fn stream_alive(&self) -> bool {
        self.stream.strong_count() > 0
    }

    /// Starts the playback epoch, anchored to `epoch_candidate`, and then
    /// registers the connection with the monitor. Does nothing if the stream
    /// has been removed: there is no epoch left to start.
    ///
    /// Registration comes second so the monitor never sees a connection
    /// without its epoch. It never blocks (see [`MonitorRegistrar::register`]).
    pub(crate) fn fire(self, epoch_candidate: Option<Instant>) {
        let Some(state) = self.stream.upgrade() else {
            return;
        };
        let epoch = state.timing.start_new_epoch(
            epoch_candidate,
            self.connected_at,
            self.remote_ip,
            self.monitor.as_ref().map(|(tap, _)| Arc::downgrade(tap)),
        );
        if let Some((tap, registrar)) = self.monitor {
            tap.set_epoch(epoch);
            registrar.register(&tap);
        }
    }
}

/// Threshold for counting delivery gaps (100ms).
/// PCM at 48kHz stereo 16-bit = 192KB/s, so 100ms = ~19KB of audio.
const DELIVERY_GAP_THRESHOLD_MS: u64 = 100;

/// Only log gaps exceeding this threshold to avoid log spam (500ms).
const DELIVERY_GAP_LOG_THRESHOLD_MS: u64 = 500;

/// How long a connection that waited before its response must stay open to
/// count as having survived the wait. A speaker that refuses a long wait
/// closes the connection, or stops playing and closes it, within a second or
/// two of the response starting; one still being fed after this has taken it.
pub const FIRST_WAIT_SURVIVAL: Duration = Duration::from_secs(5);

/// How long a speaker's first connection waited before its response
/// started, and why: the smoothing (jitter buffer) plus the configured
/// speaker head start, less how long the stream had already been running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstConnectionWait {
    /// Milliseconds the connection was held before the response.
    pub waited_ms: u64,
    /// The stream's smoothing (jitter buffer), ms.
    pub smoothing_ms: u64,
    /// The configured speaker head start, ms.
    pub head_start_ms: u64,
}

/// Watches a speaker's first connection through its wait before the
/// response, so a speaker that hangs up during the wait is logged.
///
/// Once the response starts, [`LoggingStreamGuard::with_first_wait`] logs
/// whether the connection survived. A speaker that refuses a long wait is
/// likely to close the connection before any response headers arrive,
/// though, and the server then drops the handler while it is still waiting,
/// before any guard exists. Arm this before the wait and call
/// [`Self::completed`] once the wait is over; dropped while still armed, it
/// logs how far into the wait the speaker hung up.
#[must_use = "dropping the watch at once logs the wait as not survived"]
pub struct FirstWaitWatch {
    wait: FirstConnectionWait,
    client_ip: IpAddr,
    stream_id: String,
    started: tokio::time::Instant,
    armed: bool,
    /// Where a test learns how far into the wait the watch was dropped.
    #[cfg(test)]
    hung_up_after: Option<Arc<parking_lot::Mutex<Option<Duration>>>>,
}

impl FirstWaitWatch {
    /// Arms a watch over `wait`, starting now.
    pub fn arm(wait: FirstConnectionWait, client_ip: IpAddr, stream_id: &str) -> Self {
        Self {
            wait,
            client_ip,
            stream_id: stream_id.to_string(),
            started: tokio::time::Instant::now(),
            armed: true,
            #[cfg(test)]
            hung_up_after: None,
        }
    }

    /// Disarms the watch: the wait ran its course with the connection open.
    pub fn completed(mut self) {
        self.armed = false;
    }
}

impl Drop for FirstWaitWatch {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let elapsed = self.started.elapsed();
        #[cfg(test)]
        if let Some(cell) = &self.hung_up_after {
            *cell.lock() = Some(elapsed);
        }
        log::warn!(
            "[Stream] First-connection wait not survived: client={}, stream={}, the speaker hung \
             up {}ms into a {}ms wait (smoothing {}ms + head start {}ms), before the response \
             started; unless the cast was stopped or regrouped, if this repeats the speaker may \
             not accept a wait this long, so try a shorter speaker head start",
            self.client_ip,
            self.stream_id,
            elapsed.as_millis(),
            self.wait.waited_ms,
            self.wait.smoothing_ms,
            self.wait.head_start_ms
        );
    }
}

/// Environment variable that overrides the PCM connect burst setting, in
/// milliseconds (`0` turns it off). See [`crate::Config::pcm_connect_burst_ms`].
pub const PCM_CONNECT_BURST_ENV: &str = "THAUMIC_PCM_CONNECT_BURST_MS";

/// Parses a PCM connect burst in milliseconds: a whole number from `0` to
/// [`MAX_PCM_CONNECT_BURST_MS`].
///
/// [`MAX_PCM_CONNECT_BURST_MS`]: crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS
pub fn parse_pcm_connect_burst_ms(value: &str) -> Result<u64, String> {
    use crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
    let ms: u64 = value.trim().parse().map_err(|_| {
        format!("expected milliseconds (0-{MAX_PCM_CONNECT_BURST_MS}), got {value:?}")
    })?;
    if ms > MAX_PCM_CONNECT_BURST_MS {
        return Err(format!(
            "at most {MAX_PCM_CONNECT_BURST_MS} ms, got {ms} ms"
        ));
    }
    Ok(ms)
}

/// The value [`PCM_CONNECT_BURST_ENV`] forces the setting to, if it is set to
/// something valid. An invalid value is ignored, with a warning the first
/// time it is seen.
pub fn pcm_connect_burst_env_override() -> Option<u64> {
    static WARNED: std::sync::Once = std::sync::Once::new();
    let raw = std::env::var(PCM_CONNECT_BURST_ENV).ok()?;
    match pcm_connect_burst_override_from(&raw) {
        Ok(ms) => ms,
        Err(e) => {
            WARNED.call_once(|| {
                log::warn!(
                    "[Stream] Ignoring {}={:?}: {}",
                    PCM_CONNECT_BURST_ENV,
                    raw,
                    e
                );
            });
            None
        }
    }
}

/// The override a raw [`PCM_CONNECT_BURST_ENV`] value asks for: `None` when it
/// is blank, the parsed value when it is valid.
fn pcm_connect_burst_override_from(raw: &str) -> Result<Option<u64>, String> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    parse_pcm_connect_burst_ms(raw).map(Some)
}

/// The PCM connect burst for a new connection, in milliseconds, given the
/// configured setting.
///
/// [`PCM_CONNECT_BURST_ENV`] overrides `configured` when set to a valid
/// value, and the result is clamped to [`MAX_PCM_CONNECT_BURST_MS`]. Read
/// once per connection.
///
/// [`MAX_PCM_CONNECT_BURST_MS`]: crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS
pub fn pcm_connect_burst_ms(configured: u64) -> u64 {
    resolve_pcm_connect_burst_ms(configured, pcm_connect_burst_env_override())
}

/// [`pcm_connect_burst_ms`] without the environment.
fn resolve_pcm_connect_burst_ms(configured: u64, env_override: Option<u64>) -> u64 {
    use crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
    let ms = env_override.unwrap_or(configured);
    if ms > MAX_PCM_CONNECT_BURST_MS {
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| {
            log::warn!(
                "[Stream] PCM connect burst of {}ms is above the {}ms maximum; using {}ms",
                ms,
                MAX_PCM_CONNECT_BURST_MS,
                MAX_PCM_CONNECT_BURST_MS
            );
        });
    }
    ms.min(MAX_PCM_CONNECT_BURST_MS)
}

/// Creates an IO error for broadcast channel lag.
///
/// Logs a warning and returns a formatted error. Centralizes the handling
/// of `BroadcastStreamRecvError::Lagged` to avoid duplication.
pub fn lagged_error(frames: u64) -> std::io::Error {
    log::warn!(
        "[Stream] Broadcast receiver lagged by {} frames - possible CPU contention",
        frames
    );
    std::io::Error::other(format!("lagged by {} frames", frames))
}

/// Logs a rate-limited warning when the broadcast receiver lags.
fn log_lagged(n: u64, last_log: &mut Option<TokioInstant>, context: &str) {
    let now = TokioInstant::now();
    if last_log.map_or(true, |t| now.duration_since(t).as_secs() >= 1) {
        log::warn!("[Stream] Lagged by {n} frames{context}");
        *last_log = Some(now);
    }
}

/// Statistics from the cadence stream, written once when the stream ends.
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

/// Maximum pipeline snapshots to keep (300 entries × 500 ms = 2.5 minutes at
/// the default 10 ms frame).
const MAX_PIPELINE_SNAPSHOTS: usize = 300;

/// Receive jitter window for a pipeline snapshot.
#[derive(Serialize)]
struct ReceiveWindow {
    frames_received: u64,
    min_gap_ms: u64,
    max_gap_ms: u64,
    gaps_over_threshold: u64,
}

/// Cadence buffer window for a pipeline snapshot.
#[derive(Serialize)]
struct CadenceWindow {
    queue_len: usize,
    silence_events: u64,
    silence_frames: u64,
    drops: u64,
}

/// HTTP delivery window for a pipeline snapshot.
#[derive(Serialize)]
struct DeliveryWindow {
    frames_sent: u64,
    bytes_per_second: u64,
    max_gap_ms: u64,
    gaps_over_threshold: u64,
}

/// Timestamped pipeline health snapshot, captured every 50 cadence ticks
/// (500 ms at the default 10 ms frame).
#[derive(Serialize)]
struct PipelineSnapshot {
    elapsed_ms: u64,
    receive: ReceiveWindow,
    cadence: CadenceWindow,
    delivery: DeliveryWindow,
    /// TCP statistics for the speaker's connection since the last snapshot,
    /// where the platform reports them. This is the only window that can see
    /// a Wi-Fi stall: the kernel's send buffer hides it from `delivery`.
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<crate::api::link::TcpLinkWindow>,
    /// What the speaker monitor last concluded about the speaker at the
    /// other end: its reserve and its clock against ours.
    #[serde(skip_serializing_if = "Option::is_none")]
    speaker: Option<super::tap::SpeakerSnapshot>,
}

/// The parts of one pipeline snapshot the speaker monitor rolls up into its
/// 30-second log line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PipelineSample {
    /// Frames queued in the cadence buffer.
    pub queue_len: usize,
    /// Longest gap between delivered frames in the snapshot's window.
    pub max_gap_ms: u64,
    /// TCP retransmissions in the snapshot's window, where reported.
    pub retransmitted: Option<u64>,
    /// Bytes handed over but not yet acknowledged by the speaker at the
    /// time of the snapshot, where reported.
    pub unacked_bytes: Option<u64>,
}

/// Wrapper that logs HTTP audio stream lifecycle and tracks delivery timing.
///
/// Delivery gap tracking uses lock-free atomics on the hot path.
/// Cadence-specific statistics (silence, drops) are tracked locally in
/// the cadence stream and written here once at stream end.
pub struct LoggingStreamGuard {
    stream_id: String,
    client_ip: IpAddr,
    /// Monotonic reference for computing delivery timestamps.
    reference_time: Instant,
    frames_sent: AtomicU64,
    /// Elapsed nanos since `reference_time` of the last delivered frame (0 = none).
    last_delivery_nanos: AtomicU64,
    max_gap_ms: AtomicU64,
    gaps_over_threshold: AtomicU64,
    first_error: parking_lot::Mutex<Option<String>>,
    /// Cadence-specific stats, set once when the cadence stream ends.
    cadence_stats: OnceLock<CadenceStats>,
    /// Total bytes delivered to HTTP client (for throughput calculation).
    pub(crate) bytes_sent: AtomicU64,
    /// Bytes the body has put on the wire (see [`BodyFraming::wire_len`]).
    wire_bytes: AtomicU64,
    /// How the response body is delimited, where the handler recorded it.
    /// `None` counts wire bytes as payload and declares no length.
    framing: Option<BodyFraming>,
    /// Whether the body ran out on our side: the stream feeding it ended.
    source_ended: AtomicBool,
    /// Whether a test cap ended the body (see [`Self::mark_server_cap`]).
    server_capped: AtomicBool,
    /// Per-interval max delivery gap in ms (swapped to 0 on each snapshot).
    interval_max_gap_ms: AtomicU64,
    /// Pipeline timeline, updated periodically by the cadence stream.
    /// Uses Mutex (not OnceLock) because the cadence stream may be dropped
    /// mid-loop when Sonos closes HTTP, before it can write a final value.
    pipeline_timeline: parking_lot::Mutex<VecDeque<PipelineSnapshot>>,
    /// TCP statistics probe for the client's connection, when available.
    link_probe: Option<crate::api::link::TcpLinkProbe>,
    /// When retransmissions were last reported, to rate-limit the warning.
    last_retransmit_warning: parking_lot::Mutex<Option<Instant>>,
    /// Judges the connection from its samples and logs quality changes.
    link_judge: parking_lot::Mutex<Option<crate::api::link::LinkJudge>>,
    /// Where the cadence reports audio reaching this machine late (see
    /// [`crate::stream::ingest_gaps`]). `None` reports nothing.
    events: Option<Arc<dyn crate::events::EventEmitter>>,
    /// The speaker monitor's latest figures for this connection.
    pub(crate) speaker: super::tap::SpeakerCell,
    /// The latest link verdict, as [`link_quality_code`] encodes it (`0`
    /// before the first one).
    link_verdict: AtomicU8,
    /// The wait before the response, for a speaker's first connection that
    /// was held for one.
    first_wait: Option<FirstConnectionWait>,
    /// Whether the connection has been logged as surviving
    /// [`Self::first_wait`].
    first_wait_survived: AtomicBool,
    /// Whether the response body has been dropped. The socket handle the
    /// link probe reads may be reused once it has, so reads from outside
    /// the body stop then.
    body_closed: AtomicBool,
}

/// [`LinkQuality`](crate::events::LinkQuality) as stored in
/// [`LoggingStreamGuard::link_verdict`].
fn link_quality_code(quality: crate::events::LinkQuality) -> u8 {
    use crate::events::LinkQuality;
    match quality {
        LinkQuality::Good => 1,
        LinkQuality::Degraded => 2,
        LinkQuality::Poor => 3,
    }
}

impl LoggingStreamGuard {
    /// Creates a new guard that logs stream lifecycle events.
    pub fn new(stream_id: String, client_ip: IpAddr) -> Self {
        log::info!(
            "[Stream] HTTP stream started: stream={}, client={}",
            stream_id,
            client_ip
        );
        Self {
            stream_id,
            client_ip,
            reference_time: Instant::now(),
            frames_sent: AtomicU64::new(0),
            last_delivery_nanos: AtomicU64::new(0),
            max_gap_ms: AtomicU64::new(0),
            gaps_over_threshold: AtomicU64::new(0),
            first_error: parking_lot::Mutex::new(None),
            cadence_stats: OnceLock::new(),
            bytes_sent: AtomicU64::new(0),
            wire_bytes: AtomicU64::new(0),
            framing: None,
            source_ended: AtomicBool::new(false),
            server_capped: AtomicBool::new(false),
            interval_max_gap_ms: AtomicU64::new(0),
            pipeline_timeline: parking_lot::Mutex::new(VecDeque::new()),
            link_probe: None,
            last_retransmit_warning: parking_lot::Mutex::new(None),
            link_judge: parking_lot::Mutex::new(None),
            events: None,
            speaker: super::tap::SpeakerCell::default(),
            link_verdict: AtomicU8::new(0),
            first_wait: None,
            first_wait_survived: AtomicBool::new(false),
            body_closed: AtomicBool::new(false),
        }
    }

    /// Records that this connection was held for `wait` before its response
    /// started, so whether the speaker kept the connection through it is
    /// logged: once it has been fed for [`FIRST_WAIT_SURVIVAL`], or when it
    /// ends sooner.
    #[must_use]
    pub fn with_first_wait(mut self, wait: FirstConnectionWait) -> Self {
        self.first_wait = Some(wait);
        self
    }

    /// Records how the response body is delimited, so wire bytes include
    /// the framing and an end at a declared length is told apart from the
    /// client hanging up.
    #[must_use]
    pub fn with_framing(mut self, framing: BodyFraming) -> Self {
        self.framing = Some(framing);
        self
    }

    /// Counts a body item of `len` bytes handed to the connection, as
    /// payload and as the bytes it puts on the wire.
    pub(crate) fn record_body_bytes(&self, len: usize) {
        let len = len as u64;
        let before = self.bytes_sent.fetch_add(len, Ordering::Relaxed);
        let wire = self
            .framing
            .map_or(len, |framing| framing.wire_len(before, len));
        self.wire_bytes.fetch_add(wire, Ordering::Relaxed);
    }

    /// Bytes the body has put on the wire so far: the payload plus any chunk
    /// framing, and never more than a declared length. What the speaker
    /// acknowledges is counted against this, not against the payload.
    pub fn wire_bytes(&self) -> u64 {
        self.wire_bytes.load(Ordering::Relaxed)
    }

    /// Records that the stream feeding the body ended, so the body ran out
    /// on our side. Counts the bytes that end the framing, if any.
    pub(crate) fn mark_source_ended(&self) {
        if !self.source_ended.swap(true, Ordering::Relaxed) {
            if let Some(framing) = self.framing {
                self.wire_bytes
                    .fetch_add(framing.end_len(), Ordering::Relaxed);
            }
        }
    }

    /// Records that a test cap is ending the body after a set number of
    /// bytes, so the end is logged as `ended_by=server_cap` rather than as
    /// the stream ending. Call it before the body yields its last item.
    pub fn mark_server_cap(&self) {
        self.server_capped.store(true, Ordering::Relaxed);
    }

    /// Why the body ended, judged from what has been recorded so far. Only
    /// meaningful once the body has been dropped (see [`EndedBy::classify`]).
    pub fn ended_by(&self) -> EndedBy {
        self.classify_end(self.first_error.lock().is_some())
    }

    /// [`Self::ended_by`] for a known error state.
    fn classify_end(&self, errored: bool) -> EndedBy {
        EndedBy::classify(
            errored,
            self.server_capped.load(Ordering::Relaxed),
            self.source_ended.load(Ordering::Relaxed),
            self.framing,
            self.bytes_sent.load(Ordering::Relaxed),
        )
    }

    /// The latest verdict on the connection's link, or `None` before the
    /// first one.
    pub(crate) fn link_verdict(&self) -> Option<crate::events::LinkQuality> {
        use crate::events::LinkQuality;
        match self.link_verdict.load(Ordering::Relaxed) {
            1 => Some(LinkQuality::Good),
            2 => Some(LinkQuality::Degraded),
            3 => Some(LinkQuality::Poor),
            _ => None,
        }
    }

    /// Bytes handed to the connection that the speaker has not yet
    /// acknowledged, read now, where the platform reports them and while
    /// the response body is open.
    ///
    /// The body can close between the check and the read, but only a
    /// socket closed and its handle handed to another in those few
    /// microseconds could make the read wrong, and then only that one.
    pub(crate) fn unacked_bytes_now(&self) -> Option<u64> {
        if self.body_closed.load(Ordering::Acquire) {
            return None;
        }
        self.link_probe.as_ref()?.unacked_bytes(self.wire_bytes())
    }

    /// Records that the response body has been dropped (see
    /// [`Self::unacked_bytes_now`]).
    pub(crate) fn mark_body_closed(&self) {
        self.body_closed.store(true, Ordering::Release);
    }

    /// Whether the response body has been dropped.
    #[cfg(test)]
    pub(crate) fn body_closed(&self) -> bool {
        self.body_closed.load(Ordering::Acquire)
    }

    /// Attaches the TCP statistics probe for the client's connection, whose
    /// counters are logged, judged and read for acknowledged bytes.
    pub fn with_link_probe(mut self, probe: Option<crate::api::link::TcpLinkProbe>) -> Self {
        if probe.is_some() {
            *self.link_judge.lock() = Some(crate::api::link::LinkJudge::new());
        }
        self.link_probe = probe;
        self
    }

    /// Attaches the emitter the cadence reports audio reaching this machine
    /// late to, as a stream event for the stream's owner.
    pub fn with_events(mut self, emitter: Arc<dyn crate::events::EventEmitter>) -> Self {
        self.events = Some(emitter);
        self
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

    /// Reads the connection's TCP counters since the last read and warns, at
    /// most once every five seconds, when data had to be retransmitted.
    /// The bytes the speaker has acknowledged are counted against
    /// [`Self::wire_bytes`] as it stands, since chunk framing is acknowledged
    /// too.
    fn sample_link(&self) -> Option<crate::api::link::TcpLinkWindow> {
        let window = self.link_probe.as_ref()?.sample(self.wire_bytes())?;
        let verdict = self
            .link_judge
            .lock()
            .as_mut()
            .and_then(|judge| judge.record(Instant::now(), window));
        if let Some(report) = verdict {
            self.report_link(report);
        }
        if window.retransmitted > 0 || window.timeouts > 0 {
            let mut last = self.last_retransmit_warning.lock();
            let due = last.map_or(true, |at| at.elapsed() >= Duration::from_secs(5));
            if due {
                *last = Some(Instant::now());
                log::warn!(
                    "[Stream] TCP retransmissions on the connection to {} (stream {}): +{} \
                     retransmitted, +{} timeout(s), rtt {}ms. The audio left this machine on time; \
                     the network between here and the speaker did not carry it",
                    self.client_ip,
                    self.stream_id,
                    window.retransmitted,
                    window.timeouts,
                    window.rtt_ms
                );
            }
        }
        Some(window)
    }

    /// Logs a change in the connection's quality and keeps the verdict for
    /// the speaker monitor. Never sent to clients: link trouble alone is not
    /// a notice (see [`crate::api::link::LinkJudge`]).
    fn report_link(&self, report: crate::api::link::LinkReport) {
        use crate::events::LinkQuality;
        self.link_verdict
            .store(link_quality_code(report.quality), Ordering::Relaxed);
        let line = format!(
            "[Stream] Link to {} is {:?} (stream {}): median rtt {}ms, worst {}ms, {} troubled \
             sample(s) and {} timeout(s) in the last minute",
            self.client_ip,
            report.quality,
            self.stream_id,
            report.rtt_median_ms,
            report.rtt_max_ms,
            report.spikes,
            report.failures,
        );
        match report.quality {
            LinkQuality::Good => log::info!("{}", line),
            LinkQuality::Degraded | LinkQuality::Poor => log::warn!("{}", line),
        }
    }

    /// Records a frame being delivered to the client (lock-free).
    pub fn record_frame(&self) {
        self.frames_sent.fetch_add(1, Ordering::Relaxed);

        let elapsed = self.reference_time.elapsed();
        if let Some(wait) = self.first_wait {
            if elapsed >= FIRST_WAIT_SURVIVAL
                && !self.first_wait_survived.swap(true, Ordering::Relaxed)
            {
                log::info!(
                    "[Stream] First-connection wait survived: client={}, stream={}, the speaker \
                     kept its connection {}s after a {}ms wait (smoothing {}ms + head start {}ms)",
                    self.client_ip,
                    self.stream_id,
                    FIRST_WAIT_SURVIVAL.as_secs(),
                    wait.waited_ms,
                    wait.smoothing_ms,
                    wait.head_start_ms
                );
            }
        }

        let now_nanos = elapsed.as_nanos() as u64;
        let prev_nanos = self.last_delivery_nanos.swap(now_nanos, Ordering::Relaxed);

        if prev_nanos > 0 {
            let gap_ms = now_nanos.saturating_sub(prev_nanos) / 1_000_000;

            self.max_gap_ms.fetch_max(gap_ms, Ordering::Relaxed);
            self.interval_max_gap_ms
                .fetch_max(gap_ms, Ordering::Relaxed);

            if gap_ms > DELIVERY_GAP_THRESHOLD_MS {
                self.gaps_over_threshold.fetch_add(1, Ordering::Relaxed);
                // Only log significant gaps to avoid spam; summary captures total count
                if gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS {
                    log::warn!(
                        "[Stream] Delivery gap detected: stream={}, client={}, gap={}ms",
                        self.stream_id,
                        self.client_ip,
                        gap_ms
                    );
                }
            }
        }
    }

    /// Records the first error encountered during streaming.
    pub fn record_error(&self, err: &str) {
        let mut first = self.first_error.lock();
        if first.is_none() {
            *first = Some(err.to_string());
        }
    }

    /// Stores cadence stream statistics. Called once when the cadence stream ends.
    pub(crate) fn set_cadence_stats(&self, stats: CadenceStats) {
        let _ = self.cadence_stats.set(stats);
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
}

impl Drop for LoggingStreamGuard {
    fn drop(&mut self) {
        let frames = self.frames_sent.load(Ordering::Relaxed);
        let bytes_sent = self.bytes_sent.load(Ordering::Relaxed);
        let wire_bytes = self.wire_bytes.load(Ordering::Relaxed);
        let errored = self.first_error.get_mut().is_some();
        let ended_by = self.classify_end(errored);
        let first_error = self.first_error.get_mut();
        let max_gap_ms = self.max_gap_ms.load(Ordering::Relaxed);
        let gaps_over_threshold = self.gaps_over_threshold.load(Ordering::Relaxed);

        // Calculate time since last frame delivery
        let last_nanos = self.last_delivery_nanos.load(Ordering::Relaxed);
        let final_gap_ms = if last_nanos > 0 {
            let now_nanos = self.reference_time.elapsed().as_nanos() as u64;
            now_nanos.saturating_sub(last_nanos) / 1_000_000
        } else {
            0
        };
        let stalled_suffix = if final_gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS {
            " (stalled)"
        } else {
            ""
        };

        let cadence = self.cadence_stats.get();

        // Build silence stats string if any silence was injected
        let silence_info = cadence
            .filter(|s| s.silence_events > 0)
            .map(|s| {
                format!(
                    ", silence_events={}, silence_frames={}",
                    s.silence_events, s.silence_frames
                )
            })
            .unwrap_or_default();

        // Build dropped frames string if any frames were dropped
        let dropped_info = cadence
            .filter(|s| s.frames_dropped > 0)
            .map(|s| format!(", frames_dropped={}", s.frames_dropped))
            .unwrap_or_default();

        // Recovery events: playback held after an underrun until refilled
        let recovery_info = cadence
            .filter(|s| s.rebuffer_events > 0)
            .map(|s| format!(", rebuffers={}", s.rebuffer_events))
            .unwrap_or_default();

        if let Some(wait) = self.first_wait {
            if !self.first_wait_survived.load(Ordering::Relaxed) {
                log::warn!(
                    "[Stream] First-connection wait not survived: client={}, stream={}, the \
                     connection ended {}ms after a {}ms wait (smoothing {}ms + head start {}ms), \
                     having sent {} frames; unless the cast was stopped or regrouped, if this \
                     repeats the speaker may not accept a wait this long, so try a shorter \
                     speaker head start",
                    self.client_ip,
                    self.stream_id,
                    self.reference_time.elapsed().as_millis(),
                    wait.waited_ms,
                    wait.smoothing_ms,
                    wait.head_start_ms,
                    frames
                );
            }
        }

        let timeline = self.pipeline_timeline.lock();
        let timeline_json = if timeline.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&*timeline).unwrap_or_default()
        };
        drop(timeline);
        let timeline_info = if timeline_json.is_empty() {
            String::new()
        } else {
            format!(", pipeline_timeline={}", timeline_json)
        };
        // Retransmissions over the whole connection, where the platform
        // reports them: the one number that says the network dropped audio.
        let link_info = self
            .link_probe
            .as_ref()
            .map(|probe| format!(", tcp_retransmitted={}", probe.total_retransmitted()))
            .unwrap_or_default();

        if let Some(ref err) = *first_error {
            log::warn!(
                "[Stream] HTTP stream ended with error{}: stream={}, client={}, frames_sent={}, \
                 bytes_sent={}, wire_bytes={}, ended_by={}, max_gap={}ms, gaps_over_{}ms={}, \
                 final_gap={}ms{}{}{}{}{}, error={}",
                stalled_suffix,
                self.stream_id,
                self.client_ip,
                frames,
                bytes_sent,
                wire_bytes,
                ended_by,
                max_gap_ms,
                DELIVERY_GAP_THRESHOLD_MS,
                gaps_over_threshold,
                final_gap_ms,
                silence_info,
                dropped_info,
                recovery_info,
                link_info,
                timeline_info,
                err
            );
        } else {
            log::info!(
                "[Stream] HTTP stream ended normally{}: stream={}, client={}, frames_sent={}, \
                 bytes_sent={}, wire_bytes={}, ended_by={}, max_gap={}ms, gaps_over_{}ms={}, \
                 final_gap={}ms{}{}{}{}{}",
                stalled_suffix,
                self.stream_id,
                self.client_ip,
                frames,
                bytes_sent,
                wire_bytes,
                ended_by,
                max_gap_ms,
                DELIVERY_GAP_THRESHOLD_MS,
                gaps_over_threshold,
                final_gap_ms,
                silence_info,
                dropped_info,
                recovery_info,
                link_info,
                timeline_info
            );
        }
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
        }
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
/// Silence and overflow statistics are tracked locally and written to the
/// guard once at stream end via `set_cadence_stats()`.
///
/// Epoch tracking (optional): when `epoch_hook` is `Some`, the stream fires
/// it on the first real audio frame, which starts the epoch anchored to
/// [`CadenceConfig::epoch_candidate`] and registers a monitored connection
/// with the speaker monitor, then discards the hook.
/// The hook holds a `Weak` reference so the response body never keeps the
/// `StreamState` (and with it the broadcast sender) alive; if the upgrade
/// fails the stream has been removed and the hook is dropped unfired.
///
/// This ensures Sonos always receives continuous data with smooth transitions,
/// eliminating pops from abrupt audio/silence boundaries.
pub fn create_wav_stream_with_cadence(
    mut rx: broadcast::Receiver<Bytes>,
    guard: Arc<LoggingStreamGuard>,
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
                yield Ok(frame);
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
                                    guard.report_ingest_gaps(report);
                                }
                            }
                        }
                        let waited = rebuffer_started.map(|t| t.elapsed()).unwrap_or_default();
                        if rx_closed || queue.len() >= buffer_depth || waited >= rebuffer_timeout {
                            rebuffering = false;
                            rebuffer_events += 1;
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
                        yield Ok(silence_frame.clone());
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
                            yield Ok(crossfade.maybe_fade_in(frame));
                        } else {
                            yield Ok(frame);
                        }
                    } else if !rx_closed {
                        // No frame available, emit silence
                        if !in_silence {
                            log::info!("[Stream] Entering silence (cadence) - queue empty");
                            in_silence = true;
                            silence_start = Some(TokioInstant::now());
                            silence_events += 1;
                            silence_frames += 1;
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
                            yield Ok(crossfade.enter_silence(&silence_frame));
                        } else {
                            silence_frames += 1;
                            yield Ok(silence_frame.clone());
                        }
                    }
                    // If rx_closed and queue empty, don't yield - loop will break

                    catch_up_headroom = catch_up_headroom.saturating_sub(1);

                    // Pipeline snapshot every 50 ticks (500 ms at the default 10 ms frame)
                    tick_count += 1;
                    if tick_count % 50 == 0 {
                        let elapsed_ms = guard.reference_time.elapsed().as_millis() as u64;

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

                        // Delivery window: deltas from guard atomics
                        let cur_frames = guard.frames_sent.load(Ordering::Relaxed);
                        let cur_bytes = guard.bytes_sent.load(Ordering::Relaxed);
                        let cur_gaps = guard.gaps_over_threshold.load(Ordering::Relaxed);
                        let interval_max = guard.interval_max_gap_ms.swap(0, Ordering::Relaxed);

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

                        guard.push_pipeline_snapshot(PipelineSnapshot {
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
                            link: guard.sample_link(),
                            speaker: guard.speaker.snapshot(),
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

        guard.set_cadence_stats(CadenceStats {
            silence_events,
            silence_frames,
            frames_dropped,
            rebuffer_events,
        });
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
    fn test_guard() -> Arc<LoggingStreamGuard> {
        Arc::new(LoggingStreamGuard::new(
            "test-stream".to_string(),
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
        let stats = guard_for_check
            .cadence_stats
            .get()
            .expect("cadence stats should be set after stream ends");
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
        let stats = guard_for_check
            .cadence_stats
            .get()
            .expect("cadence stats should be set after stream ends");
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
        let stats = guard_for_check.cadence_stats.get().unwrap();
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
            LoggingStreamGuard::new("test-stream".to_string(), IpAddr::V4(Ipv4Addr::LOCALHOST))
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
    fn connect_burst_setting_is_parsed_and_bounded() {
        assert_eq!(parse_pcm_connect_burst_ms("0"), Ok(0));
        assert_eq!(parse_pcm_connect_burst_ms(" 750 "), Ok(750));
        assert_eq!(parse_pcm_connect_burst_ms("2000"), Ok(2000));
        assert!(parse_pcm_connect_burst_ms("2001").is_err());
        assert!(parse_pcm_connect_burst_ms("-1").is_err());
        assert!(parse_pcm_connect_burst_ms("half a second").is_err());

        assert_eq!(resolve_pcm_connect_burst_ms(500, None), 500);
        assert_eq!(
            resolve_pcm_connect_burst_ms(500, Some(0)),
            0,
            "the env wins"
        );
        assert_eq!(resolve_pcm_connect_burst_ms(9000, None), 2000, "clamped");
    }

    #[test]
    fn connect_burst_env_value_is_read_as_an_override() {
        assert_eq!(pcm_connect_burst_override_from("1500"), Ok(Some(1500)));
        assert_eq!(
            pcm_connect_burst_override_from(" 0 "),
            Ok(Some(0)),
            "0 turns it off"
        );
        assert_eq!(pcm_connect_burst_override_from("2000"), Ok(Some(2000)));
        assert_eq!(
            pcm_connect_burst_override_from("  "),
            Ok(None),
            "blank is unset"
        );
        assert!(pcm_connect_burst_override_from("2001").is_err());
        assert!(pcm_connect_burst_override_from("lots").is_err());
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

    fn test_wait() -> FirstConnectionWait {
        FirstConnectionWait {
            waited_ms: 2300,
            smoothing_ms: 300,
            head_start_ms: 2000,
        }
    }

    /// Runs a first-connection wait the way the stream handler does, with a
    /// watch armed over the sleep, and reports how far into the wait the
    /// watch saw the speaker hang up, if it did.
    fn spawn_watched_wait() -> (
        tokio::task::JoinHandle<()>,
        Arc<parking_lot::Mutex<Option<Duration>>>,
    ) {
        let hung_up = Arc::new(parking_lot::Mutex::new(None));
        let cell = Arc::clone(&hung_up);
        let handle = tokio::spawn(async move {
            let mut watch =
                FirstWaitWatch::arm(test_wait(), IpAddr::V4(Ipv4Addr::LOCALHOST), "test-stream");
            watch.hung_up_after = Some(cell);
            time::sleep(Duration::from_millis(test_wait().waited_ms)).await;
            watch.completed();
        });
        (handle, hung_up)
    }

    /// A speaker that hangs up before the response makes the server drop the
    /// handler mid-wait; the watch still logs how far into the wait that was.
    #[tokio::test(start_paused = true)]
    async fn a_speaker_hanging_up_mid_wait_is_logged_as_not_surviving_it() {
        let (handle, hung_up) = spawn_watched_wait();
        time::sleep(Duration::from_millis(700)).await;
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());

        let after = hung_up.lock().expect("a dropped wait is logged");
        assert_eq!(after, Duration::from_millis(700));
    }

    #[tokio::test(start_paused = true)]
    async fn a_wait_that_runs_its_course_is_not_logged_as_a_hang_up() {
        let (handle, hung_up) = spawn_watched_wait();
        handle.await.expect("wait completes");
        assert_eq!(*hung_up.lock(), None);
    }

    /// The guard marks the wait survived only once the connection has been
    /// fed for [`FIRST_WAIT_SURVIVAL`]; ending sooner leaves it unmarked,
    /// which is what makes its drop warn.
    #[test]
    fn a_first_wait_counts_as_survived_only_after_the_survival_time() {
        let mut guard =
            LoggingStreamGuard::new("test-stream".to_string(), IpAddr::V4(Ipv4Addr::LOCALHOST))
                .with_first_wait(test_wait());
        guard.record_frame();
        assert!(!guard.first_wait_survived.load(Ordering::Relaxed));

        guard.reference_time = Instant::now() - FIRST_WAIT_SURVIVAL;
        guard.record_frame();
        assert!(guard.first_wait_survived.load(Ordering::Relaxed));
    }

    #[test]
    fn a_connection_without_a_first_wait_is_never_marked_survived() {
        let mut guard =
            LoggingStreamGuard::new("test-stream".to_string(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        guard.reference_time = Instant::now() - FIRST_WAIT_SURVIVAL;
        guard.record_frame();
        assert!(!guard.first_wait_survived.load(Ordering::Relaxed));
    }
}
