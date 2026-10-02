//! Per-connection delivery tracking, for every codec.
//!
//! The guard that records one HTTP connection (its lifecycle log lines, its
//! delivery timing, its TCP link and its summary), the watch over a first
//! connection's wait, the hook that starts a playback epoch and the pipeline
//! snapshot types the guard stores. The PCM cadence that fills those
//! snapshots is in [`super::cadence`].

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::cadence::{CadenceStats, ChainStats};
use super::framing::{BodyFraming, DeclaredEnd, EndedBy};
use super::tap::{ConnectionTap, MonitorRegistrar};
use super::StreamState;

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
    /// Audio the speaker takes to precede the first frame served (see
    /// [`Self::with_preroll`]).
    preroll: Duration,
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
            preroll: Duration::ZERO,
        }
    }

    /// Anchors the epoch `preroll` before the first frame served: a speaker
    /// that fetched part of a PCM segment with `Range` counts its RelTime
    /// from the segment's start, which lies that much before what it was
    /// sent (see [`crate::stream::playout::SegmentStart::preroll`]).
    #[must_use]
    pub fn with_preroll(mut self, preroll: Duration) -> Self {
        self.preroll = preroll;
        self
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
        let preroll = self.preroll;
        let back = |t: Instant| t.checked_sub(preroll).unwrap_or(t);
        let epoch_candidate = if preroll.is_zero() {
            epoch_candidate
        } else {
            Some(back(epoch_candidate.unwrap_or(self.connected_at)))
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

/// A connection that waited before its response and then ended this soon
/// after its first bytes (the WAV header and connect burst) is not blamed on
/// the wait: the speaker had already sat through the wait and taken the
/// response, so ending at once looks more like it rejected what it received.
/// A Playbar sent a WAV header declaring 0 bytes of audio hangs up at once.
pub const FIRST_WAIT_QUICK_END: Duration = Duration::from_millis(100);

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

/// The warning for a connection that waited before its response and ended
/// before [`FIRST_WAIT_SURVIVAL`]: `ended_after` the response started, and
/// `after_first_bytes` its first bytes went out (`None` if none did), having
/// sent `frames` body items.
///
/// Only an end that leaves the speaker time to have played some of the
/// stream points at the wait. One within [`FIRST_WAIT_QUICK_END`] of the
/// first bytes (or of the response starting, when nothing was sent) says the
/// speaker ended the connection right after the stream started, which more
/// likely means it rejected the stream than the wait.
fn first_wait_not_survived_line(
    client_ip: IpAddr,
    stream_id: &str,
    wait: FirstConnectionWait,
    ended_after: Duration,
    after_first_bytes: Option<Duration>,
    frames: u64,
) -> String {
    let quick = after_first_bytes.unwrap_or(ended_after) <= FIRST_WAIT_QUICK_END;
    if quick {
        let when = match after_first_bytes {
            Some(d) => format!("{}ms after its first bytes", d.as_millis()),
            None => format!(
                "{}ms after the response started, before any bytes were sent",
                ended_after.as_millis()
            ),
        };
        format!(
            "[Stream] Speaker ended the connection right after the stream started: \
             client={client_ip}, stream={stream_id}, the connection ended {when}, having sent \
             {frames} frames, after a {}ms wait (smoothing {}ms + head start {}ms); unless the \
             cast was stopped or regrouped, this can mean the speaker rejected the stream (for \
             example an invalid WAV header) rather than the wait",
            wait.waited_ms, wait.smoothing_ms, wait.head_start_ms
        )
    } else {
        format!(
            "[Stream] First-connection wait not survived: client={client_ip}, \
             stream={stream_id}, the connection ended {}ms after a {}ms wait (smoothing {}ms + \
             head start {}ms), having sent {frames} frames; unless the cast was stopped or \
             regrouped, if this repeats the speaker may not accept a wait this long, so try a \
             shorter speaker head start",
            ended_after.as_millis(),
            wait.waited_ms,
            wait.smoothing_ms,
            wait.head_start_ms
        )
    }
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

/// Maximum pipeline snapshots to keep (300 entries × 500 ms = 2.5 minutes at
/// the default 10 ms frame).
pub(super) const MAX_PIPELINE_SNAPSHOTS: usize = 300;

/// Receive jitter window for a pipeline snapshot.
#[derive(Serialize)]
pub(super) struct ReceiveWindow {
    pub(super) frames_received: u64,
    pub(super) min_gap_ms: u64,
    pub(super) max_gap_ms: u64,
    pub(super) gaps_over_threshold: u64,
}

/// Cadence buffer window for a pipeline snapshot.
#[derive(Serialize)]
pub(super) struct CadenceWindow {
    pub(super) queue_len: usize,
    pub(super) silence_events: u64,
    pub(super) silence_frames: u64,
    pub(super) drops: u64,
}

/// HTTP delivery window for a pipeline snapshot.
#[derive(Serialize)]
pub(super) struct DeliveryWindow {
    pub(super) frames_sent: u64,
    pub(super) bytes_per_second: u64,
    pub(super) max_gap_ms: u64,
    pub(super) gaps_over_threshold: u64,
}

/// Timestamped pipeline health snapshot, captured every 50 cadence ticks
/// (500 ms at the default 10 ms frame).
#[derive(Serialize)]
pub(super) struct PipelineSnapshot {
    pub(super) elapsed_ms: u64,
    pub(super) receive: ReceiveWindow,
    pub(super) cadence: CadenceWindow,
    pub(super) delivery: DeliveryWindow,
    /// TCP statistics for the speaker's connection since the last snapshot,
    /// where the platform reports them. This is the only window that can see
    /// a Wi-Fi stall: the kernel's send buffer hides it from `delivery`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) link: Option<super::link::TcpLinkWindow>,
    /// What the speaker monitor last concluded about the speaker at the
    /// other end: its reserve and its clock against ours.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) speaker: Option<super::tap::SpeakerSnapshot>,
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

/// One HTTP connection's record: logs its lifecycle, tracks its delivery
/// timing and TCP link, and writes its summary line when it is dropped.
///
/// Delivery gap tracking uses lock-free atomics on the hot path.
///
/// A PCM cast's audio outlives any one connection: its cadence, the speaker
/// monitor's figures and the pipeline timeline belong to the playout, in its
/// [`ChainStats`]. A guard bound to them (see [`ChainStats::attach_connection`])
/// reports in its summary only what happened while it was the connection
/// being served.
pub struct LoggingStreamGuard {
    stream_id: String,
    pub(super) client_ip: IpAddr,
    /// Monotonic reference for computing delivery timestamps.
    reference_time: Instant,
    pub(super) frames_sent: AtomicU64,
    /// Elapsed nanos since `reference_time` of the last delivered frame (0 = none).
    last_delivery_nanos: AtomicU64,
    /// Elapsed nanos since `reference_time` of the first delivered frame
    /// (0 = none), which for PCM is the WAV header.
    first_delivery_nanos: AtomicU64,
    max_gap_ms: AtomicU64,
    pub(super) gaps_over_threshold: AtomicU64,
    first_error: parking_lot::Mutex<Option<String>>,
    /// The playout this connection served, from when it started serving it:
    /// where its summary finds its share of the cadence counters and of the
    /// pipeline timeline.
    binding: OnceLock<ConnBinding>,
    /// Total bytes delivered to HTTP client (for throughput calculation).
    pub(crate) bytes_sent: AtomicU64,
    /// Bytes the body has put on the wire (see [`BodyFraming::wire_len`]).
    wire_bytes: AtomicU64,
    /// How the response body is delimited, where the handler recorded it.
    /// `None` counts wire bytes as payload and declares no length.
    framing: Option<BodyFraming>,
    /// Where the speaker takes the item to end, where the handler recorded
    /// it (PCM only): near it the speaker going quiet is the end, not a
    /// stall (see [`Self::near_declared_end`]).
    declared_end: Option<DeclaredEnd>,
    /// Whether the body ran out on our side: the stream feeding it ended.
    source_ended: AtomicBool,
    /// Whether a test cap ended the body (see [`Self::mark_server_cap`]).
    server_capped: AtomicBool,
    /// Whether a PCM segment body ended at its declared data size (see
    /// [`Self::mark_segment_end`]).
    segment_ended: AtomicBool,
    /// Per-interval max delivery gap in ms (swapped to 0 on each snapshot).
    pub(super) interval_max_gap_ms: AtomicU64,
    /// TCP statistics probe for the client's connection, when available.
    link_probe: Option<super::link::TcpLinkProbe>,
    /// When retransmissions were last reported, to rate-limit the warning.
    last_retransmit_warning: parking_lot::Mutex<Option<Instant>>,
    /// Judges the connection from its samples and logs quality changes.
    link_judge: parking_lot::Mutex<Option<super::link::LinkJudge>>,
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
    pub(super) body_closed: AtomicBool,
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
            first_delivery_nanos: AtomicU64::new(0),
            max_gap_ms: AtomicU64::new(0),
            gaps_over_threshold: AtomicU64::new(0),
            first_error: parking_lot::Mutex::new(None),
            binding: OnceLock::new(),
            bytes_sent: AtomicU64::new(0),
            wire_bytes: AtomicU64::new(0),
            framing: None,
            declared_end: None,
            source_ended: AtomicBool::new(false),
            server_capped: AtomicBool::new(false),
            segment_ended: AtomicBool::new(false),
            interval_max_gap_ms: AtomicU64::new(0),
            link_probe: None,
            last_retransmit_warning: parking_lot::Mutex::new(None),
            link_judge: parking_lot::Mutex::new(None),
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

    /// Records where the speaker takes the item to end (see
    /// [`DeclaredEnd`]), so that near it acknowledgements are no
    /// longer read as a stall and an end there is logged as the end of the
    /// item.
    #[must_use]
    pub fn with_declared_end(mut self, end: Option<DeclaredEnd>) -> Self {
        self.declared_end = end;
        self
    }

    /// Whether the body is near or at the end the speaker was told of (see
    /// [`DeclaredEnd::is_near`]). The speaker may stop acknowledging audio
    /// there because the item is over, so no stall is measured.
    pub(crate) fn near_declared_end(&self) -> bool {
        self.declared_end
            .is_some_and(|end| end.is_near(self.bytes_sent.load(Ordering::Relaxed)))
    }

    /// Whether the body has handed over everything up to the end the speaker
    /// was told of (see [`DeclaredEnd::is_reached`]).
    pub(crate) fn reached_declared_end(&self) -> bool {
        self.declared_end
            .is_some_and(|end| end.is_reached(self.bytes_sent.load(Ordering::Relaxed)))
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

    /// Records that a PCM segment body handed over the whole data size its
    /// WAV header declared and is ending there, so the end is logged as
    /// `ended_by=length`: the item's own end, not the stream running out.
    /// Call it before the body yields its end.
    pub fn mark_segment_end(&self) {
        self.segment_ended.store(true, Ordering::Relaxed);
    }

    /// Why the body ended, judged from what has been recorded so far. Only
    /// meaningful once the body has been dropped (see [`EndedBy::classify`]).
    pub fn ended_by(&self) -> EndedBy {
        self.classify_end(self.first_error.lock().is_some())
    }

    /// [`Self::ended_by`] for a known error state.
    fn classify_end(&self, errored: bool) -> EndedBy {
        if !errored && self.segment_ended.load(Ordering::Relaxed) {
            return EndedBy::Length;
        }
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
    ///
    /// `None` near the declared end too: the speaker may stop reading there
    /// because the item is over, and any lag that builds up is no stall.
    pub(crate) fn unacked_bytes_now(&self) -> Option<u64> {
        if self.body_closed.load(Ordering::Acquire) || self.near_declared_end() {
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
    pub fn with_link_probe(mut self, probe: Option<super::link::TcpLinkProbe>) -> Self {
        if probe.is_some() {
            *self.link_judge.lock() = Some(super::link::LinkJudge::new());
        }
        self.link_probe = probe;
        self
    }

    /// Binds this connection to the playout it serves (see
    /// [`ChainStats::attach_connection`]). Only the first call has any
    /// effect: a connection serves one playout.
    pub(super) fn bind(&self, binding: ConnBinding) {
        let _ = self.binding.set(binding);
    }

    /// Reads the connection's TCP counters since the last read and warns, at
    /// most once every five seconds, when data had to be retransmitted.
    /// The bytes the speaker has acknowledged are counted against
    /// [`Self::wire_bytes`] as it stands, since chunk framing is acknowledged
    /// too.
    ///
    /// Near the declared end the window is logged but not judged: a speaker
    /// that has read the whole item may stop acknowledging, which says
    /// nothing about the link.
    pub(super) fn sample_link(&self) -> Option<super::link::TcpLinkWindow> {
        let window = self.link_probe.as_ref()?.sample(self.wire_bytes())?;
        let verdict = if self.near_declared_end() {
            None
        } else {
            self.link_judge
                .lock()
                .as_mut()
                .and_then(|judge| judge.record(Instant::now(), window))
        };
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
    /// a notice (see [`super::link::LinkJudge`]).
    fn report_link(&self, report: super::link::LinkReport) {
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

        if prev_nanos == 0 {
            self.first_delivery_nanos
                .store(now_nanos.max(1), Ordering::Relaxed);
        } else {
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
}

/// What follows "HTTP stream ended normally" (or "with error") on a
/// connection's end line: that it ended at the end the speaker was told of,
/// when the speaker hung up there, hyper stopped at the declared length or a
/// test cap (which sets the declared end) ended the body, else whether
/// delivery had stalled before the end.
///
/// A speaker hangs up some seconds after passing its declared length (a
/// Playbar about 9 s past the 4 GiB WAV length), and its last reads can be
/// slow by then: an end there is the end of the item, not a stall.
pub(crate) fn end_suffix(
    ended_by: EndedBy,
    at_declared_end: bool,
    final_gap_ms: u64,
) -> &'static str {
    if at_declared_end
        && matches!(
            ended_by,
            EndedBy::Client | EndedBy::Length | EndedBy::ServerCap
        )
    {
        " at its declared end"
    } else if final_gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS {
        " (stalled)"
    } else {
        ""
    }
}

impl Drop for LoggingStreamGuard {
    fn drop(&mut self) {
        let frames = self.frames_sent.load(Ordering::Relaxed);
        let bytes_sent = self.bytes_sent.load(Ordering::Relaxed);
        let wire_bytes = self.wire_bytes.load(Ordering::Relaxed);
        let errored = self.first_error.get_mut().is_some();
        let ended_by = self.classify_end(errored);
        let at_declared_end = self.reached_declared_end();
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
        let end_note = end_suffix(ended_by, at_declared_end, final_gap_ms);
        let declared_end_info = self
            .declared_end
            .map(|end| format!(", declared_end={}", end.bytes()))
            .unwrap_or_default();

        let binding = self.binding.get();
        let cadence_delta = binding.map(|b| b.stats.cadence_totals().since(b.cadence_base));
        let cadence = cadence_delta.as_ref();

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
                let ended_after = self.reference_time.elapsed();
                let first_nanos = self.first_delivery_nanos.load(Ordering::Relaxed);
                let after_first_bytes = (first_nanos > 0)
                    .then(|| ended_after.saturating_sub(Duration::from_nanos(first_nanos)));
                log::warn!(
                    "{}",
                    first_wait_not_survived_line(
                        self.client_ip,
                        &self.stream_id,
                        wait,
                        ended_after,
                        after_first_bytes,
                        frames
                    )
                );
            }
        }

        let timeline_json = binding
            .map(|b| b.stats.timeline_json_since(b.since_ms))
            .unwrap_or_default();
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
                 bytes_sent={}, wire_bytes={}, ended_by={}{}, max_gap={}ms, gaps_over_{}ms={}, \
                 final_gap={}ms{}{}{}{}{}, error={}",
                end_note,
                self.stream_id,
                self.client_ip,
                frames,
                bytes_sent,
                wire_bytes,
                ended_by,
                declared_end_info,
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
                 bytes_sent={}, wire_bytes={}, ended_by={}{}, max_gap={}ms, gaps_over_{}ms={}, \
                 final_gap={}ms{}{}{}{}{}",
                end_note,
                self.stream_id,
                self.client_ip,
                frames,
                bytes_sent,
                wire_bytes,
                ended_by,
                declared_end_info,
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

/// Where a connection's guard finds the playout it served (see
/// [`ChainStats::attach_connection`]).
pub(super) struct ConnBinding {
    /// The playout's statistics.
    pub(super) stats: Arc<ChainStats>,
    /// The playout's clock, in ms, when the connection started serving it:
    /// its summary carries the pipeline snapshots taken since.
    pub(super) since_ms: u64,
    /// The cadence counters when the connection started serving it.
    pub(super) cadence_base: CadenceStats,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use tokio::time::{self, Duration};

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

    /// A connection that ends within [`FIRST_WAIT_QUICK_END`] of its first
    /// bytes is reported as the speaker ending it right after the stream
    /// started, which may be a rejected stream, not as the wait failing.
    #[test]
    fn a_connection_ended_right_after_its_first_bytes_does_not_blame_the_wait() {
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));
        let line = first_wait_not_survived_line(
            ip,
            "s1",
            test_wait(),
            Duration::from_millis(30),
            Some(Duration::from_millis(25)),
            26,
        );
        assert_eq!(
            line,
            "[Stream] Speaker ended the connection right after the stream started: \
             client=192.168.1.50, stream=s1, the connection ended 25ms after its first bytes, \
             having sent 26 frames, after a 2300ms wait (smoothing 300ms + head start 2000ms); \
             unless the cast was stopped or regrouped, this can mean the speaker rejected the \
             stream (for example an invalid WAV header) rather than the wait"
        );
        assert!(!line.contains("shorter speaker head start"));

        // Nothing sent at all: timed from the response starting.
        let line =
            first_wait_not_survived_line(ip, "s1", test_wait(), Duration::from_millis(40), None, 0);
        assert!(line.starts_with("[Stream] Speaker ended the connection right after"));
        assert!(line.contains("40ms after the response started, before any bytes were sent"));
    }

    /// An end that leaves the speaker time to have played some of the stream
    /// keeps the wait-specific warning.
    #[test]
    fn a_connection_ended_later_blames_the_wait() {
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));
        let line = first_wait_not_survived_line(
            ip,
            "s1",
            test_wait(),
            Duration::from_millis(1800),
            Some(Duration::from_millis(1795)),
            110,
        );
        assert_eq!(
            line,
            "[Stream] First-connection wait not survived: client=192.168.1.50, stream=s1, the \
             connection ended 1800ms after a 2300ms wait (smoothing 300ms + head start 2000ms), \
             having sent 110 frames; unless the cast was stopped or regrouped, if this repeats \
             the speaker may not accept a wait this long, so try a shorter speaker head start"
        );

        let just_over = first_wait_not_survived_line(
            ip,
            "s1",
            test_wait(),
            FIRST_WAIT_QUICK_END + Duration::from_millis(6),
            Some(FIRST_WAIT_QUICK_END + Duration::from_millis(1)),
            8,
        );
        assert!(just_over.starts_with("[Stream] First-connection wait not survived"));
        let no_bytes = first_wait_not_survived_line(
            ip,
            "s1",
            test_wait(),
            Duration::from_millis(900),
            None,
            0,
        );
        assert!(no_bytes.starts_with("[Stream] First-connection wait not survived"));
    }

    /// The guard times an end from its first delivered item, the WAV header,
    /// not from when it was created.
    #[test]
    fn the_guard_records_when_its_first_bytes_went_out() {
        let mut guard =
            LoggingStreamGuard::new("test-stream".to_string(), IpAddr::V4(Ipv4Addr::LOCALHOST))
                .with_first_wait(test_wait());
        assert_eq!(guard.first_delivery_nanos.load(Ordering::Relaxed), 0);
        guard.reference_time = Instant::now() - Duration::from_millis(500);
        guard.record_frame();
        let first = guard.first_delivery_nanos.load(Ordering::Relaxed);
        assert!(first >= 500_000_000, "{first}");
        guard.record_frame();
        assert_eq!(
            guard.first_delivery_nanos.load(Ordering::Relaxed),
            first,
            "later frames leave it alone"
        );
    }

    #[test]
    fn a_connection_without_a_first_wait_is_never_marked_survived() {
        let mut guard =
            LoggingStreamGuard::new("test-stream".to_string(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        guard.reference_time = Instant::now() - FIRST_WAIT_SURVIVAL;
        guard.record_frame();
        assert!(!guard.first_wait_survived.load(Ordering::Relaxed));
    }

    /// The 6h12m field end: a Playbar read its 44 + 4294967295 bytes, went on
    /// reading and acknowledging about 9.3 s (1.79 MB) more, and hung up with
    /// the last delivery 585 ms old. That was logged as a stall; it was the
    /// end of the item.
    #[test]
    fn a_speaker_hanging_up_at_its_declared_end_is_not_a_stall() {
        let end = DeclaredEnd::new(44 + u64::from(u32::MAX), 192_000);
        let guard =
            LoggingStreamGuard::new("test-stream".to_string(), IpAddr::V4(Ipv4Addr::LOCALHOST))
                .with_framing(BodyFraming::Chunked)
                .with_declared_end(Some(end));
        assert!(!guard.near_declared_end() && !guard.reached_declared_end());
        guard.record_body_bytes(4_294_967_339 - 384_000 - 1);
        assert!(!guard.near_declared_end(), "more than 2 s short");
        guard.record_body_bytes(1);
        assert!(guard.near_declared_end(), "2 s short");
        assert_eq!(
            guard.unacked_bytes_now(),
            None,
            "acknowledgements are not sampled near the end"
        );
        guard.record_body_bytes(384_000 + 1_793_025);
        assert_eq!(guard.bytes_sent.load(Ordering::Relaxed), 4_296_760_364);
        assert!(guard.reached_declared_end());
        assert_eq!(guard.ended_by(), EndedBy::Client);
        assert_eq!(
            end_suffix(guard.ended_by(), guard.reached_declared_end(), 585),
            " at its declared end"
        );
    }

    #[test]
    fn an_end_short_of_the_declared_end_can_still_be_a_stall() {
        assert_eq!(end_suffix(EndedBy::Client, false, 585), " (stalled)");
        assert_eq!(end_suffix(EndedBy::Client, false, 20), "");
        assert_eq!(
            end_suffix(EndedBy::Length, true, 585),
            " at its declared end",
            "hyper stopping at a declared length is the same end"
        );
        assert_eq!(
            end_suffix(EndedBy::ServerCap, true, 585),
            " at its declared end",
            "a test cap sets the declared end, so reaching it is the end too"
        );
        assert_eq!(end_suffix(EndedBy::ServerCap, false, 585), " (stalled)");
        assert_eq!(
            end_suffix(EndedBy::ServerShutdown, true, 585),
            " (stalled)",
            "the stream ending on our side is not the item ending"
        );
        let guard =
            LoggingStreamGuard::new("test-stream".to_string(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        guard.record_body_bytes(10_000_000_000);
        assert!(
            !guard.near_declared_end() && !guard.reached_declared_end(),
            "a connection with no declared end never reaches one"
        );
    }
}
