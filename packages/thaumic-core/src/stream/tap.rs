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
//! The handler for each playback-tracking connection creates a
//! [`ConnectionTap`]; the response body owns it and the monitor holds only a
//! [`Weak`], so a connection that ends takes its monitoring with it. The tap is
//! handed to the monitor through a [`MonitorRegistrar`] when the connection
//! serves its first real frame, which is also when its playback epoch starts.

use std::net::IpAddr;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc;

use super::cadence::{LoggingStreamGuard, PipelineSample};
use super::manager::PlaybackEpoch;
use super::{AudioCodec, AudioFormat};

/// Length of the WAV header every PCM connection starts with.
pub const WAV_HEADER_BYTES: u32 = 44;

/// How many registrations may wait for the monitor before new ones are
/// dropped. A registration is one per connection, and the monitor drains them
/// every loop iteration, so this is only ever reached if the monitor has died.
pub const MONITOR_REGISTRATION_CAPACITY: usize = 64;

/// State shared between one speaker's HTTP connection and the speaker monitor.
///
/// Created in `api/stream.rs` beside the connection's [`LoggingStreamGuard`]
/// for readers that track playback (a speaker the stream is for, or this
/// machine). The response body holds the only strong reference; the monitor
/// and [`crate::stream::StreamTiming`] hold [`Weak`] ones.
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
    /// The connection's delivery statistics, whose byte counter is the
    /// delivered side of the speaker's reserve.
    guard: Arc<LoggingStreamGuard>,
    /// The playback epoch this connection started, set once on its first
    /// real frame, before the tap is registered with the monitor.
    epoch: OnceLock<PlaybackEpoch>,
}

impl ConnectionTap {
    /// Creates the tap for one connection.
    ///
    /// `speaker_ip` is canonicalised here. `monitor` is whether speaker
    /// monitoring is on for this connection (see
    /// [`crate::services::latency_monitor::speaker_monitor_enabled`]).
    pub fn new(
        stream_id: impl Into<String>,
        speaker_ip: IpAddr,
        connected_at: Instant,
        codec: AudioCodec,
        audio_format: &AudioFormat,
        guard: Arc<LoggingStreamGuard>,
        monitor: bool,
    ) -> Self {
        let (byte_rate, header_bytes) = match codec {
            AudioCodec::Pcm => (
                audio_format.frame_bytes(1000).min(u32::MAX as usize) as u32,
                WAV_HEADER_BYTES,
            ),
            AudioCodec::Aac | AudioCodec::Mp3 | AudioCodec::Flac => (0, 0),
        };
        Self {
            stream_id: stream_id.into(),
            speaker_ip: speaker_ip.to_canonical(),
            connected_at,
            byte_rate,
            header_bytes,
            monitor,
            guard,
            epoch: OnceLock::new(),
        }
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

    /// Audio bytes handed to the connection so far, excluding the header.
    ///
    /// Counts what the body has yielded, so it runs ahead of what the speaker
    /// has received by whatever sits in the socket's send buffer.
    pub fn audio_bytes_sent(&self) -> u64 {
        self.guard
            .bytes_sent
            .load(Ordering::Relaxed)
            .saturating_sub(u64::from(self.header_bytes))
    }

    /// Milliseconds of audio handed to the connection so far, or `None` for a
    /// compressed codec.
    ///
    /// Starts at the same byte the speaker plays at RelTime 0: every fetch is
    /// served from the live edge, never from a requested offset, so each
    /// connection's count starts afresh. Inserted or removed audio would be
    /// counted too, which is right, since the speaker plays it.
    pub fn delivered_ms(&self) -> Option<u64> {
        (self.byte_rate > 0)
            .then(|| self.audio_bytes_sent().saturating_mul(1000) / u64::from(self.byte_rate))
    }

    /// Publishes the monitor's latest figures for this connection, where
    /// the connection's pipeline snapshots pick them up.
    pub fn publish_speaker(&self, figures: SpeakerFigures) {
        self.guard.speaker.publish(figures);
    }

    /// What the connection's pipeline snapshots currently carry from the
    /// monitor.
    #[cfg(test)]
    pub(crate) fn speaker_snapshot(&self) -> Option<SpeakerSnapshot> {
        self.guard.speaker.snapshot()
    }

    /// The connection's pipeline snapshots from the last `window`.
    pub(crate) fn recent_pipeline(&self, window: Duration) -> Vec<PipelineSample> {
        self.guard.recent_pipeline(window)
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
        let ip: IpAddr = speaker_ip.parse().expect("test address");
        let tap = Arc::new(ConnectionTap::new(
            stream_id,
            ip,
            Instant::now(),
            codec,
            &AudioFormat::default(),
            Arc::new(LoggingStreamGuard::new(stream_id.to_string(), ip)),
            monitor,
        ));
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
        ConnectionTap::new(
            "s",
            ip,
            Instant::now(),
            codec,
            &AudioFormat::default(),
            Arc::new(LoggingStreamGuard::new("s".into(), ip)),
            true,
        )
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
        tap.guard
            .bytes_sent
            .store(u64::from(WAV_HEADER_BYTES) + 192_000 / 2, Ordering::Relaxed);
        assert_eq!(tap.delivered_ms(), Some(500));
    }

    #[test]
    fn a_compressed_connection_reports_no_delivered_time() {
        let tap = tap(AudioCodec::Aac);
        tap.guard.bytes_sent.store(100_000, Ordering::Relaxed);
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
