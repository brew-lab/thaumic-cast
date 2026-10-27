//! Stream lifecycle and playback orchestration service.
//!
//! Responsibilities:
//! - Create/remove audio streams (wraps StreamRegistry)
//! - Start/stop playback on Sonos speakers (supports multi-group)
//! - Track which streams are playing on which speakers
//! - Track expected stream URLs for source change detection
//! - Broadcast stream lifecycle events to WebSocket clients

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use bytes::Bytes;
use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::capture::diagnostics::{tap_dir_from_env, ContentStats, WavTap};
use crate::capture::{AudioSink, AudioSource, BufferFlags, CaptureHandle};

use crate::context::NetworkContext;
use crate::error::ThaumicResult;
use crate::events::{EventEmitter, SpeakerRemovalReason, StreamEvent};
use crate::protocol_constants::SPEAKERS_UPNP_DISABLED;
use crate::sonos::subscription_arbiter::SubscriptionArbiter;
use crate::sonos::types::TransportState;
use crate::sonos::utils::build_sonos_stream_uri;
use crate::sonos::SonosPlayback;
use crate::state::{SonosState, StreamingConfig};
use crate::stream::{
    apply_fade_in, create_fade_out_frame, crossfade_samples, extract_last_sample_pair, AudioCodec,
    AudioFormat, CleanupOrder, StreamMetadata, StreamRegistry, StreamState,
};
use crate::utils::now_millis;

use super::playback_session_store::{
    GroupRole, PlaybackResult, PlaybackSession, PlaybackSessionStore,
};
use super::regroup::{plan_regroup, OldGroup, RoomRef};
use super::sync_group_manager::{GroupsUnread, JoinRoomRequest, SyncGroupManager};
use super::volume_router::VolumeRouter;

mod continuation;

// ─────────────────────────────────────────────────────────────────────────────
// StreamSinkBridge — Float32 → PCM16 conversion for capture sources
// ─────────────────────────────────────────────────────────────────────────────

/// Bridges an [`AudioSource`] into the streaming pipeline by converting
/// Float32 audio to PCM16 and pushing frames via [`StreamCoordinator::push_frame`].
///
/// The conversion buffer is pre-allocated and reused across callbacks to avoid
/// allocation jitter on the MMCSS-elevated capture thread. Only
/// `Bytes::copy_from_slice` allocates (~1920 bytes per 10ms callback), which is
/// unavoidable since the data must be owned for the broadcast channel.
struct StreamSinkBridge {
    stream_id: String,
    coordinator: Arc<StreamCoordinator>,
    /// Reusable PCM16 conversion buffer — avoids allocation on capture thread.
    buf: Mutex<Vec<u8>>,
    /// Ensures STREAM_READY notification is sent exactly once.
    ready_notified: AtomicBool,
    /// Notify handle to wake the WebSocket handler when first frame arrives.
    ready_notify: Arc<Notify>,
    /// Fade length applied to the first packet after a discontinuity.
    fade_samples: usize,
    /// Most silence (in audio frames) backfilled for one loss: one jitter
    /// buffer, so a long source pause costs at most that much extra latency.
    backfill_cap_frames: u64,
    /// Rate limit for backfill logging (once per second).
    last_backfill_log: Mutex<Option<std::time::Instant>>,
    /// Last converted sample pair, so backfilled silence can start with a
    /// fade-out instead of a hard cut from the last real packet.
    last_sample_pair: Mutex<Option<(i16, i16)>>,
    /// Lost frames below one packet carried to the next loss, so repeated
    /// small losses are backfilled in total rather than rounded away.
    backfill_residual: Mutex<u64>,
    /// Sample rate of the source, for content statistics.
    sample_rate: u32,
    /// What the captured samples contain, summarised to the log periodically.
    content: Mutex<ContentStats>,
    /// Copy of everything pushed into the pipeline, when a tap directory is set.
    tap: Mutex<Option<WavTap>>,
}

impl StreamSinkBridge {
    fn new(
        stream_id: String,
        coordinator: Arc<StreamCoordinator>,
        ready_notify: Arc<Notify>,
        audio_format: &AudioFormat,
        jitter_buffer_ms: u64,
    ) -> Self {
        let tap =
            tap_dir_from_env().and_then(|dir| match WavTap::open(&dir, &stream_id, audio_format) {
                Ok(tap) => {
                    log::info!(
                        "[Capture] Writing captured audio for stream {} to {}",
                        stream_id,
                        tap.path().display()
                    );
                    Some(tap)
                }
                Err(e) => {
                    log::warn!(
                        "[Capture] Could not open capture tap in {}: {}",
                        dir.display(),
                        e
                    );
                    None
                }
            });
        Self {
            stream_id,
            coordinator,
            // Pre-allocate for typical 10ms buffer: 480 frames × 2ch × 2 bytes = 1920
            buf: Mutex::new(Vec::with_capacity(1920)),
            ready_notified: AtomicBool::new(false),
            ready_notify,
            fade_samples: crossfade_samples(audio_format.sample_rate),
            backfill_cap_frames: jitter_buffer_ms * audio_format.sample_rate as u64 / 1000,
            last_backfill_log: Mutex::new(None),
            last_sample_pair: Mutex::new(None),
            backfill_residual: Mutex::new(0),
            sample_rate: audio_format.sample_rate,
            content: Mutex::new(ContentStats::new()),
            tap: Mutex::new(tap),
        }
    }

    /// Pushes one frame, returning whether it was the stream's first.
    fn push(&self, frame: Bytes) -> bool {
        {
            let mut tap = self.tap.lock();
            if let Some(writer) = tap.as_mut() {
                if let Err(e) = writer.write(&frame) {
                    log::warn!(
                        "[Capture] Capture tap {} failed, stopping it: {}",
                        writer.path().display(),
                        e
                    );
                    *tap = None;
                }
            }
        }
        match self.coordinator.push_frame(&self.stream_id, frame) {
            Some(first) => first,
            None => {
                log::warn!("push_frame failed for stream {}", self.stream_id);
                false
            }
        }
    }

    /// Replaces audio the platform discarded with the same duration of
    /// silence, in packet-sized frames, so the cadence consumer's timeline
    /// (and its jitter-buffer depth) is not shortened by the loss.
    /// Returns whether one of the pushed frames was the stream's first.
    fn backfill_lost(&self, lost_frames: u32, packet_frames: u32, channels: u16) -> bool {
        let packet = packet_frames as u64;
        let mut residual = self.backfill_residual.lock();
        let total = *residual + lost_frames as u64;
        let capped = total > self.backfill_cap_frames;
        let fill = total.min(self.backfill_cap_frames);
        let chunks = fill / packet;
        // Whole packets are pushed now; the remainder waits for the next loss
        // (dropped when the cap applies, so it cannot grow without bound).
        *residual = if capped { 0 } else { total - chunks * packet };
        drop(residual);
        if chunks == 0 {
            return false;
        }

        let silence = Bytes::from(vec![0u8; packet as usize * channels as usize * 2]);
        // First chunk fades out from the last real sample so the loss point
        // is not a hard edge; the rest is plain silence.
        let first = match self.last_sample_pair.lock().take() {
            Some((left, right)) => {
                create_fade_out_frame(left, right, channels, self.fade_samples, packet as usize)
            }
            None => silence.clone(),
        };
        let mut is_first = self.push(first);
        for _ in 1..chunks {
            is_first |= self.push(silence.clone());
        }

        let mut last_log = self.last_backfill_log.lock();
        let now = std::time::Instant::now();
        let due = match *last_log {
            None => true,
            Some(t) => now.duration_since(t).as_secs() >= 1,
        };
        if due {
            *last_log = Some(now);
            log::info!(
                "[Capture] Backfilled {} silence frames for {} lost audio frames{} on stream {}",
                chunks,
                total,
                if capped { " (capped)" } else { "" },
                self.stream_id
            );
        }
        is_first
    }
}

impl AudioSink for StreamSinkBridge {
    fn push_audio(&self, data: &[f32], frames: u32, channels: u16, flags: BufferFlags) {
        let mut is_first = false;
        if flags.lost_frames > 0 && frames > 0 && channels > 0 {
            is_first |= self.backfill_lost(flags.lost_frames, frames, channels);
        }

        // What the samples contain. The timing counters downstream cannot
        // tell a healthy stream from a punctual stream of broken audio.
        if !flags.silent {
            if let Some(summary) = self
                .content
                .lock()
                .observe(data, channels, self.sample_rate)
            {
                if summary.has_dropouts() {
                    log::warn!(
                        "[Capture] Captured audio has holes in it on stream {}: {}. The source \
                         is delivering gaps (a starved renderer?); the pipeline is passing them on faithfully",
                        self.stream_id,
                        summary
                    );
                } else {
                    log::info!(
                        "[Capture] Content on stream {}: {}",
                        self.stream_id,
                        summary
                    );
                }
            }
        }

        let mut buf = self.buf.lock(); // uncontended — single capture thread, ~25ns
        buf.clear();
        if flags.silent {
            // The platform declares the buffer silent; its bytes may be stale.
            buf.resize(data.len() * 2, 0);
        } else {
            // Convert Float32 [-1.0, 1.0] → PCM16 [-32768, 32767]
            buf.reserve(data.len() * 2);
            for &sample in data {
                // Clamp first to avoid i16 overflow, then scale by 32767 (i16::MAX)
                let clamped = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                buf.extend_from_slice(&clamped.to_le_bytes());
            }
            if flags.discontinuity && channels > 0 {
                // The previous packet ended wherever the loss cut it; soften
                // the resume so the seam is not a hard edge.
                apply_fade_in(&mut buf, channels, self.fade_samples);
            }
        }
        if channels > 0 {
            *self.last_sample_pair.lock() = extract_last_sample_pair(&buf, channels);
        }

        is_first |= self.push(Bytes::copy_from_slice(&buf));

        if is_first && !self.ready_notified.swap(true, Ordering::SeqCst) {
            self.ready_notify.notify_one();
        }
    }
}

/// Sink that forwards audio to an inner sink once one is bound and drops it
/// until then. Lets a source start (and negotiate its format with the
/// platform) before the stream that will receive its audio exists.
#[derive(Default)]
struct LateBoundSink {
    inner: OnceLock<Arc<dyn AudioSink>>,
}

impl LateBoundSink {
    /// Binds the sink that receives all further audio. Only the first bind takes effect.
    fn bind(&self, sink: Arc<dyn AudioSink>) {
        let _ = self.inner.set(sink);
    }
}

impl AudioSink for LateBoundSink {
    fn push_audio(&self, data: &[f32], frames: u32, channels: u16, flags: BufferFlags) {
        if let Some(sink) = self.inner.get() {
            sink.push_audio(data, frames, channels, flags);
        }
    }
}

/// Packet duration delivered by capture sources, in milliseconds.
///
/// WASAPI shared-mode loopback delivers one engine period (10 ms) per packet
/// regardless of the client's preset, so a capture stream's cadence must run
/// at this rate or the jitter buffer fills faster than it drains.
const CAPTURE_PACKET_DURATION_MS: u32 = 10;

/// How long [`StreamCoordinator::clear_all`] spends on speaker calls in all:
/// reading the grouping, stopping every speaker and putting rooms back.
const CLEAR_ALL_BUDGET: std::time::Duration = std::time::Duration::from_secs(4);

/// Active browser capture session returned by [`StreamCoordinator::start_capture_stream`].
pub struct CaptureStreamSession {
    /// The stream ID in the registry.
    pub stream_id: String,
    /// Handle to the capture thread — call `stop_and_wait()` for graceful shutdown.
    pub handle: CaptureHandle,
    /// Notified when the first audio frame arrives (for STREAM_READY signal).
    pub ready_notify: Arc<Notify>,
}

/// Moves a URL we serve from `old_base` onto `new_base`, leaving any other URL
/// (a hosted artwork image, say) untouched.
fn rebase_local_url(url: &str, old_base: &str, new_base: &str) -> String {
    match url.strip_prefix(old_base) {
        Some(path) if path.is_empty() || path.starts_with('/') => format!("{new_base}{path}"),
        _ => url.to_string(),
    }
}

/// Parameters for starting playback on a single speaker.
struct SinglePlaybackParams<'a> {
    speaker_ip: &'a str,
    stream_id: &'a str,
    stream_url: &'a str,
    codec: AudioCodec,
    audio_format: &'a AudioFormat,
    artwork_url: &'a str,
    metadata: Option<&'a StreamMetadata>,
    /// Make the speaker leave its Sonos group before it is given the stream.
    leave_first: bool,
    /// Start levels to set, after leaving and before the stream is given.
    start_levels: Option<StartLevels<'a>>,
    /// The rooms `start_levels` applies to, as `(uuid, ip)`: the speaker's
    /// own and those of its group's rooms that stay in the cast.
    level_rooms: Vec<(String, String)>,
    /// The group the room was in, recorded on its session.
    old_group: Option<OldGroup>,
}

impl<'a> SinglePlaybackParams<'a> {
    /// A plain start: no regrouping and no start levels.
    fn plain(
        speaker_ip: &'a str,
        stream_id: &'a str,
        stream_url: &'a str,
        stream: (AudioCodec, &'a AudioFormat),
        artwork_url: &'a str,
        metadata: Option<&'a StreamMetadata>,
    ) -> Self {
        Self {
            speaker_ip,
            stream_id,
            stream_url,
            codec: stream.0,
            audio_format: stream.1,
            artwork_url,
            metadata,
            leave_first: false,
            start_levels: None,
            level_rooms: Vec::new(),
            old_group: None,
        }
    }
}

/// Start levels to set for some rooms just before they play or join.
#[derive(Clone, Copy)]
pub(crate) struct StartLevels<'a> {
    /// Volume control for the speakers.
    pub volume: &'a dyn crate::sonos::traits::SonosVolumeControl,
    /// The limit and hand-set levels the client sent.
    pub request: &'a super::start_volume::StartVolumeRequest,
}

impl StartLevels<'_> {
    /// Sets the start level of each of `rooms` (`(uuid, ip)`).
    pub(crate) async fn apply(&self, rooms: &[(String, String)]) {
        super::start_volume::apply_start_volume_to_rooms(self.volume, rooms, self.request).await;
    }
}

/// What starting one speaker did.
struct SingleOutcome {
    result: PlaybackResult,
    /// Whether the speaker left a Sonos group on the way, so a failure has a
    /// room to put back.
    left_group: bool,
}

/// A cast to rooms, as `START_PLAYBACK` carries it with `rooms`.
pub(crate) struct RoomsRequest<'a> {
    /// The stream to play.
    pub stream_id: &'a str,
    /// Player UUIDs of the rooms, in the order chosen.
    pub rooms: &'a [String],
    /// Each room's IP as the client knows it, in the same order: used only to
    /// name a room the household no longer has in its result.
    pub room_ips: &'a [String],
    /// Initial metadata to show on the speakers.
    pub metadata: Option<&'a StreamMetadata>,
    /// URL for album artwork in Sonos DIDL-Lite metadata.
    pub artwork_url: &'a str,
}

/// The rooms an older client's synced start means (see
/// [`StreamCoordinator::legacy_rooms`]).
#[derive(Default)]
struct LegacyRooms {
    /// Room UUIDs, in order.
    rooms: Vec<String>,
    /// Each room's IP, in the same order.
    room_ips: Vec<String>,
    /// Each named speaker and the other rooms of its group it stands for.
    stands_for: Vec<(String, Vec<String>)>,
}

/// A failed [`PlaybackResult`] for `speaker_ip`.
fn failed(speaker_ip: &str, error: impl Into<String>) -> PlaybackResult {
    PlaybackResult {
        speaker_ip: speaker_ip.to_string(),
        success: false,
        stream_url: None,
        error: Some(error.into()),
    }
}

/// Service responsible for stream lifecycle and playback orchestration.
pub struct StreamCoordinator {
    /// Sonos client for playback control.
    sonos: Arc<dyn SonosPlayback>,
    /// Sonos state for UUID lookups.
    sonos_state: Arc<SonosState>,
    stream_registry: Arc<StreamRegistry>,
    /// Network configuration (port, local IP).
    network: NetworkContext,
    /// Active playback sessions with indexed lookups.
    sessions: Arc<PlaybackSessionStore>,
    /// Event emitter for stream lifecycle events.
    emitter: Arc<dyn EventEmitter>,
    /// Sync group lifecycle manager.
    sync_group: SyncGroupManager,
    /// Speakers being moved on from one PCM segment to the next.
    continuations: continuation::Continuations,
    /// Where a PCM handoff's watch runs, off the streaming runtime (see
    /// [`Self::set_control_runtime`]); the current runtime when unset.
    control_runtime: Option<tokio::runtime::Handle>,
    /// For an older client's synced cast, per stream: each speaker it named
    /// and the other rooms of its group that the cast plays too, which that
    /// client has no row for (see [`Self::start_playback_multi`]).
    legacy_extras: Mutex<HashMap<String, HashMap<String, Vec<String>>>>,
}

impl StreamCoordinator {
    /// Creates a new StreamCoordinator.
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for playback control
    /// * `sonos_state` - Sonos state for UUID lookups
    /// * `network` - Network configuration (port, local IP)
    /// * `emitter` - Event emitter for broadcasting stream events
    /// * `streaming_config` - Streaming configuration (concurrency, buffering, channel capacity)
    /// * `arbiter` - Subscription arbiter for RenderingControl/GroupRenderingControl conflict resolution
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        sonos_state: Arc<SonosState>,
        network: NetworkContext,
        emitter: Arc<dyn EventEmitter>,
        streaming_config: StreamingConfig,
        arbiter: Arc<SubscriptionArbiter>,
    ) -> Self {
        let sessions = Arc::new(PlaybackSessionStore::new());
        let stream_registry = Arc::new(StreamRegistry::new(streaming_config));
        let sync_group = SyncGroupManager::new(
            Arc::clone(&sessions),
            Arc::clone(&sonos),
            Arc::clone(&sonos_state),
            Arc::clone(&emitter),
            arbiter,
            Arc::clone(&stream_registry),
            network.clone(),
        );
        Self {
            sonos,
            sonos_state,
            stream_registry,
            network,
            sessions,
            emitter,
            sync_group,
            continuations: continuation::Continuations::default(),
            control_runtime: None,
            legacy_extras: Mutex::new(HashMap::new()),
        }
    }

    /// Sets the runtime that moves speakers on from one PCM segment to the
    /// next. A playout reports its segment's end from the streaming runtime;
    /// the watch that then polls and restarts the speaker runs here instead,
    /// keeping control traffic off that latency-sensitive runtime.
    pub fn set_control_runtime(&mut self, handle: tokio::runtime::Handle) {
        self.control_runtime = Some(handle);
    }

    /// Sets the topology refresh notifier.
    pub fn set_topology_refresh(&mut self, notify: Arc<Notify>) {
        self.sync_group.set_topology_refresh(notify);
    }

    /// Emits a stream event to all listeners.
    fn emit_event(&self, event: StreamEvent) {
        self.emitter.emit_stream(event);
    }

    /// Gets the expected stream URL for a speaker (normalized for Sonos comparison).
    ///
    /// Returns the stream URL in the format Sonos will report:
    /// - WAV/FLAC: `http://.../.wav` or `http://.../.flac`
    /// - MP3/AAC: `x-rincon-mp3radio://...`
    /// - Slaves: `x-rincon:{uuid}` (already in final form)
    ///
    /// For PCM this is always segment 0's URL. A speaker reporting a later
    /// segment of the same stream is compared by stream id, not by this exact
    /// string (see `stream::same_stream`), so it is still the same source.
    ///
    /// Note: A speaker can only play one stream at a time, so we find the first
    /// session matching the speaker IP.
    ///
    /// `None` while a stop or promotion is moving the speaker off the stream
    /// (see `PlaybackSessionStore::release`): the track it reports then is
    /// the companion's own doing, not a source change.
    #[must_use]
    pub fn get_expected_stream(&self, speaker_ip: &str) -> Option<String> {
        if self.sessions.is_releasing(speaker_ip) {
            return None;
        }
        self.sessions.get_by_speaker_ip(speaker_ip).map(|session| {
            // x-rincon URIs are already in final form (for slaves)
            if session.stream_url.starts_with("x-rincon:") {
                session.stream_url
            } else {
                build_sonos_stream_uri(&session.stream_url, session.codec)
            }
        })
    }

    /// Checks if a speaker IP is part of a synchronized multi-room playback session.
    ///
    /// A session is considered "synced" if multiple speakers are playing the same
    /// stream with x-rincon joining (at least one speaker has `GroupRole::Slave`).
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the speaker to check
    ///
    /// # Returns
    /// - `Some(true)` if speaker is in a sync session
    /// - `Some(false)` if speaker is in a non-sync session
    /// - `None` if speaker is not in any active session
    #[must_use]
    pub fn is_speaker_in_sync_session(&self, speaker_ip: &str) -> Option<bool> {
        self.sessions.is_in_sync_session(speaker_ip)
    }

    /// Sends a Play command if the speaker isn't already in the Playing state.
    ///
    /// Returns `Ok(true)` if Play was sent, `Ok(false)` if already playing.
    async fn ensure_playing(&self, speaker_ip: &str) -> crate::error::SoapResult<bool> {
        let transport_state = self
            .sonos_state
            .transport_states
            .get(speaker_ip)
            .map(|s| *s);

        if transport_state == Some(TransportState::Playing) {
            return Ok(false);
        }

        log::info!(
            "Speaker {} transport_state={:?}, sending Play command",
            speaker_ip,
            transport_state
        );
        self.sonos.play(speaker_ip).await?;
        Ok(true)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Volume/Mute Routing (delegated to VolumeRouter)
    // ─────────────────────────────────────────────────────────────────────────────

    /// Creates a VolumeRouter scoped to this coordinator's sessions.
    fn volume_router(&self) -> VolumeRouter<'_> {
        VolumeRouter::new(&self.sessions)
    }

    /// Gets volume with automatic routing based on sync session state.
    pub async fn get_volume_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
    ) -> crate::error::SoapResult<u8> {
        self.volume_router()
            .get_volume_routed(sonos, speaker_ip)
            .await
    }

    /// Sets volume with automatic routing based on sync session state.
    pub async fn set_volume_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        volume: u8,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_volume_routed(sonos, speaker_ip, volume)
            .await
    }

    /// Gets mute state with automatic routing based on sync session state.
    pub async fn get_mute_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
    ) -> crate::error::SoapResult<bool> {
        self.volume_router()
            .get_mute_routed(sonos, speaker_ip)
            .await
    }

    /// Sets mute state with automatic routing based on sync session state.
    pub async fn set_mute_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        mute: bool,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_mute_routed(sonos, speaker_ip, mute)
            .await
    }

    /// Resolves the sync session coordinator IP for a given speaker.
    pub fn resolve_sync_coordinator_ip(&self, speaker_ip: &str) -> Option<String> {
        self.volume_router().resolve_sync_coordinator_ip(speaker_ip)
    }

    /// Sets group volume for the entire sync session containing `speaker_ip`.
    pub async fn set_sync_group_volume(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        volume: u8,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_sync_group_volume(sonos, speaker_ip, volume)
            .await
    }

    /// Sets group mute for the entire sync session containing `speaker_ip`.
    pub async fn set_sync_group_mute(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        mute: bool,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_sync_group_mute(sonos, speaker_ip, mute)
            .await
    }

    /// Inserts a playback session for testing purposes.
    ///
    /// This allows tests to set up coordinator state without going through
    /// the full playback start flow, enabling isolated testing of routing logic.
    #[cfg(test)]
    pub(crate) fn insert_test_session(&self, session: PlaybackSession) {
        self.sessions.insert(session);
    }

    /// Creates a new audio stream with the specified output codec.
    ///
    /// # Arguments
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
    /// * `jitter_buffer_ms` - Jitter buffer size in milliseconds (0-1000, 0 is smoothing off)
    /// * `frame_duration_ms` - Frame duration in milliseconds for cadence timing
    ///
    /// Returns the stream ID on success. Broadcasts a `StreamEvent::Created` event.
    pub fn create_stream(
        &self,
        codec: AudioCodec,
        audio_format: AudioFormat,
        jitter_buffer_ms: u64,
        frame_duration_ms: u32,
    ) -> Result<String, String> {
        let stream_id = self.stream_registry.create_stream(
            codec,
            audio_format,
            jitter_buffer_ms,
            frame_duration_ms,
        )?;

        // Broadcast stream created event
        self.emit_event(StreamEvent::Created {
            stream_id: stream_id.clone(),
            timestamp: now_millis(),
        });

        Ok(stream_id)
    }

    /// Start a capture-sourced stream. The source pushes frames directly
    /// via the [`StreamSinkBridge`], which converts Float32 → PCM16 and
    /// calls [`push_frame`].
    ///
    /// The wire format is dictated by the source, not the client: the codec
    /// is always PCM and the sample rate and channel count come from the
    /// format the source negotiated (so the source is started first, before
    /// the stream exists). Only `jitter_buffer_ms` comes from the client;
    /// `frame_duration_ms` must match the source's packet duration and is
    /// overridden with a warning when it does not.
    ///
    /// Returns a [`CaptureStreamSession`] with the stream ID, capture handle,
    /// and a `Notify` that fires when the first audio frame arrives.
    pub fn start_capture_stream(
        self: &Arc<Self>,
        source: Arc<dyn AudioSource>,
        jitter_buffer_ms: u64,
        frame_duration_ms: u32,
        metadata: Option<StreamMetadata>,
    ) -> Result<CaptureStreamSession, String> {
        // The source negotiates its format on start, so start it against a
        // sink that drops audio until the stream is created and bound below.
        let sink = Arc::new(LateBoundSink::default());
        let handle = source
            .start(Arc::clone(&sink) as Arc<dyn AudioSink>)
            .map_err(|e| format!("Failed to start capture: {}", e))?;

        let source_format = source.format();
        if !matches!(source_format.channels, 1 | 2) {
            handle.stop_and_wait();
            return Err(format!(
                "Unsupported capture channel count: {}",
                source_format.channels
            ));
        }
        // The bridge converts whatever the source delivers to PCM16.
        let audio_format = AudioFormat::new(source_format.sample_rate, source_format.channels, 16);

        if frame_duration_ms != CAPTURE_PACKET_DURATION_MS {
            log::warn!(
                "[Capture] Client frame duration {}ms does not match the {}ms capture packet; using {}ms",
                frame_duration_ms,
                CAPTURE_PACKET_DURATION_MS,
                CAPTURE_PACKET_DURATION_MS
            );
        }
        let frame_duration_ms = CAPTURE_PACKET_DURATION_MS;

        let stream_id = match self.create_stream(
            AudioCodec::Pcm,
            audio_format,
            jitter_buffer_ms,
            frame_duration_ms,
        ) {
            Ok(id) => id,
            Err(e) => {
                handle.stop_and_wait();
                return Err(e);
            }
        };

        if let Some(meta) = metadata {
            self.update_metadata(&stream_id, meta);
        }

        let ready_notify = Arc::new(Notify::new());
        let bridge = Arc::new(StreamSinkBridge::new(
            stream_id.clone(),
            Arc::clone(self),
            Arc::clone(&ready_notify),
            &audio_format,
            jitter_buffer_ms,
        ));
        sink.bind(bridge);

        log::info!(
            "[Capture] Started {} for stream {} (source {:?}, wire {:?})",
            source.name(),
            stream_id,
            source_format,
            audio_format,
        );

        Ok(CaptureStreamSession {
            stream_id,
            handle,
            ready_notify,
        })
    }

    /// Removes a stream and cleans up all associated playback sessions.
    ///
    /// Returns the speaker IPs that were playing this stream (for caller to send
    /// SOAP commands if needed).
    ///
    /// Broadcasts a `StreamEvent::Ended` event.
    ///
    /// Note: This is the sync version used by `StreamGuard::drop()`. For graceful
    /// cleanup that stops speakers first, use `remove_stream_async()`.
    pub fn remove_stream(&self, stream_id: &str) -> Vec<String> {
        self.legacy_extras.lock().remove(stream_id);
        // Find and remove ALL playback sessions for this stream (multi-group support)
        let removed = self.sessions.remove_all_for_stream(stream_id);
        let speaker_ips: Vec<String> = removed.iter().map(|s| s.speaker_ip.clone()).collect();

        self.stream_registry.remove_stream(stream_id);

        // Broadcast stream ended event
        self.emit_event(StreamEvent::Ended {
            stream_id: stream_id.to_string(),
            timestamp: now_millis(),
        });

        speaker_ips
    }

    /// Removes a stream with graceful speaker cleanup.
    ///
    /// This is the preferred method for stream removal. The codec determines
    /// cleanup ordering via [`CleanupOrder`] — see [`AudioCodec::cleanup_order`]
    /// for the rationale behind each variant. Runs under the regroup lock
    /// (see [`SyncGroupManager::stop_streams`]), so a cast start still
    /// joining rooms finishes first and its rooms are stopped too.
    ///
    /// Speaker stop/switch failures are logged but don't prevent cleanup.
    pub async fn remove_stream_async(&self, stream_id: &str) {
        self.remove_streams(&[stream_id.to_string()], None).await;
    }

    /// Starts every cast this companion leads again on the route the
    /// household is on now, and tells each stream's client its cast moved.
    ///
    /// For a household whose Sonos UPnP was switched off mid-cast: the audio
    /// plays on, but port 1400 refuses every command, so the cast could not
    /// be stopped, continued or kept in sync. Each coordinator's stream is
    /// loaded again over port 1443, from the live edge (a skip of about the
    /// head start); its rooms follow it as a group does. A cast that cannot
    /// move (FLAC) is left as it is, and logged.
    pub async fn rehome_casts(&self) {
        let coordinators: Vec<PlaybackSession> = self
            .sessions
            .all_sessions()
            .into_iter()
            .filter(|s| s.role == GroupRole::Coordinator)
            .collect();
        let mut moved: Vec<String> = Vec::new();
        for session in coordinators {
            // As every start does: under the speaker's start lock, for the
            // session as it stands once the lock is held.
            let _start = self
                .sessions
                .lock_speaker_start(&session.stream_id, &session.speaker_ip)
                .await;
            let Some(session) = self
                .sessions
                .get(&session.stream_id, &session.speaker_ip)
                .filter(|s| s.role == GroupRole::Coordinator)
            else {
                continue;
            };
            let Some(stream) = self.stream_registry.get_stream(&session.stream_id) else {
                continue;
            };
            let metadata = stream.metadata.read().clone();
            let artwork_url = self.network.url_builder().artwork_url();
            match self
                .sonos
                .play_uri(
                    &session.speaker_ip,
                    &session.stream_url,
                    session.codec,
                    &stream.audio_format,
                    Some(&metadata),
                    &artwork_url,
                )
                .await
            {
                Ok(())
                    if self
                        .sessions
                        .get(&session.stream_id, &session.speaker_ip)
                        .is_none() =>
                {
                    // Stopped while it moved: end what the move started.
                    let _ = self.sonos.stop(&session.speaker_ip).await;
                }
                Ok(()) => {
                    log::info!(
                        "[Stream] Moved stream={} speaker={} to port 1443",
                        session.stream_id,
                        session.speaker_ip
                    );
                    if !moved.contains(&session.stream_id) {
                        moved.push(session.stream_id.clone());
                    }
                }
                Err(e) => log::warn!(
                    "[Stream] Could not move stream={} speaker={} to port 1443: {}",
                    session.stream_id,
                    session.speaker_ip,
                    e
                ),
            }
        }
        for stream_id in moved {
            self.emit_event(StreamEvent::CastMoved {
                stream_id,
                timestamp: now_millis(),
            });
        }
    }

    /// Ends `stream_ids` with graceful speaker cleanup, in one pass under the
    /// regroup lock; with `budget`, the speaker calls are cut off that long
    /// after the lock is held.
    async fn remove_streams(&self, stream_ids: &[String], budget: Option<std::time::Duration>) {
        let streams: Vec<(String, CleanupOrder)> = stream_ids
            .iter()
            .map(|id| {
                let order = self
                    .get_stream(id)
                    .map(|s| s.codec.cleanup_order())
                    .unwrap_or(CleanupOrder::HttpFirst);
                (id.clone(), order)
            })
            .collect();
        self.sync_group.stop_streams(&streams, budget).await;
        for stream_id in stream_ids {
            self.legacy_extras.lock().remove(stream_id);
            self.emit_event(StreamEvent::Ended {
                stream_id: stream_id.clone(),
                timestamp: now_millis(),
            });
        }
    }

    /// Gets a stream by ID.
    pub fn get_stream(&self, id: &str) -> Option<Arc<StreamState>> {
        self.stream_registry.get_stream(id)
    }

    /// Pushes an audio frame to a stream.
    ///
    /// Returns `Some(true)` if this was the first frame (stream just became ready),
    /// `Some(false)` if the stream exists but this wasn't the first frame,
    /// `None` if the stream was not found.
    pub fn push_frame(&self, stream_id: &str, data: Bytes) -> Option<bool> {
        self.stream_registry
            .get_stream(stream_id)
            .map(|stream| stream.push_frame(data))
    }

    /// Updates metadata for a stream.
    pub fn update_metadata(&self, stream_id: &str, metadata: StreamMetadata) {
        if let Some(stream) = self.stream_registry.get_stream(stream_id) {
            stream.update_metadata(metadata);
        }
    }

    /// Sets each room's start level before a cast starts on `speaker_ips`
    /// (see [`super::start_volume`]).
    ///
    /// Call it before [`Self::start_playback_multi`], so the level is in place
    /// before any group is joined or anything plays. A speaker already playing
    /// `stream_id` is skipped: a repeated `START_PLAYBACK` is a resume, and a
    /// resume never changes the volume.
    pub(crate) async fn apply_start_volume(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        stream_id: &str,
        speaker_ips: &[String],
        request: &super::start_volume::StartVolumeRequest,
    ) {
        if request.is_noop() {
            return;
        }
        let starting: Vec<String> = speaker_ips
            .iter()
            .filter(|ip| self.sessions.get(stream_id, ip).is_none())
            .cloned()
            .collect();
        super::start_volume::apply_start_volume(sonos, &self.sonos_state, &starting, request).await;
    }

    /// The stream URL and artwork URL to hand `speaker_ips` for `stream_id`.
    ///
    /// Never hands a speaker a URL on an address it cannot reach when one it
    /// can is available. The artwork URL was built by the caller from the
    /// same address, so it follows the stream URL across the switch.
    fn speaker_urls(
        &self,
        stream_id: &str,
        speaker_ips: &[String],
        artwork_url: &str,
    ) -> (String, String) {
        let old_base = self.network.url_builder().base_url();
        let target_ips: Vec<Ipv4Addr> = speaker_ips
            .iter()
            .filter_map(|ip| ip.parse().ok())
            .collect();
        let artwork_url = match self.network.prefer_address_reachable_from(&target_ips) {
            Some(_) => rebase_local_url(
                artwork_url,
                &old_base,
                &self.network.url_builder().base_url(),
            ),
            None => artwork_url.to_string(),
        };
        (
            self.network.url_builder().stream_url(stream_id),
            artwork_url,
        )
    }

    /// The UUID of the room leading `stream_id`'s running cast, if it has
    /// one: a speaker with a coordinator session for the stream.
    fn cast_coordinator_uuid(&self, stream_id: &str) -> Option<String> {
        self.sessions
            .all_sessions()
            .into_iter()
            .filter(|s| s.stream_id == stream_id && s.role == GroupRole::Coordinator)
            .find_map(|s| {
                s.coordinator_uuid
                    .or_else(|| self.sonos_state.get_member_uuid_by_ip(&s.speaker_ip))
            })
    }

    /// Sets where the household's grouping is read fresh before a regroup.
    pub fn set_topology_source(&mut self, topology: Arc<dyn crate::sonos::traits::SonosTopology>) {
        self.sync_group.set_topology_source(topology);
    }

    /// Sets where a room's own level is read as it joins a cast (see
    /// [`SyncGroupManager::set_volume_source`]).
    pub fn set_volume_source(&mut self, volume: Arc<dyn crate::sonos::traits::SonosVolumeControl>) {
        self.sync_group.set_volume_source(volume);
    }

    /// Plays a stream on exactly the rooms named, as one Sonos group (see
    /// [`super::regroup`] for how the group is chosen).
    ///
    /// Under the regroup lock, with the grouping read fresh:
    ///
    /// 1. The coordinator leaves a group of other rooms if it is in one, its
    ///    start level and those of the chosen rooms already in its group are
    ///    set, and it is given the stream. If that fails, nothing else has
    ///    been touched and every room is reported as failed.
    /// 2. Every other room, in parallel: it leaves its group if it is in
    ///    one, its start level is set, and it joins the coordinator. A room
    ///    that fails is reported on its own; the rest play on.
    ///
    /// No group volume is ever set and no satellite is ever named. Each room
    /// that left a group of other rooms records that group on its session.
    /// Results come back one per room, keyed by the room's own IP, the
    /// coordinator first.
    pub(crate) async fn start_rooms(
        &self,
        request: RoomsRequest<'_>,
        start_levels: Option<StartLevels<'_>>,
    ) -> Vec<PlaybackResult> {
        let RoomsRequest {
            stream_id,
            rooms,
            room_ips,
            metadata,
            artwork_url,
        } = request;
        let named = |uuid: &str| {
            rooms
                .iter()
                .position(|r| r == uuid)
                .and_then(|i| room_ips.get(i).cloned())
                .unwrap_or_else(|| uuid.to_string())
        };
        if rooms.is_empty() {
            return vec![];
        }
        let Some(stream_state) = self.get_stream(stream_id) else {
            log::warn!(
                "[Regroup] Stream {} not found, refusing playback on {} room(s)",
                stream_id,
                rooms.len()
            );
            return rooms
                .iter()
                .map(|uuid| failed(&named(uuid), format!("Stream not found: {stream_id}")))
                .collect();
        };
        let codec = stream_state.codec;
        let audio_format = stream_state.audio_format;

        let _regroup = self.sync_group.lock_regroup().await;
        // A Stop that held the lock ahead of this start has ended the stream.
        if self.get_stream(stream_id).is_none() {
            log::warn!("[Regroup] Stream {stream_id} ended before its rooms could be cast");
            return rooms
                .iter()
                .map(|uuid| failed(&named(uuid), format!("Stream not found: {stream_id}")))
                .collect();
        }
        // A running cast led by a room this one takes plays on in its other
        // rooms; the grouping below is read once it has been handed on.
        self.sync_group.hand_on_taken(stream_id, room_ips).await;
        // A plan made from a stale cache could tell a room that now leads
        // others to join, so with no fresh grouping nothing moves.
        let groups = match self.sync_group.read_groups(room_ips).await {
            Ok(groups) => groups,
            Err(unread) => {
                log::warn!("[Regroup] No speaker reported the grouping; not casting {stream_id}");
                let error = match unread {
                    GroupsUnread::UpnpDisabled => SPEAKERS_UPNP_DISABLED,
                    GroupsUnread::NoAnswer => "Could not read the Sonos grouping",
                };
                return rooms
                    .iter()
                    .map(|uuid| failed(&named(uuid), error))
                    .collect();
            }
        };
        let cast = self.cast_coordinator_uuid(stream_id);
        // A running cast whose coordinator no longer leads a group has been
        // regrouped by someone else: nothing joins it, and no second
        // coordinator is made for the stream.
        if let Some(uuid) = cast.as_deref() {
            if !groups.iter().any(|g| g.coordinator_uuid == uuid) {
                log::warn!("[Regroup] The coordinator of stream {stream_id} leads no group");
                return rooms
                    .iter()
                    .map(|uuid| failed(&named(uuid), "The cast's group has changed"))
                    .collect();
            }
        }
        let plan = match plan_regroup(rooms, &groups, cast.as_deref()) {
            Ok(plan) => plan,
            Err(e) => {
                log::warn!("[Regroup] No room to play for stream {stream_id}: {e:?}");
                return rooms
                    .iter()
                    .map(|uuid| failed(&named(uuid), "Room not found"))
                    .collect();
            }
        };
        log::info!(
            "[Regroup] Stream {}: coordinator {} (leaves its group: {}), stay {:?}, join {:?}",
            stream_id,
            plan.coordinator.ip,
            plan.coordinator_leaves,
            plan.stay.iter().map(|r| &r.ip).collect::<Vec<_>>(),
            plan.join.iter().map(|j| &j.room.ip).collect::<Vec<_>>()
        );

        let plan_rooms: Vec<&RoomRef> = std::iter::once(&plan.coordinator)
            .chain(plan.stay.iter())
            .chain(plan.join.iter().map(|j| &j.room))
            .collect();
        let all_ips: Vec<String> = plan_rooms.iter().map(|r| r.ip.clone()).collect();
        let (stream_url, artwork_url) = self.speaker_urls(stream_id, &all_ips, artwork_url);
        // Each room's old group, decided once before any call: a room taken
        // over from another stream records nothing, since that group was
        // another cast's (and a later failure must not put it back there).
        let snapshots: HashMap<String, OldGroup> = plan_rooms
            .iter()
            .filter(|room| {
                self.sessions
                    .find_other_stream(&room.ip, stream_id)
                    .is_none()
            })
            .filter_map(|room| {
                plan.snapshots
                    .get(&room.uuid)
                    .map(|old| (room.uuid.clone(), old.clone()))
            })
            .collect();
        let snapshot = |room: &RoomRef| snapshots.get(&room.uuid).cloned();
        let starting = |room: &RoomRef| self.sessions.get(stream_id, &room.ip).is_none();
        let coordinator = plan.coordinator.clone();

        // The rooms already in the coordinator's group play the moment it
        // does, so their levels go in with its own: after it leaves any
        // group and before it is given the stream.
        let stay_levels: Vec<(String, String)> = plan
            .stay
            .iter()
            .filter(|room| starting(room))
            .map(|room| (room.uuid.clone(), room.ip.clone()))
            .collect();

        let mut first: Vec<PlaybackResult> = Vec::new();
        if plan.coordinator_chosen {
            // A resume sets no level on the coordinator and returns before
            // any level is set, so its group's new rooms get theirs here.
            let resume = !starting(&coordinator);
            let level_rooms = if resume {
                if let Some(levels) = start_levels {
                    levels.apply(&stay_levels).await;
                }
                Vec::new()
            } else {
                std::iter::once((coordinator.uuid.clone(), coordinator.ip.clone()))
                    .chain(stay_levels)
                    .collect()
            };
            let outcome = self
                .start_single(SinglePlaybackParams {
                    speaker_ip: &coordinator.ip,
                    stream_id,
                    stream_url: &stream_url,
                    codec,
                    audio_format: &audio_format,
                    artwork_url: &artwork_url,
                    metadata,
                    leave_first: plan.coordinator_leaves,
                    start_levels,
                    level_rooms,
                    old_group: snapshot(&coordinator),
                })
                .await;
            let started = outcome.result.success;
            let left_group = outcome.left_group;
            first.push(outcome.result);
            if !started {
                log::warn!(
                    "[Regroup] Coordinator {} failed to start; no other room touched",
                    coordinator.ip
                );
                if let (true, Some(old)) = (left_group, snapshot(&coordinator)) {
                    self.sync_group
                        .put_back_after_failed_start(
                            &[(coordinator.ip.clone(), old)],
                            &HashSet::new(),
                        )
                        .await;
                }
                let why = if resume {
                    "Coordinator failed to resume"
                } else {
                    "Coordinator failed to start"
                };
                let others = plan
                    .stay
                    .iter()
                    .chain(plan.join.iter().map(|j| &j.room))
                    .map(|room| failed(&room.ip, why));
                first.extend(others);
                first.extend(
                    plan.unknown
                        .iter()
                        .map(|uuid| failed(&named(uuid), "Room not found")),
                );
                return first;
            }
        } else if let Some(levels) = start_levels {
            levels.apply(&stay_levels).await;
        }

        let mut by_room: Vec<(String, PlaybackResult)> = Vec::new();
        for room in &plan.stay {
            let result = self.sync_group.adopt_room(
                &room.ip,
                &coordinator.ip,
                &coordinator.uuid,
                stream_id,
                codec,
                snapshot(room),
            );
            by_room.push((room.uuid.clone(), result));
        }

        // A room this cast already plays in that is no longer in its group
        // was regrouped by someone else (a resume names every room of the
        // cast): it is not pulled back, and its session ends.
        let (gone, joining): (Vec<_>, Vec<_>) =
            plan.join.iter().partition(|join| !starting(&join.room));
        for join in gone {
            self.sync_group
                .drop_regrouped_room(stream_id, &join.room.ip)
                .await;
            by_room.push((
                join.room.uuid.clone(),
                failed(&join.room.ip, "Regrouped outside the cast"),
            ));
        }

        let joins = joining.iter().map(|join| {
            self.sync_group.join_room(JoinRoomRequest {
                room_uuid: &join.room.uuid,
                room_ip: &join.room.ip,
                coordinator_ip: &coordinator.ip,
                coordinator_uuid: &coordinator.uuid,
                stream_id,
                codec,
                leave_first: join.leave_first,
                start_levels: start_levels.filter(|_| starting(&join.room)),
                old_group: snapshot(&join.room),
            })
        });
        let outcomes = futures::future::join_all(joins).await;
        let mut stranded: Vec<(String, OldGroup)> = Vec::new();
        let mut cast_rooms: HashSet<String> = HashSet::new();
        cast_rooms.insert(coordinator.uuid.clone());
        for (join, outcome) in joining.iter().zip(outcomes) {
            if outcome.result.success {
                cast_rooms.insert(join.room.uuid.clone());
            } else if outcome.left_group {
                log::warn!(
                    "[Regroup] {} left its group but could not join the cast; putting it back",
                    join.room.ip
                );
                if let Some(old) = snapshot(&join.room) {
                    stranded.push((join.room.ip.clone(), old));
                }
            }
            by_room.push((join.room.uuid.clone(), outcome.result));
        }
        cast_rooms.extend(plan.stay.iter().map(|room| room.uuid.clone()));
        self.sync_group
            .put_back_after_failed_start(&stranded, &cast_rooms)
            .await;
        for uuid in &plan.unknown {
            by_room.push((uuid.clone(), failed(&named(uuid), "Room not found")));
        }
        let position = |uuid: &str| rooms.iter().position(|r| r == uuid).unwrap_or(usize::MAX);
        by_room.sort_by_key(|(uuid, _)| position(uuid));

        let joined = by_room.iter().any(|(_, result)| result.success);
        // Every room of a cast played as one Sonos group has its own level
        // followed and read as it enters, the coordinator's too: a cast to one
        // room included. A room that left its group to play alone has no
        // level of its own on record, and one standing alone whose first
        // event was lost has none either; nothing else would ever send one.
        if joined || plan.coordinator_chosen {
            self.sync_group.enter_stream_sync_session(stream_id).await;
        }
        if joined || plan.coordinator_leaves {
            self.sync_group.schedule_topology_refresh();
        }

        first.extend(by_room.into_iter().map(|(_, result)| result));
        first
    }

    /// Starts playback of a stream on multiple Sonos speakers.
    ///
    /// When `sync_speakers` is true and multiple speakers are selected (an
    /// older client), every room of the named speakers' Sonos groups is cast
    /// as one Sonos group, exactly as [`Self::start_rooms`] does.
    ///
    /// When `sync_speakers` is false, each speaker receives independent streams
    /// (may have slight audio drift between speakers).
    ///
    /// For single speakers, plays directly without grouping regardless of sync setting.
    ///
    /// Returns results for each speaker (best-effort: continues on individual failures).
    /// Each successful speaker gets a `StreamEvent::PlaybackStarted` event.
    ///
    /// # Arguments
    /// * `speaker_ips` - IP addresses of the Sonos speakers
    /// * `stream_id` - The stream ID to play
    /// * `metadata` - Optional initial metadata to display on Sonos
    /// * `artwork_url` - URL for album artwork in Sonos DIDL-Lite metadata
    /// * `sync_speakers` - Whether to synchronize multi-speaker playback
    pub async fn start_playback_multi(
        &self,
        speaker_ips: &[String],
        stream_id: &str,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
        sync_speakers: bool,
    ) -> Vec<PlaybackResult> {
        // Handle empty case
        if speaker_ips.is_empty() {
            return vec![];
        }

        // The codec and format decide the URI and metadata a speaker is given,
        // so a stream that no longer exists is refused, not guessed at.
        let Some(stream_state) = self.get_stream(stream_id) else {
            log::warn!(
                "[Playback] Stream {} not found, refusing playback on {} speaker(s)",
                stream_id,
                speaker_ips.len()
            );
            return speaker_ips
                .iter()
                .map(|speaker_ip| PlaybackResult {
                    speaker_ip: speaker_ip.clone(),
                    success: false,
                    stream_url: None,
                    error: Some(format!("Stream not found: {stream_id}")),
                })
                .collect();
        };
        let codec = stream_state.codec;
        let audio_format = stream_state.audio_format;

        let (stream_url, artwork_url) = self.speaker_urls(stream_id, speaker_ips, artwork_url);
        let artwork_url = artwork_url.as_str();

        // Single speaker: no grouping needed, use direct playback
        if speaker_ips.len() == 1 {
            let result = self
                .start_single_playback(SinglePlaybackParams::plain(
                    &speaker_ips[0],
                    stream_id,
                    &stream_url,
                    (codec, &audio_format),
                    artwork_url,
                    metadata,
                ))
                .await;
            return vec![result];
        }

        // Several speakers as one group: an older client names group
        // coordinators. Their groups' rooms are cast as one Sonos group, the
        // same way a cast that names its rooms is, so a coordinator that still
        // has members is never told to join, and the rooms are put back after.
        if sync_speakers {
            match self.legacy_rooms(speaker_ips) {
                Some(legacy) => {
                    log::info!(
                        "[Regroup] Synced start from an older client: {} speaker(s) as {} room(s)",
                        speaker_ips.len(),
                        legacy.rooms.len()
                    );
                    let results = self
                        .start_rooms(
                            RoomsRequest {
                                stream_id,
                                rooms: &legacy.rooms,
                                room_ips: &legacy.room_ips,
                                metadata,
                                artwork_url,
                            },
                            None,
                        )
                        .await;
                    // That client knows only the speakers it named: it hears
                    // of those alone, and the rest of each group goes with
                    // its speaker when that one is removed.
                    let extras: HashMap<String, Vec<String>> = legacy
                        .stands_for
                        .into_iter()
                        .filter(|(_, others)| !others.is_empty())
                        .collect();
                    if !extras.is_empty() {
                        self.legacy_extras
                            .lock()
                            .entry(stream_id.to_string())
                            .or_default()
                            .extend(extras);
                    }
                    return results
                        .into_iter()
                        .filter(|r| speaker_ips.contains(&r.speaker_ip))
                        .collect();
                }
                None => log::warn!(
                    "[GroupSync] Cannot find every speaker's room, using independent streams for {} speakers",
                    speaker_ips.len()
                ),
            }
        } else {
            log::info!(
                "[GroupSync] Sync disabled, using independent streams for {} speakers",
                speaker_ips.len()
            );
        }

        // Independent playback: each speaker gets its own stream
        let futures: Vec<_> = speaker_ips
            .iter()
            .map(|speaker_ip| {
                self.start_single_playback(SinglePlaybackParams::plain(
                    speaker_ip,
                    stream_id,
                    &stream_url,
                    (codec, &audio_format),
                    artwork_url,
                    metadata,
                ))
            })
            .collect();

        futures::future::join_all(futures).await
    }

    /// The rooms an older client's synced start means: every room of each
    /// named speaker's Sonos group (a named coordinator stands for its whole
    /// group, as it always played), as UUIDs with their IPs. `None` when a
    /// speaker is not in the topology.
    fn legacy_rooms(&self, speaker_ips: &[String]) -> Option<LegacyRooms> {
        let groups = self.sonos_state.groups.read().clone();
        let all = super::start_volume::rooms(&groups);
        let mut legacy = LegacyRooms::default();
        for speaker_ip in speaker_ips {
            let leads: Vec<_> = all
                .iter()
                .filter(|room| &room.coordinator_ip == speaker_ip)
                .collect();
            let named: Vec<_> = if leads.is_empty() {
                all.iter().filter(|room| &room.ip == speaker_ip).collect()
            } else {
                leads
            };
            if named.is_empty() {
                return None;
            }
            let mut others = Vec::new();
            for room in named {
                if !legacy.rooms.contains(&room.uuid) {
                    legacy.rooms.push(room.uuid.clone());
                    legacy.room_ips.push(room.ip.clone());
                    if &room.ip != speaker_ip && !speaker_ips.contains(&room.ip) {
                        others.push(room.ip.clone());
                    }
                }
            }
            legacy.stands_for.push((speaker_ip.clone(), others));
        }
        Some(legacy)
    }

    /// Starts playback on a single speaker.
    ///
    /// The whole sequence (detect an existing stream on this speaker, stop it,
    /// play the new one, record the session) runs under this speaker's start
    /// lock, which it shares with the sync-group slave path so a slave join and
    /// a coordinator start on the same speaker cannot interleave. Starts on
    /// *other* speakers are unaffected.
    async fn start_single_playback(&self, params: SinglePlaybackParams<'_>) -> PlaybackResult {
        self.start_single(params).await.result
    }

    /// [`Self::start_single_playback`], also saying whether the speaker left
    /// a Sonos group on the way.
    ///
    /// With `leave_first`, the speaker leaves its group before it is given
    /// the stream; if it cannot, nothing else is sent. Start levels are set
    /// after that and before the stream is given. A resume (the speaker
    /// already leads this stream) does neither.
    async fn start_single(&self, params: SinglePlaybackParams<'_>) -> SingleOutcome {
        let SinglePlaybackParams {
            speaker_ip,
            stream_id,
            stream_url,
            codec,
            audio_format,
            artwork_url,
            metadata,
            leave_first,
            start_levels,
            level_rooms,
            old_group,
        } = params;
        let outcome =
            |result: PlaybackResult, left_group: bool| SingleOutcome { result, left_group };

        // Held until this function returns, on every path.
        let _start = self
            .sessions
            .lock_speaker_start(stream_id, speaker_ip)
            .await;

        log::debug!(
            "[Playback] start_single_playback called: speaker={}, stream={}",
            speaker_ip,
            stream_id
        );

        let mut left_group = false;

        // Check if this exact (stream, speaker) pair already exists
        if let Some(existing) = self.sessions.get(stream_id, speaker_ip) {
            // If this is a Slave session, we need to reconfigure the transport.
            // A Slave's stream_url is x-rincon:... pointing to the coordinator.
            // To make this speaker an independent coordinator, we must:
            // 1. Detach from the current group
            // 2. Set the transport URI to the actual stream
            if existing.role == GroupRole::Slave {
                log::info!(
                    "[GroupSync] Promoting slave {} to coordinator for stream {} (was following {})",
                    speaker_ip,
                    stream_id,
                    existing.coordinator_ip.as_deref().unwrap_or("unknown")
                );

                // Best-effort leave_group - detach from coordinator
                match self.sonos.leave_group(speaker_ip).await {
                    Ok(()) => left_group = true,
                    Err(e) => log::warn!(
                        "[GroupSync] Failed to detach slave {} from group: {}",
                        speaker_ip,
                        e
                    ),
                }

                // Remove old slave session - coordinator session created below
                self.sessions.remove(stream_id, speaker_ip);

                // Fall through to play_uri setup below
            } else {
                // Coordinator session exists - check if Sonos is paused and needs a Play command.
                // This enables bi-directional control: user can resume from extension
                // after pausing from Sonos app.
                if let Err(e) = self.ensure_playing(speaker_ip).await {
                    log::warn!("Failed to resume playback on {}: {}", speaker_ip, e);
                    return outcome(
                        failed(speaker_ip, format!("Failed to resume: {}", e)),
                        false,
                    );
                }

                return outcome(
                    PlaybackResult {
                        speaker_ip: speaker_ip.to_string(),
                        success: true,
                        stream_url: Some(stream_url.to_string()),
                        error: None,
                    },
                    false,
                );
            }
        }

        // Check if this speaker is already playing a DIFFERENT stream.
        // If so, we must explicitly stop the old playback first to avoid race conditions.
        // Without an explicit stop, Sonos may not cleanly switch sources when receiving
        // a new SetAVTransportURI while still consuming an active HTTP stream.
        let existing_session = self
            .sessions
            .find_other_stream(speaker_ip, stream_id)
            .map(|(key, session)| (key, session.stream_id, session.role));

        if let Some((old_key, old_stream_id, old_role)) = existing_session {
            log::info!(
                "Speaker {} switching from stream {} to {} - stopping old playback first",
                speaker_ip,
                old_stream_id,
                stream_id
            );

            // Remove old session
            self.sessions
                .remove(&old_key.stream_id, &old_key.speaker_ip);

            if old_role == GroupRole::Slave {
                // A room following another cast's coordinator leaves its
                // group; that cast plays on in its other rooms. Its
                // transport is its group's, so a Stop is not ours to send.
                match self.sonos.leave_group(speaker_ip).await {
                    Ok(()) => left_group = true,
                    Err(e) => log::warn!("Failed to unjoin {} from its cast: {}", speaker_ip, e),
                }
            } else if let Err(e) = self.sonos.stop(speaker_ip).await {
                // Best-effort stop - ignore errors (speaker might already be stopped)
                log::warn!("Failed to stop old playback on {}: {}", speaker_ip, e);
            }

            // Emit PlaybackStopped for the old stream so the displaced client
            // cleans up — and can tell the user the speaker was taken over
            // rather than showing a generic "playback stopped".
            self.emit_event(StreamEvent::PlaybackStopped {
                stream_id: old_stream_id,
                speaker_ip: speaker_ip.to_string(),
                reason: Some(SpeakerRemovalReason::SpeakerTakenOver),
                timestamp: now_millis(),
            });
        }

        // A room that shares a Sonos group with rooms not in the cast leaves
        // it first; if it cannot, it is left as it was.
        if leave_first && !left_group {
            if let Err(e) = self.sonos.leave_group(speaker_ip).await {
                log::warn!(
                    "[Regroup] {} could not leave its Sonos group: {}",
                    speaker_ip,
                    e
                );
                return outcome(
                    failed(
                        speaker_ip,
                        format!("Could not leave its Sonos group: {}", e),
                    ),
                    false,
                );
            }
            left_group = true;
        }

        // The start level goes in before the speaker is given the stream.
        if let Some(levels) = start_levels {
            levels.apply(&level_rooms).await;
        }

        log::info!("Starting playback: {} -> {}", speaker_ip, stream_url);

        match self
            .sonos
            .play_uri(
                speaker_ip,
                stream_url,
                codec,
                audio_format,
                metadata,
                artwork_url,
            )
            .await
        {
            Ok(()) => {
                // Look up speaker's UUID for cleanup operations
                let coordinator_uuid = self.sonos_state.get_member_uuid_by_ip(speaker_ip);

                // Record the playback session
                self.sessions.insert(PlaybackSession {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    stream_url: stream_url.to_string(),
                    codec,
                    role: GroupRole::Coordinator,
                    coordinator_ip: None,
                    coordinator_uuid,
                    old_group,
                });

                // Broadcast playback started event
                self.emit_event(StreamEvent::PlaybackStarted {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    stream_url: stream_url.to_string(),
                    timestamp: now_millis(),
                });

                outcome(
                    PlaybackResult {
                        speaker_ip: speaker_ip.to_string(),
                        success: true,
                        stream_url: Some(stream_url.to_string()),
                        error: None,
                    },
                    left_group,
                )
            }
            Err(e) => {
                log::warn!("Failed to start playback on {}: {}", speaker_ip, e);
                let error = e
                    .user_reason()
                    .map_or_else(|| e.to_string(), str::to_string);
                outcome(failed(speaker_ip, error), left_group)
            }
        }
    }

    /// Starts playback of a stream on a single Sonos speaker.
    ///
    /// This is a convenience wrapper around `start_playback_multi` for single-speaker use.
    /// Maintains backward compatibility with existing code.
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the Sonos speaker
    /// * `stream_id` - The stream ID to play
    /// * `metadata` - Optional initial metadata to display on Sonos
    /// * `artwork_url` - URL for album artwork in Sonos DIDL-Lite metadata
    pub async fn start_playback(
        &self,
        speaker_ip: &str,
        stream_id: &str,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> ThaumicResult<()> {
        let results = self
            .start_playback_multi(
                &[speaker_ip.to_string()],
                stream_id,
                metadata,
                artwork_url,
                false,
            )
            .await;

        if let Some(result) = results.first() {
            if result.success {
                Ok(())
            } else {
                Err(crate::error::ThaumicError::Soap(
                    result
                        .error
                        .clone()
                        .unwrap_or_else(|| "Unknown error".to_string()),
                ))
            }
        } else {
            Err(crate::error::ThaumicError::Soap(
                "No playback result".to_string(),
            ))
        }
    }

    /// Stops playback on a specific speaker for a specific stream.
    ///
    /// On success: removes the session(s), broadcasts `StreamEvent::PlaybackStopped` for each,
    /// returns the list of stopped speaker IPs.
    /// On failure (stop command fails or session not found): keeps session intact (if any),
    /// broadcasts `StreamEvent::PlaybackStopFailed`, returns empty list.
    /// Used for partial speaker removal in multi-group scenarios.
    ///
    /// # Arguments
    /// * `stream_id` - The stream ID
    /// * `speaker_ip` - IP address of the speaker to stop
    /// * `reason` - Optional reason for stopping (propagated to events)
    ///
    /// # Returns
    /// List of speaker IPs that were stopped. When stopping a coordinator, this includes
    /// all slaves that were also stopped. Empty if stop failed or session not found.
    pub async fn stop_playback_speaker(
        &self,
        stream_id: &str,
        speaker_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> Vec<String> {
        // Guard: session must exist, otherwise emit failure so client can clear pending state
        if self.sessions.get(stream_id, speaker_ip).is_none() {
            log::warn!(
                "Stop requested for unknown session: stream={}, speaker={}",
                stream_id,
                speaker_ip
            );
            self.emit_event(StreamEvent::PlaybackStopFailed {
                stream_id: stream_id.to_string(),
                speaker_ip: speaker_ip.to_string(),
                error: "Session not found".to_string(),
                reason,
                timestamp: now_millis(),
            });
            return Vec::new();
        }

        // An older client's speaker takes the rest of its group with it.
        let extras = self
            .legacy_extras
            .lock()
            .get_mut(stream_id)
            .and_then(|named| named.remove(speaker_ip))
            .unwrap_or_default();
        for extra in extras {
            let Some(session) = self.sessions.get(stream_id, &extra) else {
                continue;
            };
            let follows_it = session.role == GroupRole::Slave
                && session.coordinator_ip.as_deref() == Some(speaker_ip)
                && session.old_group.as_ref().is_some_and(|g| g.kept);
            if follows_it {
                // Grouped with it before the cast: it stops with it, and
                // stays in its group.
                self.sync_group
                    .teardown_speaker(stream_id, &extra, reason)
                    .await;
            } else {
                self.sync_group
                    .stop_speaker_for_stream(stream_id, &extra, reason)
                    .await;
            }
        }

        let stopped = self
            .sync_group
            .stop_speaker_for_stream(stream_id, speaker_ip, reason)
            .await;
        self.forget_legacy_if_ended(stream_id);
        stopped
    }

    /// Drops what an older client's cast recorded once its stream has ended.
    fn forget_legacy_if_ended(&self, stream_id: &str) {
        if self.get_stream(stream_id).is_none() {
            self.legacy_extras.lock().remove(stream_id);
        }
    }

    /// Speaker addresses entitled to fetch `stream_id` over HTTP right now.
    ///
    /// See [`PlaybackSessionStore::allowed_reader_ips`]: live sessions in any
    /// role plus speakers whose start is still in flight.
    pub fn allowed_reader_ips(&self, stream_id: &str) -> Vec<String> {
        self.sessions.allowed_reader_ips(stream_id)
    }

    /// Gets all active playback sessions.
    pub fn get_all_sessions(&self) -> Vec<PlaybackSession> {
        self.sessions.all_sessions()
    }

    /// Stops all playback and clears all streams.
    ///
    /// This performs a complete cleanup by calling `remove_stream_async()` for
    /// each active stream, which stops speakers and broadcasts ended events.
    ///
    /// Returns the number of streams that were cleared.
    pub async fn clear_all(&self) -> usize {
        let stream_ids = self.stream_registry.list_stream_ids();
        let count = stream_ids.len();

        // Stopping and putting rooms back is best effort at shutdown: every
        // stream goes in one pass, and the speaker calls get a few seconds
        // in all, counted from when the regroup lock is held.
        self.remove_streams(&stream_ids, Some(CLEAR_ALL_BUDGET))
            .await;

        log::info!(
            "[StreamCoordinator] Cleared all: {} stream(s) removed",
            count
        );

        count
    }

    /// Returns the number of active streams.
    #[must_use]
    pub fn stream_count(&self) -> usize {
        self.stream_registry.stream_count()
    }

    /// Returns a reference to the stream registry.
    ///
    /// Used by services that need access to stream timing information
    /// (e.g., SpeakerMonitor).
    #[must_use]
    pub fn stream_registry(&self) -> Arc<StreamRegistry> {
        Arc::clone(&self.stream_registry)
    }

    /// Records that `speaker_ip` reported STOPPED with the PCM playout of the
    /// stream it plays: a playout parked between segments is kept at least
    /// [`crate::stream::playout::PARK_MAX`] from then, since a speaker may
    /// still fetch the next segment or be told to.
    pub fn note_speaker_stopped(&self, speaker_ip: &str) {
        let Ok(ip) = speaker_ip.parse::<std::net::IpAddr>() else {
            return;
        };
        let Some(session) = self.sessions.get_by_speaker_ip(speaker_ip) else {
            return;
        };
        if let Some(stream) = self.get_stream(&session.stream_id) {
            stream.playout.note_stopped(ip);
        }
    }

    /// Handles a source change event for a speaker.
    ///
    /// When a speaker switches to another source (Spotify, AirPlay, etc.),
    /// this ends its playback session and emits `PlaybackStopped`. When it
    /// led a cast's group, the rooms following it play the new source too,
    /// so their sessions end the same way. If no speaker is left on the
    /// stream, the stream is also ended.
    ///
    /// Unlike `stop_playback_speaker`, this sends no SOAP command and puts
    /// nothing back: the household has taken the rooms.
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the speaker that changed source
    ///
    /// # Returns
    /// `true` if a session was found and removed, `false` otherwise.
    pub fn handle_source_changed(&self, speaker_ip: &str) -> bool {
        match self.sync_group.end_after_source_change(speaker_ip) {
            Some(stream_id) => {
                self.forget_legacy_if_ended(&stream_id);
                true
            }
            None => {
                log::debug!(
                    "Source changed on {} but no active playback session found",
                    speaker_ip
                );
                false
            }
        }
    }

    /// Handles HTTP resume event from a speaker.
    ///
    /// Called by the HTTP layer when a speaker reconnects to an existing stream.
    /// This is the only place that sends Play commands on HTTP resume, maintaining
    /// separation of concerns (HTTP layer serves audio, coordinator controls playback).
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the speaker that resumed HTTP connection
    ///
    /// # Returns
    /// `true` if a Play command was sent, `false` otherwise.
    pub async fn on_http_resume(&self, speaker_ip: &str) -> bool {
        match self.ensure_playing(speaker_ip).await {
            Ok(sent_play) => sent_play,
            Err(e) => {
                log::warn!(
                    "[Resume] Play command on HTTP resume failed for {}: {}",
                    speaker_ip,
                    e
                );
                true // Play was attempted even though it failed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────
    // x-rincon URI Handling Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn x_rincon_uri_detection() {
        assert!("x-rincon:RINCON_XXX".starts_with("x-rincon:"));
        assert!("x-rincon:RINCON_542A1BD0029202400".starts_with("x-rincon:"));
        assert!(!"http://server:8080/stream".starts_with("x-rincon:"));
        assert!(!"x-rincon-mp3radio://server:8080/stream".starts_with("x-rincon:"));
        assert!(!"x-rincon-queue:RINCON_XXX#0".starts_with("x-rincon:"));
    }

    #[test]
    fn x_rincon_uri_not_transformed_for_pcm() {
        // This tests the fix for the bug where x-rincon URIs were incorrectly
        // transformed by build_sonos_stream_uri for PCM/FLAC codecs
        let rincon_uri = "x-rincon:RINCON_542A1BD0029202400";

        // The x-rincon URI should NOT be passed to build_sonos_stream_uri
        // because it would produce incorrect results like "x-rincon:RINCON_XXX.wav"
        // Instead, get_expected_stream should return it unchanged

        // Simulate the correct logic from get_expected_stream
        let result = if rincon_uri.starts_with("x-rincon:") {
            rincon_uri.to_string()
        } else {
            build_sonos_stream_uri(rincon_uri, AudioCodec::Pcm)
        };

        assert_eq!(result, "x-rincon:RINCON_542A1BD0029202400");
        assert!(!result.ends_with(".wav")); // Should NOT have .wav extension
    }

    #[test]
    fn a_local_artwork_url_follows_the_advertised_address() {
        assert_eq!(
            rebase_local_url(
                "http://100.96.0.12:8080/artwork.jpg",
                "http://100.96.0.12:8080",
                "http://192.168.2.50:8080"
            ),
            "http://192.168.2.50:8080/artwork.jpg"
        );
        // A hosted image is not ours to move, and a longer port that merely
        // starts with the old one is a different server.
        assert_eq!(
            rebase_local_url(
                "https://example.com/art.jpg",
                "http://100.96.0.12:8080",
                "http://192.168.2.50:8080"
            ),
            "https://example.com/art.jpg"
        );
        assert_eq!(
            rebase_local_url(
                "http://100.96.0.12:80801/artwork.jpg",
                "http://100.96.0.12:8080",
                "http://192.168.2.50:8080"
            ),
            "http://100.96.0.12:80801/artwork.jpg"
        );
    }

    #[test]
    fn regular_stream_url_transformed_for_pcm() {
        let stream_url = "http://192.168.1.50:8080/stream/abc123";

        let result = if stream_url.starts_with("x-rincon:") {
            stream_url.to_string()
        } else {
            build_sonos_stream_uri(stream_url, AudioCodec::Pcm)
        };

        assert!(result.ends_with(".wav"));
        assert_eq!(result, "http://192.168.1.50:8080/stream/abc123.wav");
    }

    #[test]
    fn regular_stream_url_transformed_for_aac() {
        let stream_url = "http://192.168.1.50:8080/stream/abc123";

        let result = if stream_url.starts_with("x-rincon:") {
            stream_url.to_string()
        } else {
            build_sonos_stream_uri(stream_url, AudioCodec::Aac)
        };

        assert!(result.starts_with("x-rincon-mp3radio://"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Coordinator Promotion Tests
    // ─────────────────────────────────────────────────────────────────────────

    mod coordinator_promotion {
        use super::*;
        use crate::context::NetworkContext;
        use crate::error::SoapResult;
        use crate::events::{EventEmitter, NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};
        use crate::sonos::gena::GenaSubscriptionManager;
        use crate::sonos::subscription_arbiter::SubscriptionArbiter;
        use crate::sonos::traits::SonosPlayback;
        use crate::sonos::types::{PositionInfo, ZoneGroup, ZoneGroupMember};
        use crate::state::{SonosState, StreamingConfig};
        use crate::stream::{AudioCodec, AudioFormat};
        use async_trait::async_trait;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        /// Event emitter that collects events for assertion.
        struct CollectingEventEmitter {
            events: Mutex<Vec<StreamEvent>>,
        }

        impl CollectingEventEmitter {
            fn new() -> Self {
                Self {
                    events: Mutex::new(Vec::new()),
                }
            }

            fn playback_stopped_ips(&self) -> Vec<String> {
                self.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|e| match e {
                        StreamEvent::PlaybackStopped { speaker_ip, .. } => Some(speaker_ip.clone()),
                        _ => None,
                    })
                    .collect()
            }

            /// (stream_id, reason) for every PlaybackStopped seen, in order.
            fn playback_stopped_reasons(
                &self,
            ) -> Vec<(String, Option<crate::events::SpeakerRemovalReason>)> {
                self.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|e| match e {
                        StreamEvent::PlaybackStopped {
                            stream_id, reason, ..
                        } => Some((stream_id.clone(), *reason)),
                        _ => None,
                    })
                    .collect()
            }
        }

        impl EventEmitter for CollectingEventEmitter {
            fn emit_stream(&self, event: StreamEvent) {
                self.events.lock().unwrap().push(event);
            }
            fn emit_sonos(&self, _: SonosEvent) {}
            fn emit_latency(&self, _: crate::events::LatencyEvent) {}
            fn emit_network(&self, _: NetworkEvent) {}
            fn emit_topology(&self, _: TopologyEvent) {}
        }

        /// Mock SonosPlayback that tracks call counts per method.
        struct TrackingSonosPlayback {
            play_uri_count: AtomicUsize,
            stop_count: AtomicUsize,
            leave_group_count: AtomicUsize,
            join_group_count: AtomicUsize,
            switch_to_queue_count: AtomicUsize,
            /// If set, play_uri returns this error.
            play_uri_fail: Mutex<Option<String>>,
            /// Yields inserted inside stop/play_uri so concurrent starts on one
            /// speaker actually interleave in a single-threaded test runtime.
            yields_per_call: AtomicUsize,
        }

        impl TrackingSonosPlayback {
            fn new() -> Self {
                Self {
                    play_uri_count: AtomicUsize::new(0),
                    stop_count: AtomicUsize::new(0),
                    leave_group_count: AtomicUsize::new(0),
                    join_group_count: AtomicUsize::new(0),
                    switch_to_queue_count: AtomicUsize::new(0),
                    play_uri_fail: Mutex::new(None),
                    yields_per_call: AtomicUsize::new(0),
                }
            }

            fn with_play_uri_fail(self, msg: &str) -> Self {
                *self.play_uri_fail.lock().unwrap() = Some(msg.to_string());
                self
            }

            fn with_yields(self, n: usize) -> Self {
                self.yields_per_call.store(n, Ordering::SeqCst);
                self
            }

            async fn interleave(&self) {
                for _ in 0..self.yields_per_call.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            }
        }

        #[async_trait]
        impl SonosPlayback for TrackingSonosPlayback {
            async fn play_uri(
                &self,
                _: &str,
                _: &str,
                _: AudioCodec,
                _: &AudioFormat,
                _: Option<&StreamMetadata>,
                _: &str,
            ) -> SoapResult<()> {
                self.play_uri_count.fetch_add(1, Ordering::SeqCst);
                self.interleave().await;
                if let Some(msg) = self.play_uri_fail.lock().unwrap().as_ref() {
                    return Err(crate::sonos::soap::SoapError::Fault {
                        code: None,
                        message: msg.clone(),
                    });
                }
                Ok(())
            }
            async fn set_next_uri(
                &self,
                _: &str,
                _: &crate::sonos::traits::NextItem<'_>,
            ) -> SoapResult<()> {
                Ok(())
            }
            async fn play(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn stop(&self, _: &str) -> SoapResult<()> {
                self.stop_count.fetch_add(1, Ordering::SeqCst);
                self.interleave().await;
                Ok(())
            }
            async fn switch_to_queue(&self, _: &str, _: &str) -> SoapResult<()> {
                self.switch_to_queue_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            async fn get_position_info(&self, _: &str) -> SoapResult<PositionInfo> {
                Ok(PositionInfo {
                    track_uri: String::new(),
                    rel_time_ms: 0,
                })
            }
            async fn get_transport_info(&self, _: &str) -> SoapResult<TransportState> {
                Ok(TransportState::Playing)
            }
            async fn join_group(&self, _: &str, _: &str) -> SoapResult<()> {
                self.join_group_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            async fn leave_group(&self, _: &str) -> SoapResult<()> {
                self.leave_group_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }

            async fn rejoin_group(&self, _: &str, _: &str) -> SoapResult<()> {
                Ok(())
            }
        }

        /// Creates a SonosState with members for UUID lookup.
        fn create_sonos_state_with_members(members: &[(&str, &str)]) -> Arc<SonosState> {
            let state = Arc::new(SonosState::default());
            let groups = members
                .iter()
                .map(|(ip, uuid)| ZoneGroup {
                    id: uuid.to_string(),
                    name: format!("Room {}", ip),
                    coordinator_uuid: uuid.to_string(),
                    coordinator_ip: ip.to_string(),
                    members: vec![ZoneGroupMember {
                        uuid: uuid.to_string(),
                        ip: ip.to_string(),
                        zone_name: format!("Room {}", ip),
                        model: "One".to_string(),
                        invisible: false,
                    }],
                })
                .collect();
            *state.groups.write() = groups;
            state
        }

        /// Creates a StreamCoordinator with custom sonos mock and event emitter.
        ///
        /// Uses a 1ms timeout so GENA subscribe attempts against nonexistent
        /// speakers fail immediately instead of blocking on TCP SYN retries (~30s).
        fn create_coordinator_with(
            sonos: Arc<dyn SonosPlayback>,
            sonos_state: Arc<SonosState>,
            emitter: Arc<dyn EventEmitter>,
        ) -> StreamCoordinator {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(1))
                .build()
                .unwrap();
            let (gena_manager, _rx) = GenaSubscriptionManager::new(client);
            let arbiter = Arc::new(SubscriptionArbiter::new(Arc::new(gena_manager)));
            StreamCoordinator::new(
                sonos,
                sonos_state,
                NetworkContext::for_test(),
                emitter,
                StreamingConfig::default(),
                arbiter,
            )
        }

        #[tokio::test]
        async fn promote_slave_when_coordinator_removed_with_slaves() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = create_sonos_state_with_members(&[
                ("192.168.1.100", "RINCON_COORD"),
                ("192.168.1.101", "RINCON_SLAVE1"),
                ("192.168.1.102", "RINCON_SLAVE2"),
            ]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            // Create stream so get_stream() works
            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            // Set up sessions with matching stream_id
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.102".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });

            // Remove the coordinator
            let stopped = coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            // Only the old coordinator should be "stopped"
            assert_eq!(stopped, vec!["192.168.1.100"]);

            // Only one PlaybackStopped event (for the old coordinator)
            // (plus the StreamEvent::Created from create_stream)
            assert_eq!(emitter.playback_stopped_ips(), vec!["192.168.1.100"]);

            // One slave should be promoted to coordinator (DashMap order is nondeterministic)
            let sessions = coord.get_all_sessions();
            let promoted = sessions
                .iter()
                .find(|s| s.role == GroupRole::Coordinator)
                .expect("one session should be promoted to coordinator");
            assert!(promoted.coordinator_ip.is_none());
            assert!(!promoted.stream_url.starts_with("x-rincon:"));
            // Promoted speaker should have its own UUID as coordinator_uuid
            assert!(promoted.coordinator_uuid.is_some());

            // Remaining slave should be re-pointed to the promoted coordinator
            let remaining = sessions
                .iter()
                .find(|s| s.role == GroupRole::Slave)
                .expect("one session should remain as slave");
            assert_eq!(
                remaining.coordinator_ip.as_deref(),
                Some(promoted.speaker_ip.as_str())
            );
            assert_eq!(remaining.coordinator_uuid, promoted.coordinator_uuid);
            assert_eq!(
                remaining.stream_url,
                format!("x-rincon:{}", promoted.coordinator_uuid.as_ref().unwrap())
            );

            // Old coordinator session should be gone
            assert!(coord
                .get_all_sessions()
                .iter()
                .all(|s| s.speaker_ip != "192.168.1.100"));

            // Verify SOAP calls: stop(old), leave_group(promoted), play_uri(promoted),
            // leave_group(remaining), join_group(remaining)
            assert_eq!(sonos.stop_count.load(Ordering::SeqCst), 1);
            assert_eq!(sonos.play_uri_count.load(Ordering::SeqCst), 1);
            assert_eq!(sonos.leave_group_count.load(Ordering::SeqCst), 2);
            assert_eq!(sonos.join_group_count.load(Ordering::SeqCst), 1);
        }

        /// A segmented PCM cast is one session whichever segment the speaker
        /// is on, and a promotion hands the new coordinator the base URL, so
        /// it starts on segment 0 and its later segments match too.
        #[tokio::test]
        async fn a_promoted_pcm_coordinator_keeps_the_base_url_and_its_segments() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = create_sonos_state_with_members(&[
                ("192.168.1.100", "RINCON_COORD"),
                ("192.168.1.101", "RINCON_SLAVE1"),
                ("192.168.1.102", "RINCON_SLAVE2"),
            ]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );
            let stream_id = coord
                .create_stream(AudioCodec::Pcm, AudioFormat::default(), 200, 20)
                .unwrap();
            let base = format!("http://192.168.1.2:49400/stream/{stream_id}/live");
            let segment = |n| crate::stream::pcm_segment_uri(&base, n);

            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: base.clone(),
                codec: AudioCodec::Pcm,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });
            for ip in ["192.168.1.101", "192.168.1.102"] {
                coord.insert_test_session(PlaybackSession {
                    stream_id: stream_id.clone(),
                    speaker_ip: ip.to_string(),
                    stream_url: "x-rincon:RINCON_COORD".to_string(),
                    codec: AudioCodec::Pcm,
                    role: GroupRole::Slave,
                    coordinator_ip: Some("192.168.1.100".to_string()),
                    coordinator_uuid: Some("RINCON_COORD".to_string()),
                    old_group: None,
                });
            }

            // Before: the coordinator is expected on segment 0, and any later
            // segment of the same stream is still that source.
            let expected = coord.get_expected_stream("192.168.1.100").unwrap();
            assert_eq!(expected, segment(0));
            for n in [1, 2, 9] {
                assert!(crate::stream::same_stream(&segment(n), &expected));
            }

            coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            let sessions = coord.get_all_sessions();
            let promoted = sessions
                .iter()
                .find(|s| s.role == GroupRole::Coordinator)
                .expect("one session should be promoted to coordinator");
            // The base URL, never a segment's.
            assert_eq!(promoted.stream_url, base);

            let expected = coord.get_expected_stream(&promoted.speaker_ip).unwrap();
            assert_eq!(expected, segment(0));
            for n in [0, 1, 2, 9] {
                assert!(crate::stream::same_stream(&segment(n), &expected));
            }
            // Another stream, or the TV input, is still a source change.
            assert!(!crate::stream::same_stream(
                "http://192.168.1.2:49400/stream/other/live/1.wav",
                &expected
            ));
            assert!(!crate::stream::same_stream(
                "x-sonos-htastream:RINCON_SLAVE1:spdif",
                &expected
            ));

            // The remaining slave follows the promoted coordinator.
            let remaining = sessions
                .iter()
                .find(|s| s.role == GroupRole::Slave)
                .expect("one session should remain as slave");
            assert_eq!(
                coord.get_expected_stream(&remaining.speaker_ip),
                Some(format!(
                    "x-rincon:{}",
                    promoted.coordinator_uuid.as_ref().unwrap()
                ))
            );
        }

        #[tokio::test]
        async fn promote_with_single_slave_becomes_standalone() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = create_sonos_state_with_members(&[
                ("192.168.1.100", "RINCON_COORD"),
                ("192.168.1.101", "RINCON_SLAVE1"),
            ]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });

            let stopped = coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            assert_eq!(stopped, vec!["192.168.1.100"]);

            // Only 1 session remaining: the promoted slave
            let sessions = coord.get_all_sessions();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].speaker_ip, "192.168.1.101");
            assert_eq!(sessions[0].role, GroupRole::Coordinator);

            // No join_group calls since there are no remaining slaves to re-point
            assert_eq!(sonos.join_group_count.load(Ordering::SeqCst), 0);
        }

        #[tokio::test]
        async fn promotion_falls_back_to_teardown_on_play_uri_failure() {
            let sonos = Arc::new(TrackingSonosPlayback::new().with_play_uri_fail("SOAP fault"));
            let sonos_state = create_sonos_state_with_members(&[
                ("192.168.1.100", "RINCON_COORD"),
                ("192.168.1.101", "RINCON_SLAVE1"),
            ]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });

            let stopped = coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            // Fallback teardown: both speakers should be stopped
            assert!(stopped.contains(&"192.168.1.100".to_string()));
            assert!(stopped.contains(&"192.168.1.101".to_string()));

            // All sessions should be cleaned up
            assert!(coord.get_all_sessions().is_empty());
        }

        #[tokio::test]
        async fn no_promotion_when_coordinator_has_no_slaves() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = create_sonos_state_with_members(&[("192.168.1.100", "RINCON_COORD")]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            coord.insert_test_session(PlaybackSession {
                stream_id: "stream1".to_string(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });

            let stopped = coord
                .stop_playback_speaker("stream1", "192.168.1.100", None)
                .await;

            // Direct teardown, no promotion attempted
            assert_eq!(stopped, vec!["192.168.1.100"]);
            assert!(coord.get_all_sessions().is_empty());

            // No play_uri called (no promotion)
            assert_eq!(sonos.play_uri_count.load(Ordering::SeqCst), 0);
        }

        #[tokio::test]
        async fn promotion_falls_back_when_uuid_lookup_fails() {
            // SonosState has no members → UUID lookup fails → promotion fails → teardown
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = Arc::new(SonosState::default()); // Empty - no UUID lookups work
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                sonos_state,
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            coord.insert_test_session(PlaybackSession {
                stream_id: "stream1".to_string(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: "stream1".to_string(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                old_group: None,
            });

            let stopped = coord
                .stop_playback_speaker("stream1", "192.168.1.100", None)
                .await;

            // Fallback teardown: both should be stopped
            assert!(stopped.contains(&"192.168.1.100".to_string()));
            assert!(stopped.contains(&"192.168.1.101".to_string()));
            assert!(coord.get_all_sessions().is_empty());
        }

        #[tokio::test]
        async fn promoted_session_preserves_original_group_from_slave_session() {
            // Regression: promoted session must use the slave's stored
            // old group, NOT re-query the Sonos topology.
            // The topology reflects the *streaming* group (slave of Kitchen),
            // but the slave session correctly stored None (was standalone before).
            // Re-querying would return Kitchen's UUID, causing recombination on stop.

            let sonos = Arc::new(TrackingSonosPlayback::new());
            // Topology shows Office as slave of Kitchen (the streaming group)
            let sonos_state = Arc::new(SonosState::default());
            {
                let mut groups = sonos_state.groups.write();
                *groups = vec![ZoneGroup {
                    id: "streaming_group".to_string(),
                    name: "Kitchen".to_string(),
                    coordinator_uuid: "RINCON_KITCHEN".to_string(),
                    coordinator_ip: "192.168.1.100".to_string(),
                    members: vec![
                        ZoneGroupMember {
                            uuid: "RINCON_KITCHEN".to_string(),
                            ip: "192.168.1.100".to_string(),
                            zone_name: "Kitchen".to_string(),
                            model: "One".to_string(),
                            invisible: false,
                        },
                        ZoneGroupMember {
                            uuid: "RINCON_OFFICE".to_string(),
                            ip: "192.168.1.101".to_string(),
                            zone_name: "Office".to_string(),
                            model: "One".to_string(),
                            invisible: false,
                        },
                    ],
                }];
            }

            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            // Slave session has old_group: None (was standalone before streaming)
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_KITCHEN".to_string()),
                old_group: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_KITCHEN".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_KITCHEN".to_string()),
                // Key: Office was standalone before streaming, so no original group
                old_group: None,
            });

            // Remove Kitchen (coordinator) → Office promoted
            coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            // The promoted session must have old_group: None
            // (from the slave session), NOT Some("RINCON_KITCHEN") (from topology)
            let promoted = coord
                .get_all_sessions()
                .into_iter()
                .find(|s| s.speaker_ip == "192.168.1.101")
                .expect("promoted session should exist");
            assert_eq!(promoted.role, GroupRole::Coordinator);
            assert_eq!(
                promoted.old_group, None,
                "Promoted session should keep the slave's old group (None), \
                 not re-query topology which would return Kitchen's group"
            );
        }

        // ─────────────────────────────────────────────────────────────────
        // Speaker contention between clients
        // ─────────────────────────────────────────────────────────────────

        #[tokio::test]
        async fn concurrent_starts_on_one_speaker_leave_one_reachable_session() {
            // Two clients cast different tabs to the same speaker at the same
            // instant. Contention is allowed — both starts must be accepted —
            // but the store must not be left with a session that no lookup by
            // speaker IP can reach.
            let sonos = Arc::new(TrackingSonosPlayback::new().with_yields(4));
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                create_sonos_state_with_members(&[("192.168.1.100", "RINCON_A")]),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let stream_a = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();
            let stream_b = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            let (a, b) = tokio::join!(
                coord.start_playback("192.168.1.100", &stream_a, None, ""),
                coord.start_playback("192.168.1.100", &stream_b, None, ""),
            );
            assert!(a.is_ok(), "first client must not be rejected: {a:?}");
            assert!(b.is_ok(), "second client must not be rejected: {b:?}");

            let sessions = coord.get_all_sessions();
            assert_eq!(
                sessions.len(),
                1,
                "concurrent starts left an orphaned session: {sessions:?}"
            );

            let reachable = coord
                .sessions
                .get_by_speaker_ip("192.168.1.100")
                .expect("surviving session must be reachable by speaker IP");
            assert_eq!(reachable.stream_id, sessions[0].stream_id);
            assert!(reachable.stream_id == stream_a || reachable.stream_id == stream_b);
            assert_eq!(
                coord
                    .sessions
                    .get_key_by_speaker_ip("192.168.1.100")
                    .unwrap()
                    .stream_id,
                reachable.stream_id,
                "ip_index must agree with the primary map"
            );

            // Serialised, so the loser's playback was stopped exactly once
            // rather than both starts racing straight to play_uri.
            assert_eq!(sonos.play_uri_count.load(Ordering::SeqCst), 2);
            assert_eq!(sonos.stop_count.load(Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn takeover_reports_speaker_taken_over() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                create_sonos_state_with_members(&[("192.168.1.100", "RINCON_A")]),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let displaced = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();
            let taker = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            coord
                .start_playback("192.168.1.100", &displaced, None, "")
                .await
                .unwrap();
            coord
                .start_playback("192.168.1.100", &taker, None, "")
                .await
                .unwrap();

            // The displaced client learns *why* its cast ended.
            assert_eq!(
                emitter.playback_stopped_reasons(),
                vec![(
                    displaced.clone(),
                    Some(SpeakerRemovalReason::SpeakerTakenOver)
                )]
            );

            // ...and the second client keeps the speaker.
            assert_eq!(
                coord
                    .sessions
                    .get_by_speaker_ip("192.168.1.100")
                    .unwrap()
                    .stream_id,
                taker
            );
        }

        #[tokio::test]
        async fn playback_of_a_stream_that_does_not_exist_is_refused_per_speaker() {
            // The codec decides the URI a speaker is handed. With no stream to
            // read it from, nothing may be sent to a speaker on a guess.
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                create_sonos_state_with_members(&[
                    ("192.168.1.100", "RINCON_A"),
                    ("192.168.1.101", "RINCON_B"),
                ]),
                Arc::new(CollectingEventEmitter::new()) as Arc<dyn EventEmitter>,
            );

            for speakers in [
                vec!["192.168.1.100".to_string()],
                vec!["192.168.1.100".to_string(), "192.168.1.101".to_string()],
            ] {
                let results = coord
                    .start_playback_multi(&speakers, "no-such-stream", None, "", true)
                    .await;

                assert_eq!(results.len(), speakers.len());
                for (result, speaker) in results.iter().zip(&speakers) {
                    assert_eq!(&result.speaker_ip, speaker);
                    assert!(!result.success);
                    assert_eq!(result.stream_url, None);
                    assert_eq!(
                        result.error.as_deref(),
                        Some("Stream not found: no-such-stream")
                    );
                }
            }

            assert_eq!(sonos.play_uri_count.load(Ordering::SeqCst), 0);
            assert_eq!(sonos.stop_count.load(Ordering::SeqCst), 0);
            assert_eq!(sonos.join_group_count.load(Ordering::SeqCst), 0);
        }

        #[tokio::test]
        async fn slave_takeover_reports_speaker_taken_over() {
            // A second client casts a sync group whose *slave* happens to be
            // the speaker a first client is already using. The slave path takes
            // the speaker just like the coordinator path, so it has to say so.
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                create_sonos_state_with_members(&[
                    ("192.168.1.100", "RINCON_A"),
                    ("192.168.1.101", "RINCON_B"),
                ]),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let displaced = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();
            let group = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            coord
                .start_playback("192.168.1.100", &displaced, None, "")
                .await
                .unwrap();

            // .101 coordinates the group; .100 is pulled in as its slave.
            let results = coord
                .start_playback_multi(
                    &["192.168.1.101".to_string(), "192.168.1.100".to_string()],
                    &group,
                    None,
                    "",
                    true,
                )
                .await;
            assert!(
                results.iter().all(|r| r.success),
                "group start must not be rejected: {results:?}"
            );

            // The displaced client learns *why* its cast ended.
            assert_eq!(
                emitter.playback_stopped_reasons(),
                vec![(
                    displaced.clone(),
                    Some(SpeakerRemovalReason::SpeakerTakenOver)
                )]
            );

            let taken = coord
                .sessions
                .get_by_speaker_ip("192.168.1.100")
                .expect("taken speaker must be reachable by IP");
            assert_eq!(taken.stream_id, group);
            assert_eq!(taken.role, GroupRole::Slave);
        }

        #[tokio::test]
        async fn slave_join_and_coordinator_start_cannot_interleave_on_one_speaker() {
            // Kitchen (.100) is already carrying a third client's cast when two
            // more clients grab it at the same instant: one as a standalone
            // coordinator, one as the slave of a sync group. Contention is
            // allowed, but the two find/stop/play/insert sequences must not
            // interleave — if both read the store before either writes it, one
            // client's stop lands after the other's play and the second
            // takeover is never announced to the client that lost the speaker.
            let sonos = Arc::new(TrackingSonosPlayback::new().with_yields(4));
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                create_sonos_state_with_members(&[
                    ("192.168.1.100", "RINCON_A"),
                    ("192.168.1.101", "RINCON_B"),
                ]),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let incumbent = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();
            let solo = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();
            let group = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            coord
                .start_playback("192.168.1.100", &incumbent, None, "")
                .await
                .unwrap();

            let group_ips = ["192.168.1.101".to_string(), "192.168.1.100".to_string()];
            let (solo_result, group_results) = tokio::join!(
                coord.start_playback("192.168.1.100", &solo, None, ""),
                coord.start_playback_multi(&group_ips, &group, None, "", true),
            );
            assert!(solo_result.is_ok(), "solo client rejected: {solo_result:?}");
            assert!(
                group_results.iter().all(|r| r.success),
                "group client rejected: {group_results:?}"
            );

            // The contended speaker ends up on exactly one stream, reachable
            // by IP — no orphan behind it.
            let winner = coord
                .sessions
                .get_by_speaker_ip("192.168.1.100")
                .expect("contended speaker must be reachable by IP");
            let on_speaker: Vec<_> = coord
                .get_all_sessions()
                .into_iter()
                .filter(|s| s.speaker_ip == "192.168.1.100")
                .collect();
            assert_eq!(
                on_speaker.len(),
                1,
                "contended speaker left with more than one session: {on_speaker:?}"
            );
            assert_eq!(on_speaker[0].stream_id, winner.stream_id);

            // Every cast displaced from that speaker was announced exactly
            // once, with the takeover reason. Interleaved sequences lose one of
            // these announcements.
            let mut announced: Vec<String> = emitter
                .playback_stopped_reasons()
                .into_iter()
                .map(|(stream_id, reason)| {
                    assert_eq!(
                        reason,
                        Some(SpeakerRemovalReason::SpeakerTakenOver),
                        "displaced cast {stream_id} was not told it was taken over"
                    );
                    stream_id
                })
                .collect();
            let mut expected: Vec<String> = vec![incumbent, solo, group]
                .into_iter()
                .filter(|id| *id != winner.stream_id)
                .collect();
            announced.sort();
            expected.sort();
            assert_eq!(
                announced, expected,
                "each client displaced from the speaker must be told exactly once"
            );
        }

        // ─────────────────────────────────────────────────────────────────
        // Capture bridge: lost-frame backfill, silent packets, seam fade
        // ─────────────────────────────────────────────────────────────────

        /// Builds a PCM stream with a bridge attached and a subscriber on
        /// its broadcast channel.
        fn capture_bridge(
            jitter_buffer_ms: u64,
        ) -> (
            Arc<StreamSinkBridge>,
            tokio::sync::broadcast::Receiver<Bytes>,
        ) {
            let coord = Arc::new(create_coordinator_with(
                Arc::new(TrackingSonosPlayback::new()) as Arc<dyn SonosPlayback>,
                create_sonos_state_with_members(&[("192.168.1.100", "RINCON_A")]),
                Arc::new(CollectingEventEmitter::new()) as Arc<dyn EventEmitter>,
            ));
            let format = AudioFormat::new(48000, 2, 16);
            let stream_id = coord
                .create_stream(AudioCodec::Pcm, format, jitter_buffer_ms, 10)
                .unwrap();
            let (_, rx) = coord.get_stream(&stream_id).unwrap().subscribe();
            let bridge = Arc::new(StreamSinkBridge::new(
                stream_id,
                Arc::clone(&coord),
                Arc::new(Notify::new()),
                &format,
                jitter_buffer_ms,
            ));
            // Keep the coordinator alive for the bridge's lifetime.
            std::mem::forget(coord);
            (bridge, rx)
        }

        fn drain(rx: &mut tokio::sync::broadcast::Receiver<Bytes>) -> Vec<Bytes> {
            let mut out = Vec::new();
            while let Ok(frame) = rx.try_recv() {
                out.push(frame);
            }
            out
        }

        fn is_zero(frame: &Bytes) -> bool {
            frame.iter().all(|&b| b == 0)
        }

        /// 480-frame stereo packet at a constant level (0.5 → 0x3FFF).
        fn packet() -> Vec<f32> {
            vec![0.5f32; 480 * 2]
        }

        #[tokio::test]
        async fn capture_bridge_backfills_lost_frames_with_silence() {
            let (bridge, mut rx) = capture_bridge(200);

            bridge.push_audio(&packet(), 480, 2, BufferFlags::default());
            // 50ms of audio lost between packets → five 10ms silence frames
            bridge.push_audio(
                &packet(),
                480,
                2,
                BufferFlags {
                    discontinuity: true,
                    silent: false,
                    lost_frames: 2400,
                },
            );

            let frames = drain(&mut rx);
            assert_eq!(frames.len(), 7, "audio + 5 silence + audio");
            assert!(!is_zero(&frames[0]));
            let fade_out = &frames[1];
            assert_eq!(fade_out.len(), 1920);
            assert!(
                !is_zero(fade_out),
                "first backfill chunk fades out from the last sample"
            );
            assert_eq!(&fade_out[1918..], &[0, 0], "fade-out ends in silence");
            assert!(
                frames[2..6].iter().all(is_zero),
                "remaining backfill is silence"
            );
            let resumed = &frames[6];
            assert_eq!(resumed.len(), 1920);
            assert_ne!(&resumed[..2], &[0xFF, 0x3F], "first sample is faded in");
            assert_eq!(&resumed[1918..], &[0xFF, 0x3F], "last sample is untouched");
        }

        #[tokio::test]
        async fn capture_bridge_caps_backfill_at_one_jitter_buffer() {
            let (bridge, mut rx) = capture_bridge(200);

            bridge.push_audio(&packet(), 480, 2, BufferFlags::default());
            drain(&mut rx);
            // A whole second lost is backfilled with at most 200ms (20 packets)
            bridge.push_audio(
                &packet(),
                480,
                2,
                BufferFlags {
                    discontinuity: true,
                    silent: false,
                    lost_frames: 48_000,
                },
            );

            let frames = drain(&mut rx);
            assert_eq!(frames.len(), 21, "20 silence frames + audio");
            let ends_silent = |f: &Bytes| f[f.len() - 2..] == [0, 0];
            assert_eq!(frames.iter().filter(|f| ends_silent(f)).count(), 20);
        }

        #[tokio::test]
        async fn capture_bridge_carries_sub_packet_losses_forward() {
            let (bridge, mut rx) = capture_bridge(200);
            let lost = |n: u32| BufferFlags {
                discontinuity: true,
                silent: false,
                lost_frames: n,
            };

            bridge.push_audio(&packet(), 480, 2, BufferFlags::default());
            // 300 lost frames: under one packet, nothing yet
            bridge.push_audio(&packet(), 480, 2, lost(300));
            assert_eq!(drain(&mut rx).len(), 2, "no backfill below one packet");
            // Another 300: 600 total → one packet backfilled, 120 carried
            bridge.push_audio(&packet(), 480, 2, lost(300));
            let frames = drain(&mut rx);
            assert_eq!(frames.len(), 2, "one backfill packet + audio");
            assert_eq!(&frames[0][1918..], &[0, 0]);
        }

        #[tokio::test]
        async fn capture_bridge_zero_fills_silent_packets() {
            let (bridge, mut rx) = capture_bridge(200);

            bridge.push_audio(
                &packet(),
                480,
                2,
                BufferFlags {
                    discontinuity: false,
                    silent: true,
                    lost_frames: 0,
                },
            );

            let frames = drain(&mut rx);
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].len(), 1920);
            assert!(is_zero(&frames[0]), "silent flag overrides buffer contents");
        }
    }
}
