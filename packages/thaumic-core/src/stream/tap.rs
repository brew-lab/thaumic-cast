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
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Instant;

use tokio::sync::mpsc;

use super::cadence::LoggingStreamGuard;
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
        let ip: IpAddr = speaker_ip.parse().expect("test address");
        let tap = Arc::new(ConnectionTap::new(
            stream_id,
            ip,
            Instant::now(),
            AudioCodec::Pcm,
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
