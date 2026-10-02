//! Per-connection state shared between the stream data plane and the speaker
//! monitor.
//!
//! A speaker is monitored because it fetches a stream, not because something
//! asked for it to be: whoever actually pulls `/stream/{id}/live` is the device
//! whose playback we can measure. Casts started through the WebSocket, through
//! `POST /api/playback/start`, by promoting a group coordinator, or by another
//! client are therefore all covered, and speakers that never fetch (grouped
//! slaves, home-theatre satellites) are never polled.
//!
//! The handler for each new playback-tracking playout creates a
//! [`ConnectionTap`]; the playout owns it (for PCM the playout outlives each
//! segment connection, see [`crate::stream::playout`]; for a compressed codec
//! the response body is the playout) and the monitor holds only a [`Weak`],
//! so a playout that ends takes its monitoring with it. The tap is handed to
//! the monitor through a [`MonitorRegistrar`] when the playout serves its
//! first real frame, which is also when its playback epoch starts.

use std::net::IpAddr;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc;

use super::cadence::{ChainStats, LoggingStreamGuard, PipelineSample};
use super::manager::PlaybackEpoch;
use super::playout::MappedPosition;
use super::rate_adapter::RateControl;
use super::{AudioCodec, AudioFormat};
use crate::events::LinkQuality;
use crate::services::speaker_monitor::control::DriftMode;

/// Length of the WAV header every PCM connection starts with.
pub const WAV_HEADER_BYTES: u32 = 44;

/// Bytes a connection of `codec` sends before its first audio byte: the WAV
/// header for PCM, nothing for a compressed codec.
pub fn pcm_header(codec: AudioCodec) -> u32 {
    match codec {
        AudioCodec::Pcm => WAV_HEADER_BYTES,
        AudioCodec::Aac | AudioCodec::Mp3 | AudioCodec::Flac => 0,
    }
}

/// How many registrations may wait for the monitor before new ones are
/// dropped. A registration is one per connection, and the monitor drains them
/// every loop iteration, so this is only ever reached if the monitor has died.
pub const MONITOR_REGISTRATION_CAPACITY: usize = 64;

/// State shared between one speaker's playout and the speaker monitor.
///
/// Created in `api/stream.rs` for readers that track playback (a speaker the
/// stream is for, or this machine), once per playout: a segmented PCM cast's
/// playout keeps it across its segment connections, and any other
/// connection is its own playout. That owner (the playout, or the response
/// body) holds the only strong reference; the monitor and
/// [`crate::stream::StreamTiming`] hold [`Weak`] ones.
pub struct ConnectionTap {
    /// The stream this connection serves.
    pub stream_id: String,
    /// The peer's address, canonicalised so an IPv4-mapped IPv6 peer matches
    /// the plain IPv4 address the Sonos topology reports.
    pub speaker_ip: IpAddr,
    /// When the connection was accepted, after any prefill delay.
    pub connected_at: Instant,
    /// Bytes of audio per second of playback: 192 000 for 48 kHz 16-bit
    /// stereo PCM, `0` for a compressed codec, whose byte count says nothing
    /// exact about playback time.
    pub byte_rate: u32,
    /// Bytes the connection sends before its first audio byte (the WAV
    /// header for PCM, nothing for a compressed codec).
    pub header_bytes: u32,
    /// Whether speaker monitoring was switched on when the connection was
    /// made. Read once per connection, so a change of the setting applies to
    /// the next connection and never flips a session mid-way.
    pub monitor: bool,
    /// Sample frames per second of the connection's audio.
    sample_rate: u32,
    /// The clock drift correction mode the connection was made under, read
    /// once per connection like `monitor` (see
    /// [`crate::services::speaker_monitor::control::drift_compensation_mode`]).
    drift_mode: DriftMode,
    /// Where the monitor leaves the connection's rate command, when drift
    /// correction is on for a PCM connection whose format can be resampled.
    rate_control: Option<Arc<RateControl>>,
    /// The playout's statistics: its output position is the delivered side
    /// of the speaker's reserve, and the connection being served is found
    /// through it.
    stats: Arc<ChainStats>,
    /// The one connection a playout that is no more than that connection
    /// is carried on, held for the tap's life (see [`Self::with_connection`]).
    connection: Option<Arc<LoggingStreamGuard>>,
    /// The playback epoch this connection started, set once on its first
    /// real frame, before the tap is registered with the monitor.
    epoch: OnceLock<PlaybackEpoch>,
    /// The speaker head start this connection was sent, set once when its
    /// cadence body is built (PCM only), before the tap is registered.
    head_start: OnceLock<HeadStart>,
}

/// The speaker head start one PCM connection got: the connect burst sent
/// ahead of real-time pacing, and what was configured.
///
/// The two differ when the stream's ring held less than the configured
/// burst on top of the jitter buffer (a resume soon after the stream began
/// or after a source pause); the speaker's reserve starts from what was
/// sent, so that is what its low floor is sized from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HeadStart {
    /// Milliseconds of audio actually sent as the connect burst.
    pub sent_ms: u32,
    /// Milliseconds the connect burst was configured to, after any
    /// environment override and clamping.
    pub configured_ms: u32,
}

impl HeadStart {
    /// A head start of `sent_ms` out of `configured_ms`, both in ms.
    pub fn new(sent_ms: u64, configured_ms: u64) -> Self {
        let ms = |v: u64| v.min(u64::from(u32::MAX)) as u32;
        Self {
            sent_ms: ms(sent_ms),
            configured_ms: ms(configured_ms),
        }
    }

    /// Whether the whole configured head start was sent.
    pub fn is_full(&self) -> bool {
        self.sent_ms >= self.configured_ms
    }
}

impl ConnectionTap {
    /// Creates the tap for one connection.
    ///
    /// `speaker_ip` is canonicalised here. `monitor` is whether speaker
    /// monitoring is on for this connection (see
    /// [`crate::Config::speaker_monitor`]).
    pub fn new(
        stream_id: impl Into<String>,
        speaker_ip: IpAddr,
        connected_at: Instant,
        codec: AudioCodec,
        audio_format: &AudioFormat,
        stats: Arc<ChainStats>,
        monitor: bool,
    ) -> Self {
        let (byte_rate, header_bytes) = match codec {
            AudioCodec::Pcm => (
                audio_format.frame_bytes(1000).min(u32::MAX as usize) as u32,
                pcm_header(codec),
            ),
            AudioCodec::Aac | AudioCodec::Mp3 | AudioCodec::Flac => (0, pcm_header(codec)),
        };
        Self {
            stream_id: stream_id.into(),
            speaker_ip: speaker_ip.to_canonical(),
            connected_at,
            byte_rate,
            header_bytes,
            monitor,
            sample_rate: audio_format.sample_rate,
            drift_mode: DriftMode::Off,
            rate_control: None,
            stats,
            connection: None,
            epoch: OnceLock::new(),
            head_start: OnceLock::new(),
        }
    }

    /// The same tap made under drift correction `mode`, with the
    /// `rate_control` its cadence resamples by (only when `mode` is on and
    /// the connection can be corrected).
    #[must_use]
    pub fn with_drift(mut self, mode: DriftMode, rate_control: Option<Arc<RateControl>>) -> Self {
        self.drift_mode = mode;
        self.rate_control = rate_control;
        self
    }

    /// The same tap holding `guard`, the one connection its playout is
    /// carried on, for as long as the tap lives.
    #[must_use]
    pub fn with_connection(mut self, guard: Arc<LoggingStreamGuard>) -> Self {
        self.connection = Some(guard);
        self
    }

    /// The playout's statistics.
    pub fn stats(&self) -> &Arc<ChainStats> {
        &self.stats
    }

    /// The clock drift correction mode the connection was made under.
    pub fn drift_mode(&self) -> DriftMode {
        self.drift_mode
    }

    /// Where the monitor leaves the connection's rate command, if its audio
    /// is being corrected.
    pub fn rate_control(&self) -> Option<&Arc<RateControl>> {
        self.rate_control.as_ref()
    }

    /// Milliseconds of audio drift correction has inserted into (positive)
    /// or removed from the connection so far, or `None` if it corrects
    /// nothing.
    pub fn net_inserted_ms(&self) -> Option<f64> {
        let control = self.rate_control.as_ref()?;
        Some(control.net_inserted_frames() as f64 * 1000.0 / f64::from(self.sample_rate.max(1)))
    }

    /// The playback epoch this connection started, once it has served a
    /// real frame.
    pub fn epoch(&self) -> Option<PlaybackEpoch> {
        self.epoch.get().copied()
    }

    /// Records the epoch this connection started. Only the first call has
    /// any effect: a connection starts exactly one epoch.
    pub(crate) fn set_epoch(&self, epoch: PlaybackEpoch) {
        let _ = self.epoch.set(epoch);
    }

    /// The speaker head start this connection was sent, once its cadence
    /// body has been built. Always `None` for a compressed codec, which gets
    /// no connect burst.
    pub fn head_start(&self) -> Option<HeadStart> {
        self.head_start.get().copied()
    }

    /// Records the head start this connection was sent. Only the first call
    /// has any effect.
    pub(crate) fn set_head_start(&self, head_start: HeadStart) {
        let _ = self.head_start.set(head_start);
    }

    /// The latest verdict on the network path to this connection's speaker,
    /// judged from its TCP counters, or `None` before the first verdict or
    /// where the platform does not report them. Read by the speaker monitor
    /// to tell a Wi-Fi stall from other causes of a low reserve.
    pub fn link_verdict(&self) -> Option<LinkQuality> {
        self.stats.connection()?.link_verdict()
    }

    /// How far the speaker's acknowledgements lag the audio handed to the
    /// connection right now, in milliseconds of audio, where the platform
    /// reports acknowledged bytes (PCM only).
    ///
    /// Read from the monitor, not between frames as the pipeline snapshots
    /// are, so a frame yielded between the two reads can skew it by one
    /// frame. It is taken on every monitor tick because the snapshots are
    /// taken only while the connection is being polled for audio: a stall
    /// long enough to stop that is otherwise seen only once it clears.
    ///
    /// `None` near the connection's declared end, and at a segment boundary
    /// (see [`Self::near_declared_end`]).
    pub fn unacked_ms_now(&self) -> Option<f64> {
        if self.byte_rate == 0 || self.stats.playout.at_boundary() {
            return None;
        }
        let bytes = self.stats.connection()?.unacked_bytes_now()?;
        Some(bytes as f64 * 1000.0 / f64::from(self.byte_rate))
    }

    /// Whether the connection is near or at the end its speaker was told of:
    /// the length in the WAV header, or a declared `Content-Length` (see
    /// [`crate::stream::DeclaredEnd`]). Always `false` for a compressed
    /// codec, which declares no end.
    ///
    /// What the speaker does there is the item ending, so from a little
    /// before it until the connection closes the monitor reads no stall, and
    /// no notice, into what it sees.
    ///
    /// The same holds at a PCM segment boundary: while the playout is parked
    /// between segment connections, and while the next segment settles (see
    /// [`crate::stream::playout::BOUNDARY_SETTLE`]).
    pub fn near_declared_end(&self) -> bool {
        self.stats.playout.at_boundary()
            || self
                .stats
                .connection()
                .is_some_and(|guard| guard.near_declared_end())
    }

    /// Whether the connection has handed over everything up to its declared
    /// end, or the playout is parked after a segment that did: if it closes
    /// now, it ended with the item.
    pub fn reached_declared_end(&self) -> bool {
        self.stats.playout.parked_at_end()
            || self
                .stats
                .connection()
                .is_some_and(|guard| guard.reached_declared_end())
    }

    /// Audio bytes handed over so far: the playout's output position.
    ///
    /// Counts what the body has yielded, so it runs ahead of what the speaker
    /// has received by whatever sits in the socket's send buffer. Headers are
    /// not counted, nor is audio sent again, and a playout that started with
    /// a partial fetch counts from the byte the speaker took it to start at.
    pub fn audio_bytes_sent(&self) -> u64 {
        self.stats.position()
    }

    /// Milliseconds of audio handed to the connection so far, or `None` for a
    /// compressed codec.
    ///
    /// Starts at the same byte the speaker plays at RelTime 0 on the
    /// playout's first segment, and runs on across its segments, as RelTime
    /// does once mapped onto the playout (see
    /// [`Self::continuous_position`]). Inserted or removed audio is counted
    /// too, which is right, since the speaker plays it.
    pub fn delivered_ms(&self) -> Option<u64> {
        (self.byte_rate > 0)
            .then(|| self.audio_bytes_sent().saturating_mul(1000) / u64::from(self.byte_rate))
    }

    /// Publishes the monitor's latest figures for this connection, where
    /// the connection's pipeline snapshots pick them up.
    pub fn publish_speaker(&self, figures: SpeakerFigures) {
        self.stats.speaker.publish(figures);
    }

    /// Maps a speaker's reported position onto this playout: a URL naming
    /// any segment of the stream becomes its `live.wav` URL, and RelTime is
    /// counted from the playout's start rather than the segment's, so a
    /// segment switch is neither a track change nor RelTime going backwards.
    /// Anything else is returned as it was.
    ///
    /// The mapped position names the playout segment it was counted on,
    /// when the playout has a record of it (see [`MappedPosition`]).
    pub fn continuous_position(&self, track_uri: String, rel_ms: u64) -> MappedPosition {
        match self.stats.playout.continuous_position(
            &self.stream_id,
            &track_uri,
            rel_ms,
            self.stats.position(),
        ) {
            Some(mapped) => mapped,
            None => MappedPosition {
                track_uri,
                rel_ms,
                timeline: None,
            },
        }
    }

    /// What the connection's pipeline snapshots currently carry from the
    /// monitor.
    #[cfg(test)]
    pub(crate) fn speaker_snapshot(&self) -> Option<SpeakerSnapshot> {
        self.stats.speaker.snapshot()
    }

    /// Counts `bytes` more body bytes handed to the connection, as its body
    /// would, the WAV header's included.
    #[cfg(test)]
    pub(crate) fn record_body_bytes(&self, bytes: usize) {
        if let Some(guard) = self.stats.connection() {
            guard.record_body_bytes(bytes);
        }
    }

    /// The playout's pipeline snapshots from the last `window`.
    pub(crate) fn recent_pipeline(&self, window: Duration) -> Vec<PipelineSample> {
        self.stats.recent_pipeline(window)
    }
}

/// What the speaker monitor last concluded about a connection's speaker.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SpeakerFigures {
    /// Estimated reserve (audio delivered but not yet played) and its
    /// precision, in milliseconds.
    pub reserve: Option<(f64, f64)>,
    /// How much faster the speaker plays than our clock runs, and the
    /// standard error, in ppm.
    pub clock_ppm: Option<(f64, f64)>,
}

/// The speaker monitor's latest figures, as they appear in a pipeline
/// snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SpeakerSnapshot {
    /// Estimated reserve in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserve_ms: Option<i32>,
    /// Half-width of the interval the reserve is known to lie in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precision_ms: Option<u32>,
    /// Speaker clock against ours, in ppm (positive plays faster).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock_ppm: Option<f32>,
    /// Standard error of `clock_ppm`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock_se_ppm: Option<f32>,
}

/// Lock-free home for [`SpeakerFigures`], written by the monitor every 30 s
/// and read by the cadence loop every 500 ms. Fields are independent
/// atomics: a snapshot taken mid-update may mix two updates, which is
/// harmless for figures that change this slowly.
pub struct SpeakerCell {
    reserve_ms: AtomicI32,
    precision_ms: AtomicU32,
    clock_ppm_milli: AtomicI32,
    clock_se_ppm_milli: AtomicU32,
}

/// Marks a signed field of [`SpeakerCell`] as not known.
const UNKNOWN_I32: i32 = i32::MIN;
/// Marks an unsigned field of [`SpeakerCell`] as not known.
const UNKNOWN_U32: u32 = u32::MAX;

impl Default for SpeakerCell {
    fn default() -> Self {
        Self {
            reserve_ms: AtomicI32::new(UNKNOWN_I32),
            precision_ms: AtomicU32::new(UNKNOWN_U32),
            clock_ppm_milli: AtomicI32::new(UNKNOWN_I32),
            clock_se_ppm_milli: AtomicU32::new(UNKNOWN_U32),
        }
    }
}

impl SpeakerCell {
    /// Stores the latest figures; a figure that is `None` becomes unknown.
    pub fn publish(&self, figures: SpeakerFigures) {
        let signed = |v: f64| v.round().clamp(-(i32::MAX as f64), i32::MAX as f64) as i32;
        let unsigned = |v: f64| v.round().clamp(0.0, (u32::MAX - 1) as f64) as u32;
        let (reserve, precision) = figures
            .reserve
            .map_or((UNKNOWN_I32, UNKNOWN_U32), |(r, p)| {
                (signed(r), unsigned(p))
            });
        let (ppm, se) = figures
            .clock_ppm
            .map_or((UNKNOWN_I32, UNKNOWN_U32), |(c, e)| {
                (signed(c * 1000.0), unsigned(e * 1000.0))
            });
        self.reserve_ms.store(reserve, Ordering::Relaxed);
        self.precision_ms.store(precision, Ordering::Relaxed);
        self.clock_ppm_milli.store(ppm, Ordering::Relaxed);
        self.clock_se_ppm_milli.store(se, Ordering::Relaxed);
    }

    /// The figures for a pipeline snapshot, or `None` if nothing is known.
    pub fn snapshot(&self) -> Option<SpeakerSnapshot> {
        let signed = |a: &AtomicI32| Some(a.load(Ordering::Relaxed)).filter(|v| *v != UNKNOWN_I32);
        let unsigned =
            |a: &AtomicU32| Some(a.load(Ordering::Relaxed)).filter(|v| *v != UNKNOWN_U32);
        let snapshot = SpeakerSnapshot {
            reserve_ms: signed(&self.reserve_ms),
            precision_ms: unsigned(&self.precision_ms),
            clock_ppm: signed(&self.clock_ppm_milli).map(|v| v as f32 / 1000.0),
            clock_se_ppm: unsigned(&self.clock_se_ppm_milli).map(|v| v as f32 / 1000.0),
        };
        (snapshot.reserve_ms.is_some() || snapshot.clock_ppm.is_some()).then_some(snapshot)
    }
}

/// Hands connections to the speaker monitor.
///
/// Cheap to clone. Registration never blocks: it runs on the streaming
/// runtime inside the cadence loop, where waiting on the monitor would stall
/// the audio, so a registration that finds the queue full is dropped with a
/// warning instead.
#[derive(Clone)]
pub struct MonitorRegistrar {
    tx: mpsc::Sender<Weak<ConnectionTap>>,
}

impl MonitorRegistrar {
    /// Creates a registrar and the receiver the monitor drains.
    pub fn channel() -> (Self, mpsc::Receiver<Weak<ConnectionTap>>) {
        let (tx, rx) = mpsc::channel(MONITOR_REGISTRATION_CAPACITY);
        (Self { tx }, rx)
    }

    /// Registers a connection that has started its playback epoch.
    pub fn register(&self, tap: &Arc<ConnectionTap>) {
        match self.tx.try_send(Arc::downgrade(tap)) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => log::warn!(
                "[Stream] Speaker monitor is not keeping up; {} will not be monitored on this \
                 connection (stream={})",
                tap.speaker_ip,
                tap.stream_id
            ),
            // The monitor has shut down; there is nothing to register with.
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::AtomicU64;

    /// Epoch ids for test taps, unique across the test binary.
    static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1_000_000);

    /// A PCM tap for `speaker_ip` on `stream_id` whose epoch has started.
    pub(crate) fn started_tap(
        stream_id: &str,
        speaker_ip: &str,
        monitor: bool,
    ) -> Arc<ConnectionTap> {
        started_tap_with_codec(stream_id, speaker_ip, monitor, AudioCodec::Pcm)
    }

    /// A tap of `codec` for `speaker_ip` on `stream_id` whose epoch has
    /// started.
    pub(crate) fn started_tap_with_codec(
        stream_id: &str,
        speaker_ip: &str,
        monitor: bool,
        codec: AudioCodec,
    ) -> Arc<ConnectionTap> {
        started_tap_with_drift(
            stream_id,
            speaker_ip,
            monitor,
            codec,
            crate::services::speaker_monitor::DriftMode::Off,
            None,
        )
    }

    /// A tap of `codec` for `speaker_ip` on `stream_id` whose epoch has
    /// started, made under drift correction `mode` with `rate_control`.
    pub(crate) fn started_tap_with_drift(
        stream_id: &str,
        speaker_ip: &str,
        monitor: bool,
        codec: AudioCodec,
        mode: crate::services::speaker_monitor::DriftMode,
        rate_control: Option<Arc<RateControl>>,
    ) -> Arc<ConnectionTap> {
        started_tap_with_guard(
            stream_id,
            speaker_ip,
            monitor,
            codec,
            mode,
            rate_control,
            None,
        )
    }

    /// A PCM tap for `speaker_ip` on `stream_id` whose epoch has started and
    /// whose body declares its end after `declared_end` bytes.
    pub(crate) fn started_tap_with_declared_end(
        stream_id: &str,
        speaker_ip: &str,
        declared_end: u64,
    ) -> Arc<ConnectionTap> {
        let byte_rate = AudioFormat::default().frame_bytes(1000) as u32;
        started_tap_with_guard(
            stream_id,
            speaker_ip,
            true,
            AudioCodec::Pcm,
            crate::services::speaker_monitor::DriftMode::Off,
            None,
            Some(crate::stream::DeclaredEnd::new(declared_end, byte_rate)),
        )
    }

    /// A tap as [`started_tap_with_drift`] makes it, whose guard records
    /// `declared_end`.
    fn started_tap_with_guard(
        stream_id: &str,
        speaker_ip: &str,
        monitor: bool,
        codec: AudioCodec,
        mode: crate::services::speaker_monitor::DriftMode,
        rate_control: Option<Arc<RateControl>>,
        declared_end: Option<crate::stream::DeclaredEnd>,
    ) -> Arc<ConnectionTap> {
        let ip: IpAddr = speaker_ip.parse().expect("test address");
        let guard = Arc::new(
            LoggingStreamGuard::new(stream_id.to_string(), ip).with_declared_end(declared_end),
        );
        let tap = Arc::new(
            ConnectionTap::new(
                stream_id,
                ip,
                Instant::now(),
                codec,
                &AudioFormat::default(),
                ChainStats::for_connection(stream_id, &guard, pcm_header(codec)),
                monitor,
            )
            .with_drift(mode, rate_control)
            .with_connection(guard),
        );
        if codec == AudioCodec::Pcm {
            tap.set_head_start(HeadStart::new(500, 500));
        }
        tap.set_epoch(PlaybackEpoch {
            id: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
            audio_epoch: Instant::now(),
        });
        tap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tap(codec: AudioCodec) -> ConnectionTap {
        let ip: IpAddr = "::ffff:192.168.1.50".parse().unwrap();
        let guard = Arc::new(LoggingStreamGuard::new("s".into(), ip));
        ConnectionTap::new(
            "s",
            ip,
            Instant::now(),
            codec,
            &AudioFormat::default(),
            ChainStats::for_connection("s", &guard, pcm_header(codec)),
            true,
        )
        .with_connection(guard)
    }

    #[test]
    fn the_speaker_address_is_canonicalised() {
        assert_eq!(
            tap(AudioCodec::Pcm).speaker_ip,
            "192.168.1.50".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn delivered_audio_excludes_the_wav_header() {
        let tap = tap(AudioCodec::Pcm);
        assert_eq!(tap.byte_rate, 192_000);
        assert_eq!(tap.delivered_ms(), Some(0));
        tap.record_body_bytes(WAV_HEADER_BYTES as usize + 192_000 / 2);
        assert_eq!(tap.delivered_ms(), Some(500));
    }

    #[test]
    fn a_compressed_connection_reports_no_delivered_time() {
        let tap = tap(AudioCodec::Aac);
        tap.record_body_bytes(100_000);
        assert_eq!(tap.delivered_ms(), None);
        assert_eq!(tap.audio_bytes_sent(), 100_000);
    }

    #[test]
    fn a_connection_starts_one_epoch() {
        let tap = tap(AudioCodec::Pcm);
        assert!(tap.epoch().is_none());
        let first = Instant::now();
        tap.set_epoch(PlaybackEpoch {
            id: 7,
            audio_epoch: first,
        });
        tap.set_epoch(PlaybackEpoch {
            id: 8,
            audio_epoch: Instant::now(),
        });
        assert_eq!(tap.epoch().map(|e| e.id), Some(7));
    }

    #[test]
    fn speaker_figures_reach_the_pipeline_snapshot() {
        let cell = SpeakerCell::default();
        assert_eq!(cell.snapshot(), None, "nothing known yet");
        cell.publish(SpeakerFigures {
            reserve: Some((512.4, 34.2)),
            clock_ppm: Some((-39.84, 7.1)),
        });
        let snap = cell.snapshot().expect("known");
        assert_eq!(snap.reserve_ms, Some(512));
        assert_eq!(snap.precision_ms, Some(34));
        assert!((snap.clock_ppm.unwrap() + 39.84).abs() < 0.001);
        cell.publish(SpeakerFigures {
            reserve: None,
            clock_ppm: Some((1.0, 2.0)),
        });
        let snap = cell.snapshot().expect("clock still known");
        assert_eq!(snap.reserve_ms, None);
        assert_eq!(
            serde_json::to_string(&snap).unwrap(),
            r#"{"clock_ppm":1.0,"clock_se_ppm":2.0}"#
        );
    }

    #[tokio::test]
    async fn registration_hands_over_a_weak_reference() {
        let (registrar, mut rx) = MonitorRegistrar::channel();
        let tap = Arc::new(tap(AudioCodec::Pcm));
        registrar.register(&tap);
        let weak = rx.recv().await.expect("registered");
        assert!(weak.upgrade().is_some());
        drop(tap);
        assert!(
            weak.upgrade().is_none(),
            "the monitor must not keep a finished connection alive"
        );
    }
}
