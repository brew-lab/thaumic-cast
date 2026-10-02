//! Audio streaming handler.
//!
//! Separated from REST handlers due to its distinct concerns:
//! codec-specific pipeline construction, prefill delays, epoch
//! tracking, ICY metadata injection, and WAV header generation.
//!
//! Runtime context: In the desktop app, this handler (and its cadence metronome)
//! runs on the dedicated `StreamingRuntime` high-priority threads — inherited
//! via `streaming_runtime.spawn()` in the Tauri API layer.

use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::{connect_info::ConnectInfo, Path, State},
    http::{header, HeaderMap, Version},
    response::Response,
};
use bytes::Bytes;
use futures::stream::{Stream, StreamExt};
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;

use crate::api::ws::is_companion_host;
use crate::api::AppState;
use crate::error::{ThaumicError, ThaumicResult};
use crate::protocol_constants::{APP_NAME, ICY_METAINT};
use crate::services::speaker_monitor::control::{
    drift_compensation_mode, drift_force_ppm, DriftMode, DRIFT_FORCE_PPM_ENV,
};
use crate::stream::manager::TimestampedFrame;
use crate::stream::tap::pcm_header;
use crate::stream::{
    create_wav_header_with_data_size, create_wav_stream_with_cadence, lagged_error,
    parse_segment_file, pcm_connect_burst_ms, side_body, AudioCodec, BodyFraming, CadenceConfig,
    ChainParts, ChainStats, ConnectionTap, DeclaredEnd, EpochHook, FirstConnectionWait,
    FirstWaitWatch, HeadStart, IcyMetadataInjector, LoggingStreamGuard, NewReason, PcmContinuation,
    PcmHttpFraming, PcmHttpSettings, PcmHttpSwitches, PcmSegmentDidl, PlayoutChain, RateAdapter,
    RateControl, Route, SegmentLayout, SegmentStart, StreamState, MAX_UNLISTED_STREAM_READERS,
};

/// A single item of an audio body stream.
type FrameResult = Result<Bytes, std::io::Error>;

/// Boxed stream type for audio data.
type AudioStream = Pin<Box<dyn Stream<Item = FrameResult> + Send>>;

/// What to do with a fetch of `/stream/{id}/live`, and why.
///
/// Produced by [`decide_stream_access`] so the warning line and the refusal
/// come from one decision rather than two that could drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamAccess {
    /// The peer holds a playback session on this stream, or is mid-start for it.
    Speaker,
    /// The peer is this machine: loopback, or the companion's own address.
    CompanionHost,
    /// The peer is on no list, and `strict_stream_access` is off: serve, warn.
    UnlistedServed,
    /// The peer is on no list, and `strict_stream_access` is on: refuse.
    UnlistedRefused,
}

impl StreamAccess {
    /// Whether this reader draws on the stream's unlisted-reader budget.
    ///
    /// Only a peer the stream is not playing on does. A speaker on the
    /// allowlist, or this host, is never refused for being one reader too
    /// many: it would be silent dead air, a large unsynced cast legitimately
    /// has as many readers as it has speakers, and each of their routine
    /// reconnects double-counts until the replaced connection is reaped. The
    /// cap exists to bound a *harvested* stream id, which is unlisted by
    /// definition, and exempting real speakers is also what stops an unlisted
    /// flood from starving them. See [`MAX_UNLISTED_STREAM_READERS`].
    fn draws_unlisted_budget(self) -> bool {
        match self {
            StreamAccess::Speaker | StreamAccess::CompanionHost => false,
            StreamAccess::UnlistedServed | StreamAccess::UnlistedRefused => true,
        }
    }

    /// Whether this reader's connections count as playback.
    ///
    /// Playback bookkeeping is per source address: a connection starts an
    /// epoch for its address, and a later connection from the same address is
    /// treated as a resume (prefill skipped). Both are meaningless for an
    /// unlisted reader, and harmful: the epoch map is a bounded LRU sized for
    /// a household's speakers, so a handful of unlisted readers would evict a
    /// real speaker's entry and turn its next reconnect into a mis-timed cold
    /// start. A player on this machine is one reader the stream is for, and
    /// its reconnects are real resumes, so it keeps its own epoch; but it is
    /// no speaker, so a resume never sends it `Play` (see
    /// [`Self::resumes_speaker`]).
    fn tracks_playback(self) -> bool {
        match self {
            StreamAccess::Speaker | StreamAccess::CompanionHost => true,
            StreamAccess::UnlistedServed | StreamAccess::UnlistedRefused => false,
        }
    }

    /// Whether a resume from this reader is a Sonos speaker coming back, to
    /// be sent a SOAP `Play` if it is not already playing.
    ///
    /// Only a speaker the stream is playing on. A player on this machine
    /// (VLC, say) reconnecting is a resume too, but its address is this
    /// computer's, which answers no SOAP: a `Play` sent there only fails, and
    /// an unlisted reader's address is no speaker's either.
    fn resumes_speaker(self) -> bool {
        match self {
            StreamAccess::Speaker => true,
            StreamAccess::CompanionHost
            | StreamAccess::UnlistedServed
            | StreamAccess::UnlistedRefused => false,
        }
    }

    /// Whether this reader's playback can be watched by polling it.
    ///
    /// Only a speaker the stream is playing on answers `GetPositionInfo`.
    /// This machine tracks playback (a local player's reconnects are real
    /// resumes) but is not a Sonos speaker, so polling it would only collect
    /// refusals.
    fn monitors_playback(self) -> bool {
        match self {
            StreamAccess::Speaker => true,
            StreamAccess::CompanionHost
            | StreamAccess::UnlistedServed
            | StreamAccess::UnlistedRefused => false,
        }
    }
}

/// Decides whether `peer` may fetch a stream whose speakers are `speaker_ips`.
///
/// `speaker_ips` comes from `StreamCoordinator::allowed_reader_ips`, derived per
/// request rather than recorded at start, so speakers joining, leaving, being
/// taken over or being promoted need no bookkeeping here. `local_ip` is the
/// companion's own advertised address.
///
/// Both sides of every comparison are canonicalised. A dual-stack listener
/// reports an IPv4 client as an IPv4-mapped IPv6 address (`::ffff:192.168.1.5`),
/// which the WebSocket path already had to handle; session addresses arrive as
/// strings parsed out of the Sonos topology, so they are parsed and canonicalised
/// too rather than compared as text.
///
/// An address that parses as nothing is simply not a match — never a refusal of
/// everything else.
fn decide_stream_access(
    peer: IpAddr,
    speaker_ips: &[String],
    local_ip: &str,
    strict: bool,
) -> StreamAccess {
    let peer = peer.to_canonical();

    let is_speaker = speaker_ips
        .iter()
        .filter_map(|ip| ip.parse::<IpAddr>().ok())
        .any(|ip| ip.to_canonical() == peer);

    if is_speaker {
        StreamAccess::Speaker
    } else if is_companion_host(local_ip, peer) {
        // Covers loopback in both forms as well as this host's LAN address.
        StreamAccess::CompanionHost
    } else if strict {
        StreamAccess::UnlistedRefused
    } else {
        StreamAccess::UnlistedServed
    }
}

/// Serves `/stream/{id}/live`, `/stream/{id}/live.wav` and
/// `/stream/{id}/live.flac`: the stream from its live edge.
pub(super) async fn stream_audio(
    Path(id): Path<String>,
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    version: Version,
    headers: HeaderMap,
) -> ThaumicResult<Response> {
    serve_stream(id, None, state, remote_addr, version, headers).await
}

/// Serves `/stream/{id}/live/{n}.wav`, segment `n` (n ≥ 1) of a PCM cast.
///
/// A WAV header can declare at most 4 GiB, so a long PCM cast is served as
/// consecutive segments, each under its own URL (see [`crate::stream::uri`]).
/// A file name that is not a canonical `{n}.wav`, or a stream that is not
/// PCM, answers 404 exactly as an unknown stream does. A segment goes through
/// the same access check as `live.wav` (keyed by stream id, so every segment
/// of a stream admits the same readers), and continues the speaker's playout
/// where the previous segment ended (see [`crate::stream::playout`]).
pub(super) async fn stream_audio_segment(
    Path((id, file)): Path<(String, String)>,
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    version: Version,
    headers: HeaderMap,
) -> ThaumicResult<Response> {
    let Some(segment) = parse_segment_file(&file) else {
        return Err(ThaumicError::StreamNotFound(id));
    };
    serve_stream(id, Some(segment), state, remote_addr, version, headers).await
}

/// Serves one fetch of stream `id`; `segment` is the PCM segment a
/// `live/{n}.wav` URL asked for, `None` for the stream's own URL.
async fn serve_stream(
    id: String,
    segment: Option<u32>,
    state: AppState,
    remote_addr: SocketAddr,
    version: Version,
    headers: HeaderMap,
) -> ThaumicResult<Response> {
    let stream_state = state
        .stream_coordinator
        .get_stream(&id)
        .ok_or_else(|| ThaumicError::StreamNotFound(id.clone()))?;
    if segment.is_some() && stream_state.codec != AudioCodec::Pcm {
        // Only PCM has a length to run out of; a segment of anything else is a
        // URL no server hands out.
        return Err(ThaumicError::StreamNotFound(id));
    }

    let remote_ip = remote_addr.ip();

    // A stream id is not a credential — Sonos republishes the stream URL as
    // `CurrentTrackURI` to anything on the LAN that asks — so check that this
    // peer is one of the devices the stream is actually for. Derived per
    // request; see `decide_stream_access`.
    let allowed_ips = state.stream_coordinator.allowed_reader_ips(&id);
    let (strict, speaker_monitor, connect_burst_ms, drift_compensation) = {
        let config = state.config.read();
        (
            config.strict_stream_access,
            config.speaker_monitor,
            config.pcm_connect_burst_ms,
            config.drift_compensation,
        )
    };
    let access = decide_stream_access(
        remote_ip,
        &allowed_ips,
        &state.network.get_local_ip(),
        strict,
    );

    // `draws_unlisted_budget` matches exhaustively, so a future variant cannot
    // quietly fall through as both allowed and uncapped.
    let reader_slot = if access.draws_unlisted_budget() {
        let refused = access == StreamAccess::UnlistedRefused;
        // Once per address per stream at warn, then debug: a refused reader
        // that retries in a loop must not be able to fill the log, and the
        // first line already carries everything needed to judge it.
        let verdict = if refused {
            "refused (strict_stream_access is on)"
        } else {
            "serving anyway (strict_stream_access is off)"
        };
        if stream_state.note_unlisted_reader(remote_ip) {
            log::warn!(
                "[Stream] Fetch from an address this stream is not for: client={}, stream={}, \
                 allowed={:?} — {}",
                remote_ip,
                id,
                allowed_ips,
                verdict
            );
        } else {
            log::debug!(
                "[Stream] Repeat fetch from an address this stream is not for: client={}, \
                 stream={} — {}",
                remote_ip,
                id,
                verdict
            );
        }
        if refused {
            // 404, not 403: an expired stream already answers 404, so a
            // harvested id learns nothing about whether it was ever valid.
            return Err(ThaumicError::StreamNotFound(id));
        }

        // Serving it, but on a budget: every reader costs a cadence pipeline,
        // so a harvested id must not fan out without bound. Not an access
        // decision — it is not gated on `strict_stream_access`; strict mode
        // simply refuses these peers before they ever reach it. The slot is
        // held by the response body below and freed when that body is dropped.
        // 404 for the same reason a refusal is: the caller learns nothing.
        let Some(slot) = stream_state.acquire_unlisted_reader() else {
            log::warn!(
                "[Stream] Refusing fetch: stream {} already has its maximum of {} readers from \
                 addresses it is not playing on (client={})",
                id,
                MAX_UNLISTED_STREAM_READERS,
                remote_ip
            );
            return Err(ThaumicError::StreamNotFound(id));
        };
        Some(slot)
    } else {
        None
    };

    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // How hyper will delimit the body. No codec declares a length unless a
    // field experiment's switches say so for PCM (see `ResponseFraming`):
    // every body is chunked for an HTTP/1.1 client and close-delimited for an
    // HTTP/1.0 one. Logged so that every end of the connection can be
    // explained, and recorded on the guard so wire bytes include the framing.
    let pcm_switches = (stream_state.codec == AudioCodec::Pcm).then(PcmHttpSwitches::from_env);
    let pcm_http = pcm_switches.as_ref().map(|switches| switches.settings);
    let response_framing = ResponseFraming::new(version, pcm_http.as_ref());
    let framing = response_framing.framing;

    // Every fetch is logged with the range it asked for: a PCM segment
    // answers one with the rest of the segment, anything else from the live
    // edge like any other fetch.
    log::info!(
        "{}",
        connection_line(
            remote_ip,
            &id,
            segment,
            stream_state.codec,
            version,
            framing,
            range_header.as_deref()
        )
    );
    if let Some(switches) = &pcm_switches {
        log_pcm_switches(remote_ip, &id, switches);
    }

    // A PCM cast is served in segments carried by one playout per speaker,
    // unless a field experiment's switch fixes a connection's end itself.
    // What a fetch is to that playout is decided first, before anything
    // treats it as a new connection or a resume: a continuation needs no
    // prefill wait, starts no epoch and sends no resume `Play` (the speaker
    // is between items, and a `Play` then would race its own switch).
    let segment_layout = pcm_http
        .as_ref()
        .filter(|settings| settings.segments)
        .map(|settings| SegmentLayout::new(&stream_state.audio_format, settings.segment_bytes));
    let mut new_segment: Option<(SegmentLayout, SegmentStart)> = None;
    if let Some(layout) = segment_layout {
        let url_segment = segment.unwrap_or(0);
        let range_start = range_header.as_deref().and_then(parse_range_start);
        let route = if access.tracks_playback() {
            stream_state
                .playout
                .route(remote_ip, url_segment, range_start, &layout, |body_bytes| {
                    Arc::new(
                        LoggingStreamGuard::new(id.to_string(), remote_ip)
                            .with_link_probe(state.link_registry.claim(remote_addr))
                            .with_framing(framing)
                            .with_declared_end(Some(DeclaredEnd::new(
                                body_bytes,
                                layout.byte_rate().min(u64::from(u32::MAX)) as u32,
                            ))),
                    )
                })
        } else {
            // A reader the stream is not for gets a playout of its own that
            // ends with its connection.
            match SegmentStart::new(url_segment, range_start, &layout) {
                Some(start) => Route::New(NewReason::NoPlayout, start),
                None => Route::Unsatisfiable(layout.total_bytes()),
            }
        };
        let content_type = stream_state.codec.mime_type();
        match route {
            Route::Attach(body) => {
                let start = body.start();
                let guard = Arc::clone(body.guard());
                let builder = segment_head(
                    response_head(content_type, false, response_framing),
                    &start,
                    &layout,
                );
                let final_stream: AudioStream =
                    Box::pin(with_delivery_record(body, guard, reader_slot));
                return builder
                    .body(Body::from_stream(final_stream))
                    .map_err(|e| ThaumicError::Internal(e.to_string()));
            }
            Route::Side(start) => {
                let guard = Arc::new(
                    LoggingStreamGuard::new(id.to_string(), remote_ip).with_framing(framing),
                );
                let builder = segment_head(
                    response_head(content_type, false, response_framing),
                    &start,
                    &layout,
                );
                let body = side_body(start, &layout, &stream_state.audio_format);
                let final_stream: AudioStream =
                    Box::pin(with_delivery_record(body, guard, reader_slot));
                return builder
                    .body(Body::from_stream(final_stream))
                    .map_err(|e| ThaumicError::Internal(e.to_string()));
            }
            Route::Unsatisfiable(total) => {
                log::info!(
                    "[Stream] Range past the end of a segment: client={}, stream={}, \
                     segment={}, range={:?}, segment_bytes={}; answering 416",
                    remote_ip,
                    id,
                    url_segment,
                    range_header.as_deref().unwrap_or(""),
                    total
                );
                return Response::builder()
                    .status(axum::http::StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .body(Body::empty())
                    .map_err(|e| ThaumicError::Internal(e.to_string()));
            }
            Route::New(reason, start) => {
                let level = if reason == NewReason::NoPlayout && url_segment > 0 {
                    // No playout to continue into a later segment: this
                    // server restarted, or the playout was dropped.
                    log::Level::Warn
                } else {
                    log::Level::Info
                };
                log::log!(
                    level,
                    "[Stream] New playout: client={}, stream={}, segment={}, reason={}, \
                     first_byte={}",
                    remote_ip,
                    id,
                    url_segment,
                    reason.label(),
                    start.first_byte()
                );
                new_segment = Some((layout, start));
            }
        }
    }

    // Detect resume: this specific IP had a previous HTTP connection.
    // Uses per-IP epoch tracking (not global counter) to avoid misclassifying
    // new speakers as resumes after the first speaker connects. Unlisted
    // readers never start an epoch (see `tracks_playback`), so they can never
    // look like one resuming either, and only a speaker's resume sends `Play`
    // (see `resumes_speaker`).
    let ResumeDecision {
        is_resume,
        play_ip: resume_play_ip,
    } = decide_resume(access, &stream_state, remote_ip);

    // Upfront buffering delay for PCM streams BEFORE subscribing.
    // Lets the ring buffer accumulate frames so the prefill snapshot returned
    // by `subscribe()` has real audio — otherwise the cadence stream would
    // begin emitting silence frames as its first body bytes, which Sonos has
    // been observed to treat as a stalled stream and respond to with a
    // transport-state transition to Stopped.
    //
    // The ring must hold the jitter buffer, which the cadence queue keeps,
    // plus the connect burst, which goes out at once (see
    // `CadenceConfig::new`). So a first connection waits until the stream is
    // `jitter_buffer_ms + burst` old, and never less than `jitter_buffer_ms`
    // (see `pcm_prefill_delay`). A speaker's GET usually follows the
    // stream's first frame within a second, so without the longer wait its
    // first connection, the one the reserve matters most on, would get only
    // a fraction of the burst. The longest wait is jitter buffer plus burst.
    // A Playbar has been seen to accept a 1000 ms wait before the response;
    // longer ones are untried, so the wait is not capped but logged, and so
    // is whether the speaker kept its connection through it (see
    // `FirstWaitWatch` and `LoggingStreamGuard::with_first_wait`).
    // `jitter_buffer_ms` is already validated against `MAX_JITTER_BUFFER_MS`
    // at the protocol layer, and the burst against its maximum.
    //
    // SKIP on resume: Sonos closes the connection within milliseconds if we
    // delay. The ring buffer already has frames from before the pause.
    let connect_burst_ms = pcm_connect_burst_ms(connect_burst_ms);
    let since_first_frame = stream_state.timing.first_frame_at().map(|t| t.elapsed());
    let prefill_delay = pcm_prefill_delay(
        stream_state.jitter_buffer_ms,
        connect_burst_ms,
        since_first_frame,
    );
    let mut first_wait = None;
    if stream_state.codec == AudioCodec::Pcm && !prefill_delay.is_zero() && !is_resume {
        let wait = FirstConnectionWait {
            waited_ms: prefill_delay.as_millis() as u64,
            smoothing_ms: stream_state.jitter_buffer_ms,
            head_start_ms: connect_burst_ms,
        };
        log::info!(
            "[Stream] First-connection wait: client={}, stream={}, holding the response {}ms \
             so the stream holds smoothing {}ms + head start {}ms ({})",
            remote_ip,
            id,
            wait.waited_ms,
            wait.smoothing_ms,
            wait.head_start_ms,
            since_first_frame.map_or_else(
                || "stream not started yet".to_string(),
                |d| format!("stream age {}ms", d.as_millis())
            )
        );
        first_wait = Some(wait);
        // A speaker that will not take the wait may hang up during it, and
        // the handler is then dropped here, before any guard exists to log
        // the outcome; the watch logs it instead.
        let watch = FirstWaitWatch::arm(wait, remote_ip, &id);
        tokio::time::sleep(prefill_delay).await;
        watch.completed();
    } else if is_resume && stream_state.codec == AudioCodec::Pcm {
        log::info!(
            "[Stream] Skipping prefill delay on resume for {}",
            remote_ip
        );
    }
    if let Some(ip) = resume_play_ip {
        // Delegate playback control to coordinator (SoC: HTTP serves audio,
        // coordinator controls playback). Fire-and-forget.
        let coordinator = Arc::clone(&state.stream_coordinator);
        tokio::spawn(async move {
            coordinator.on_http_resume(&ip).await;
        });
    }

    // Capture connected_at AFTER the prefill delay so latency metrics reflect
    // actual transport latency, not intentional startup buffering.
    let connected_at = Instant::now();

    // Subscribe AFTER delay to get fresh prefill snapshot and avoid rx backlog
    let (prefill_frames, rx) = stream_state.subscribe();

    log::debug!(
        "[Stream] Client {} connected to stream {}, sending {} prefill frames",
        remote_ip,
        id,
        prefill_frames.len()
    );

    // Create logging guard early so we can pass it to the cadence stream for internal tracking.
    // Uses Arc so it can be shared between cadence stream and final frame recording.
    // The connection's TCP counters judge the network path to this speaker;
    // only a reader the stream is for is worth judging, and reporting on an
    // unlisted reader would name an address that is not a speaker.
    let link_probe = access
        .tracks_playback()
        .then(|| state.link_registry.claim(remote_addr))
        .flatten();
    // A PCM body has an end the speaker reads to, whatever hyper does: the
    // WAV header's length. Near it the speaker going quiet is the end of the
    // item, which the guard and the speaker monitor must not take for a stall.
    let byte_rate = stream_state
        .audio_format
        .frame_bytes(1000)
        .min(u32::MAX as usize) as u32;
    // A segment's end is its own: the rest of its header and data from
    // where the fetch started.
    let declared_end = match &new_segment {
        Some((layout, start)) => Some(DeclaredEnd::new(start.body_bytes(layout), byte_rate)),
        None => pcm_http
            .as_ref()
            .map(|settings| DeclaredEnd::new(settings.declared_end_bytes(), byte_rate)),
    };
    let mut guard = LoggingStreamGuard::new(id.to_string(), remote_ip)
        .with_link_probe(link_probe)
        .with_framing(framing)
        .with_declared_end(declared_end);
    if let Some(wait) = first_wait {
        guard = guard.with_first_wait(wait);
    }
    let guard = Arc::new(guard);

    // What outlives this connection: for a segmented PCM cast, the playout's
    // statistics, which every later segment of it reports into; otherwise
    // the connection is the whole playout. Only a speaker's playout reports
    // audio reaching this machine late: an unlisted reader that falls behind
    // could run its own queue dry and raise a notice about gaps no speaker
    // heard.
    let mut stats = ChainStats::new(id.to_string(), remote_ip);
    if access.tracks_playback() {
        stats = stats
            .with_events(Arc::clone(&state.event_bridge) as Arc<dyn crate::events::EventEmitter>);
    }
    let stats = if new_segment.is_some() {
        Arc::new(stats)
    } else {
        stats.following(&guard, pcm_header(stream_state.codec))
    };

    // One-shot epoch hook for whichever pipeline is built below. None for a
    // reader that is not a speaker: its connection must not enter the
    // per-address playback bookkeeping (see `tracks_playback`).
    //
    // The epoch's content T0 is the first frame each pipeline serves: the PCM
    // cadence trims the prefill first, so it supplies its own.
    //
    // A speaker's connection is also handed to the speaker monitor once its
    // epoch starts: whoever actually fetches is the device whose playback can
    // be measured, however the cast was started. The monitor always learns of
    // the connection, since video sync may need it; whether it polls a
    // speaker nobody asked video sync for follows the speaker-monitor
    // setting as it stands now, so a change applies from the next connection.
    //
    // Clock drift correction is decided here too, once per connection: it
    // steers by the monitor's estimates, so only a monitored speaker's PCM
    // connection gets a rate control, and only with correction on. Observing
    // or off, the cadence builds no adapter and sends the captured buffers
    // themselves. THAUMIC_DRIFT_FORCE_PPM, for listening tests, overrides
    // all of that with a fixed rate.
    let tap = access.monitors_playback().then(|| {
        let monitor = speaker_monitor;
        let drift = drift_compensation_mode(drift_compensation, monitor);
        let rate_control = connection_rate_control(
            drift,
            stream_state.codec,
            &stream_state.audio_format,
            drift_force_ppm(),
        );
        if let Some(ppm) = rate_control.as_ref().and_then(|c| c.forced_ppm()) {
            log::warn!(
                "[Drift] {}={:+} forcing the rate adapter; for listening tests only \
                 (client={}, stream={}, mode={})",
                DRIFT_FORCE_PPM_ENV,
                ppm,
                remote_ip,
                id,
                drift
            );
        } else if rate_control.is_some() {
            log::info!(
                "[Stream] Clock drift correction on for client={}, stream={}",
                remote_ip,
                id
            );
        }
        let tap = ConnectionTap::new(
            id.clone(),
            remote_ip,
            connected_at,
            stream_state.codec,
            &stream_state.audio_format,
            Arc::clone(&stats),
            monitor,
        )
        .with_drift(drift, rate_control);
        // A connection that is its own playout holds its record for as long
        // as the tap lives; a segmented playout finds the connection it is
        // serving through its statistics.
        Arc::new(if new_segment.is_some() {
            tap
        } else {
            tap.with_connection(Arc::clone(&guard))
        })
    });
    let epoch_hook: Option<EpochHook> = access.tracks_playback().then(|| {
        let preroll = new_segment
            .as_ref()
            .map_or(Duration::ZERO, |(layout, start)| start.preroll(layout));
        let hook = EpochHook::new(Arc::downgrade(&stream_state), connected_at, remote_ip)
            .with_preroll(preroll);
        match &tap {
            Some(tap) => hook.with_monitor(Arc::clone(tap), state.latency_monitor.registrar()),
            None => hook,
        }
    });

    // Build combined stream - PCM gets cadence-based streaming, compressed codecs don't.
    //
    // Why PCM-only: Sonos treats PCM/WAV as a "file" requiring continuous data flow.
    // CPU spikes that delay delivery cause Sonos to close the connection.
    // The cadence stream maintains 20ms output cadence, injecting silence when needed.
    //
    // Compressed codecs (AAC, MP3, FLAC) have their own framing and silence
    // representation - raw zeros would corrupt the stream. These codecs also
    // tend to be more resilient to jitter due to their buffering behavior.
    let combined_stream: AudioStream = if stream_state.codec == AudioCodec::Pcm {
        // PCM: fixed-cadence streaming with silence injection on underrun.
        // Prefill frames are pre-populated in the queue to eliminate the
        // handoff gap; `CadenceConfig::new` trims them so the initial queue
        // does not exceed the intended buffer depth, and anchors the epoch to
        // the first frame it keeps.
        //
        // The oldest frames beyond the jitter buffer, up to the configured
        // connect burst, are sent at once so the speaker starts with that much
        // audio in hand (see `CadenceConfig::burst_frames`). A resume gets it
        // too: that is when a speaker's reserve starts again from nothing.
        // The tap records the head start actually sent, which the speaker
        // monitor sizes the speaker's low floor from.
        pcm_cadence_stream(
            &stream_state,
            connect_burst_ms,
            prefill_frames,
            rx,
            Arc::clone(&stats),
            epoch_hook,
            tap.as_deref(),
            remote_ip,
            is_resume,
        )
    } else {
        // Compressed codecs: no silence injection, chain prefill before live.
        // Every prefill frame is served, so the oldest one is the first.
        let epoch_candidate = prefill_frames.first().map(|f| f.captured_at);
        let prefill_stream = futures::stream::iter(prefill_frames.into_iter().map(|f| Ok(f.data)));
        let live_stream = BroadcastStream::new(rx).map(|res| match res {
            Ok(frame) => Ok(frame),
            Err(BroadcastStreamRecvError::Lagged(n)) => Err(lagged_error(n)),
        });
        let raw_stream = futures::StreamExt::chain(prefill_stream, live_stream);

        // Fire epoch on first non-empty frame (compressed codecs never inject silence)
        match epoch_hook {
            Some(hook) => Box::pin(with_epoch_hook(raw_stream, hook, epoch_candidate)),
            None => Box::pin(raw_stream),
        }
    };

    // Content-Type based on output codec
    let content_type = stream_state.codec.mime_type();

    // ICY metadata only supported for MP3/AAC streams (not PCM/FLAC)
    let supports_icy = matches!(stream_state.codec, AudioCodec::Mp3 | AudioCodec::Aac);
    let wants_icy =
        supports_icy && headers.get("icy-metadata").and_then(|v| v.to_str().ok()) == Some("1");

    let builder = response_head(content_type, wants_icy, response_framing);

    // A segmented PCM playout: its first connection's body is made by the
    // playout, which writes the segment's header and ends at its size, and
    // it holds the tap for as long as it lasts, across its segments.
    if let Some((layout, start)) = new_segment {
        let builder = segment_head(builder, &start, &layout);
        let body = PlayoutChain::start(ChainParts {
            stream_id: id.clone(),
            speaker_ip: remote_ip,
            format: stream_state.audio_format,
            layout,
            cadence: combined_stream,
            stats,
            tap,
            start,
            guard: Arc::clone(&guard),
            registry: access
                .tracks_playback()
                .then(|| Arc::clone(&stream_state.playout)),
            continuation: pcm_http
                .as_ref()
                .map_or_else(PcmContinuation::default, |settings| settings.continuation),
            segment_didl: pcm_http
                .as_ref()
                .map_or_else(PcmSegmentDidl::default, |settings| settings.segment_didl),
            head_start: Duration::from_millis(connect_burst_ms),
            events: access
                .tracks_playback()
                .then(|| state.stream_coordinator.playout_events()),
        });
        let final_stream: AudioStream = Box::pin(with_delivery_record(body, guard, reader_slot));
        return builder
            .body(Body::from_stream(final_stream))
            .map_err(|e| ThaumicError::Internal(e.to_string()));
    }

    // Apply ICY injection or PCM/WAV header
    let inner_stream: AudioStream = if wants_icy {
        Box::pin(with_icy_metadata(
            combined_stream,
            Arc::downgrade(&stream_state),
        ))
    } else if stream_state.codec == AudioCodec::Pcm {
        // PCM streams need WAV header prepended per-connection (Sonos may reconnect)
        let audio_format = stream_state.audio_format;
        let wav_header = create_wav_header_with_data_size(
            audio_format.sample_rate,
            audio_format.channels,
            audio_format.bits_per_sample,
            pcm_http.unwrap_or_default().wav_data_size,
        );
        Box::pin(futures::StreamExt::chain(
            futures::stream::once(async move { Ok(wav_header) }),
            combined_stream,
        ))
    } else {
        Box::pin(combined_stream)
    };

    // A field experiment may end the body cleanly after a set number of bytes.
    let inner_stream = with_optional_server_cap(inner_stream, pcm_http.as_ref(), &guard);

    // Wrap stream with logging guard to track delivery timing and errors.
    // The guard logs summary stats on drop when the stream ends. The body
    // also owns the connection's tap and, for an unlisted reader, its budget
    // slot (see `with_delivery_record`).
    let final_stream: AudioStream = Box::pin(with_delivery_record(
        inner_stream,
        guard,
        (tap, reader_slot),
    ));

    builder
        .body(Body::from_stream(final_stream))
        .map_err(|e| ThaumicError::Internal(e.to_string()))
}

/// Adds to a PCM segment response's head what a fetch of part of the
/// segment needs: `206` and the `Content-Range` it carries, from the first
/// byte asked for to the segment's end.
fn segment_head(
    builder: axum::http::response::Builder,
    start: &SegmentStart,
    layout: &SegmentLayout,
) -> axum::http::response::Builder {
    if !start.is_partial() {
        return builder;
    }
    let total = layout.total_bytes();
    builder
        .status(axum::http::StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start.first_byte(), total - 1, total),
        )
}

/// The first byte a `Range` header asks for (`bytes=X-` or `bytes=X-Y`; of
/// several ranges, the first), or `None` for anything else, which is served
/// as a fetch of the whole resource.
fn parse_range_start(range: &str) -> Option<u64> {
    let spec = range.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start, _) = first.split_once('-')?;
    start.trim().parse().ok()
}

/// The `[Stream] New connection` line: who is fetching, which PCM segment if
/// the URL named one, with which HTTP version, how the body will be delimited
/// and the length it declares, and the range asked for, if any.
fn connection_line(
    remote_ip: IpAddr,
    stream_id: &str,
    segment: Option<u32>,
    codec: AudioCodec,
    version: Version,
    framing: BodyFraming,
    range: Option<&str>,
) -> String {
    let declared_len = framing
        .declared_len()
        .map_or_else(|| "none".to_string(), |len| len.to_string());
    let segment = segment
        .map(|n| format!(", segment={n}"))
        .unwrap_or_default();
    let range = range.map(|r| format!(", range='{r}'")).unwrap_or_default();
    format!(
        "[Stream] New connection: client={remote_ip}, stream={stream_id}{segment}, \
         codec={codec:?}, http={version:?}, framing={}, declared_len={declared_len}{range}",
        framing.label()
    )
}

/// The head of a stream response: its headers, in the order they go out, and
/// for a close-delimited body the HTTP/1.0 status line.
///
/// The order is the one every response has always had: a field experiment
/// studies how a speaker reacts to exactly these bytes, so they must not
/// move. Only `Connection` and, for PCM with `length` framing,
/// `Content-Length` follow the framing.
fn response_head(
    content_type: &str,
    wants_icy: bool,
    framing: ResponseFraming,
) -> axum::http::response::Builder {
    let connection = if framing.close { "close" } else { "keep-alive" };
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, connection)
        // DLNA streaming header: indicates real-time playback vs download-first
        .header("TransferMode.dlna.org", "Streaming")
        // Stream identification for renderers that display station name
        .header("icy-name", APP_NAME);

    if wants_icy {
        builder = builder.header("icy-metaint", ICY_METAINT.to_string());
    }

    // A declared Content-Length, or the HTTP/1.0 status line.
    framing.apply(builder)
}

/// How a response body is delimited, and the headers that say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResponseFraming {
    /// How hyper will delimit the body, as logged and recorded on the guard.
    framing: BodyFraming,
    /// The `Content-Length` to declare, if any.
    content_length: Option<u64>,
    /// Answer as HTTP/1.0 with `Connection: close` rather than keep-alive.
    close: bool,
}

impl ResponseFraming {
    /// The framing for a response to a request of `request_version`: `pcm`
    /// is the PCM switches for a PCM stream, `None` for any other codec.
    ///
    /// By default PCM declares no length, like every other codec: hyper sends
    /// it chunked to an HTTP/1.1 client and close-delimited to an HTTP/1.0 one,
    /// answering that as HTTP/1.0. PCM used to declare `Content-Length:
    /// 4294967295`, added because Sonos was thought to stutter on chunked WAV;
    /// the stutter was the speaker's thin reserve, which the connect burst
    /// fixed. That length was a real end, and a Playbar caps a declared length
    /// at 2^31 bytes, so every cast to one stopped after 3h06m at 48 kHz. A field
    /// experiment can still declare a length (`length`, 4294967295 unless told
    /// otherwise), reported as `ended_by=length` when hyper stops there, or
    /// answer as HTTP/1.0 and end the body only by closing the connection. An
    /// HTTP/2 request has no close-delimited body, so there `close` declares no
    /// length, as `chunked` does.
    fn new(request_version: Version, pcm: Option<&PcmHttpSettings>) -> Self {
        let (content_length, close) = match pcm.map(|p| (p.framing, p.content_length)) {
            None | Some((PcmHttpFraming::Chunked, _)) => (None, false),
            Some((PcmHttpFraming::Length, len)) => (Some(len), false),
            Some((PcmHttpFraming::Close, _)) => (None, request_version < Version::HTTP_2),
        };
        let response_version = if close {
            Version::HTTP_10
        } else {
            request_version
        };
        Self {
            framing: BodyFraming::for_response(response_version, content_length),
            content_length,
            close,
        }
    }

    /// Sets what this framing adds to a head `builder` that already carries
    /// the `Connection` header (see [`response_head`]): the declared
    /// `Content-Length`, if any, last, where it always was.
    ///
    /// A close-delimited body can only end by the connection closing, so it
    /// goes out as HTTP/1.0 (and `response_head` says `Connection: close`):
    /// hyper then sends it with neither a length nor chunking.
    fn apply(self, builder: axum::http::response::Builder) -> axum::http::response::Builder {
        if self.close {
            return builder.version(Version::HTTP_10);
        }
        match self.content_length {
            Some(len) => builder.header(header::CONTENT_LENGTH, len.to_string()),
            None => builder,
        }
    }
}

/// Logs the PCM HTTP switches a connection is served with, and each one that
/// was ignored, when any is set. Nothing is logged when none is: the
/// connection line already shows the default framing and length.
fn log_pcm_switches(remote_ip: IpAddr, stream_id: &str, switches: &PcmHttpSwitches) {
    if !switches.any_set {
        return;
    }
    for problem in &switches.problems {
        log::warn!(
            "[Stream] {} (client={}, stream={})",
            problem,
            remote_ip,
            stream_id
        );
    }
    log::info!(
        "{}",
        pcm_switches_line(remote_ip, stream_id, &switches.settings)
    );
}

/// The `[Stream] PCM HTTP switches` line: the settings a PCM connection is
/// served with while a field experiment's switches are set.
fn pcm_switches_line(remote_ip: IpAddr, stream_id: &str, settings: &PcmHttpSettings) -> String {
    let content_length = if settings.framing == PcmHttpFraming::Length {
        settings.content_length.to_string()
    } else {
        "none".to_string()
    };
    let end_after = settings
        .end_after_bytes
        .map_or_else(|| "none".to_string(), |n| n.to_string());
    let (segments, continuation, didl) = if settings.segments {
        (
            settings.segment_bytes.to_string(),
            settings.continuation.label(),
            settings.segment_didl.label(),
        )
    } else {
        ("off".to_string(), "off", "off")
    };
    format!(
        "[Stream] PCM HTTP switches: client={remote_ip}, stream={stream_id}, framing={}, \
         content_length={content_length}, wav_data_size={}, end_after_bytes={end_after}, \
         segment_bytes={segments}, continuation={continuation}, segment_didl={didl}",
        settings.framing, settings.wav_data_size
    )
}

/// Ends `stream` cleanly after `pcm`'s `end_after_bytes`, when set, and
/// returns it unchanged otherwise (see [`with_server_cap`]).
fn with_optional_server_cap(
    stream: AudioStream,
    pcm: Option<&PcmHttpSettings>,
    guard: &Arc<LoggingStreamGuard>,
) -> AudioStream {
    match pcm.and_then(|p| p.end_after_bytes) {
        Some(cap) => with_server_cap(stream, cap, Arc::clone(guard)),
        None => stream,
    }
}

/// Ends `stream` after `cap` bytes, cutting the item that reaches the cap
/// short, and records on `guard` that the cap ended it, so the end line says
/// `ended_by=server_cap`. The body then ends as its framing allows: a last
/// zero-length chunk, or closing the connection. A test switch (see
/// [`crate::stream::PCM_END_AFTER_BYTES_ENV`]), never used with a declared
/// length, which hyper would abort the connection over.
///
/// The cap is marked when the item that reaches it is handed to hyper, just
/// before hyper writes it: should the speaker hang up in that moment, the end
/// is reported as `server_cap` rather than `client`. Only ever seen in an
/// experiment, and only for that last write.
fn with_server_cap(
    mut stream: AudioStream,
    cap: u64,
    guard: Arc<LoggingStreamGuard>,
) -> AudioStream {
    let mut remaining = cap;
    Box::pin(futures::stream::poll_fn(move |cx| {
        if remaining == 0 {
            // Without waiting for another item: ends the body at once.
            guard.mark_server_cap();
            return std::task::Poll::Ready(None);
        }
        match stream.as_mut().poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(mut bytes))) => {
                if bytes.len() as u64 >= remaining {
                    bytes.truncate(remaining as usize);
                    guard.mark_server_cap();
                }
                remaining -= bytes.len() as u64;
                std::task::Poll::Ready(Some(Ok(bytes)))
            }
            other => other,
        }
    }))
}

/// How long a new (not resuming) PCM connection waits before subscribing,
/// so the ring holds the jitter buffer plus the connect burst: until the
/// stream's first frame is `jitter_buffer_ms + burst_ms` old, and never less
/// than `jitter_buffer_ms`. `since_first_frame` is `None` before the stream
/// has received a frame, which waits the whole of both.
fn pcm_prefill_delay(
    jitter_buffer_ms: u64,
    burst_ms: u64,
    since_first_frame: Option<Duration>,
) -> Duration {
    let jitter = Duration::from_millis(jitter_buffer_ms);
    let wanted = Duration::from_millis(jitter_buffer_ms + burst_ms);
    wanted
        .saturating_sub(since_first_frame.unwrap_or_default())
        .max(jitter)
}

/// Builds a PCM connection's cadence body from its `subscribe()` snapshot,
/// with a connect burst of `burst_ms` (already resolved, see
/// [`pcm_connect_burst_ms`]), records on `tap` the head start the ring
/// allowed, and logs how the prefill was split.
#[allow(clippy::too_many_arguments)]
fn pcm_cadence_stream(
    stream_state: &Arc<StreamState>,
    burst_ms: u64,
    prefill_frames: Vec<TimestampedFrame>,
    rx: tokio::sync::broadcast::Receiver<Bytes>,
    stats: Arc<ChainStats>,
    epoch_hook: Option<EpochHook>,
    tap: Option<&ConnectionTap>,
    remote_ip: IpAddr,
    is_resume: bool,
) -> AudioStream {
    let frame_duration_ms = stream_state.frame_duration_ms;
    let available_frames = prefill_frames.len();
    let config = CadenceConfig::new(
        stream_state.audio_format.silence_frame(frame_duration_ms),
        stream_state.jitter_buffer_ms,
        burst_ms,
        frame_duration_ms,
        stream_state.audio_format,
        prefill_frames,
    );
    let config = match tap.and_then(ConnectionTap::rate_control) {
        Some(control) => config.with_rate_control(Arc::clone(control)),
        None => config,
    };
    if let Some(tap) = tap {
        tap.set_head_start(HeadStart::new(config.burst_ms(), burst_ms));
    }
    log_connect_burst(
        &stream_state.id,
        remote_ip,
        is_resume,
        burst_ms,
        available_frames,
        &config,
    );
    Box::pin(create_wav_stream_with_cadence(
        rx,
        stats,
        config,
        Some(Arc::downgrade(stream_state)),
        epoch_hook,
    ))
}

/// What a new connection means for playback, from its access and the
/// epochs its address has started.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResumeDecision {
    /// The address already started an epoch on this stream: its reader is
    /// coming back, so a PCM connection skips the prefill wait.
    is_resume: bool,
    /// The speaker to send `Play` to, if it is not already playing: a PCM
    /// speaker's resume only, never a player on this machine or an unlisted
    /// reader, whose addresses answer no SOAP.
    play_ip: Option<String>,
}

/// Decides whether a connection from `remote_ip` resumes playback on
/// `stream_state`, and whether a speaker is to be told to play again.
fn decide_resume(
    access: StreamAccess,
    stream_state: &StreamState,
    remote_ip: IpAddr,
) -> ResumeDecision {
    let is_resume =
        access.tracks_playback() && stream_state.timing.current_epoch_for(remote_ip).is_some();
    let play_ip = (is_resume && stream_state.codec == AudioCodec::Pcm && access.resumes_speaker())
        .then(|| remote_ip.to_string());
    ResumeDecision { is_resume, play_ip }
}

/// The rate control a new connection's drift correction follows: one for a
/// PCM connection made with correction on whose format the adapter can
/// resample, none otherwise (observing, off, a compressed codec, or a
/// format it cannot take), which leaves the stream zero-copy.
///
/// With `forced` (from [`drift_force_ppm`], for listening tests) every PCM
/// connection whose format the adapter takes gets a control fixed at that
/// rate instead, whatever the mode.
fn connection_rate_control(
    mode: DriftMode,
    codec: AudioCodec,
    audio_format: &crate::stream::AudioFormat,
    forced: Option<f64>,
) -> Option<Arc<RateControl>> {
    if codec != AudioCodec::Pcm || !RateAdapter::supports(audio_format) {
        return None;
    }
    match forced {
        Some(ppm) => Some(Arc::new(RateControl::forced(ppm))),
        None => (mode == DriftMode::On).then(|| Arc::new(RateControl::new())),
    }
}

/// Logs how much of a PCM connection's prefill is sent as its connect burst
/// and how much stays queued as the jitter buffer, and says so when the ring
/// held less than was asked for.
fn log_connect_burst(
    stream_id: &str,
    remote_ip: IpAddr,
    is_resume: bool,
    requested_ms: u64,
    available_frames: usize,
    config: &CadenceConfig,
) {
    let frame_ms = u64::from(config.frame_duration_ms);
    let burst_ms = config.burst_ms();
    let queued_ms = config.prefill_frames.len() as u64 * frame_ms;
    let target_ms = config.buffer_depth as u64 * frame_ms;
    let kind = if is_resume {
        "resume"
    } else {
        "new connection"
    };
    if requested_ms == 0 {
        log::info!(
            "[Stream] Connect burst off: client={}, stream={}, {}, queued={}ms of {}ms jitter buffer",
            remote_ip,
            stream_id,
            kind,
            queued_ms,
            target_ms
        );
    } else if burst_ms < requested_ms {
        // Info, not warn: the prefill delay waits for the full burst on a
        // first connection, so this is a resume soon after the stream began
        // or after a source pause, and the next connection gets it all.
        log::info!(
            "[Stream] Connect burst short: client={}, stream={}, {}, burst={}ms of {}ms requested, \
             queued={}ms of {}ms jitter buffer; the stream only held {}ms of audio, and the \
             jitter buffer is kept first",
            remote_ip,
            stream_id,
            kind,
            burst_ms,
            requested_ms,
            queued_ms,
            target_ms,
            available_frames as u64 * frame_ms
        );
    } else {
        log::info!(
            "[Stream] Connect burst: client={}, stream={}, {}, burst={}ms, queued={}ms of {}ms \
             jitter buffer",
            remote_ip,
            stream_id,
            kind,
            burst_ms,
            queued_ms,
            target_ms
        );
    }
}

/// Counts every item the body yields into `guard`: frames and bytes
/// delivered, which the speaker monitor reads as the delivered side of the
/// speaker's reserve (so a connect burst counts in full), the bytes they put
/// on the wire, and the first error. Also records the body running out on
/// our side, when `stream` ends, so the end line can tell that apart from
/// the client hanging up or hyper stopping at a declared length.
///
/// `owned` is whatever else the response body must own for its lifetime: the
/// connection's monitoring tap (the monitor holds it weakly, so dropping the
/// body ends its monitoring) and, for an unlisted reader, its budget slot,
/// freed when the body is dropped, the moment this reader is really gone.
fn with_delivery_record<S, O>(
    stream: S,
    guard: Arc<LoggingStreamGuard>,
    owned: O,
) -> impl Stream<Item = FrameResult> + Send
where
    S: Stream<Item = FrameResult> + Send,
    O: Send,
{
    let closed_on_drop = BodyClosedOnDrop(Arc::clone(&guard));
    let end_guard = Arc::clone(&guard);
    // Polled only once `stream` has ended, and never if hyper drops the body
    // first (at a declared length, or because the client went away).
    let source_end = futures::stream::poll_fn(move |_| {
        end_guard.mark_source_ended();
        std::task::Poll::Ready(None)
    });
    stream.chain(source_end).map(move |res: FrameResult| {
        let _owned = (&owned, &closed_on_drop);
        match &res {
            Ok(bytes) => {
                guard.record_frame();
                guard.record_body_bytes(bytes.len());
            }
            Err(e) => guard.record_error(&e.to_string()),
        }
        res
    })
}

/// Marks the connection's body closed when the body is dropped, which stops
/// the speaker monitor reading its socket (see
/// [`LoggingStreamGuard::mark_body_closed`]).
struct BodyClosedOnDrop(Arc<LoggingStreamGuard>);

impl Drop for BodyClosedOnDrop {
    fn drop(&mut self) {
        self.0.mark_body_closed();
    }
}

/// Starts a new playback epoch on the first real (non-empty) frame, then forgets
/// the hook.
///
/// `epoch_candidate` is the capture time of the first frame `stream` serves, or
/// `None` when it serves no prefill.
///
/// Errors and empty frames leave the hook armed: a live stream that has not
/// produced audio yet must still be timed from its first real frame.
///
/// If the [`Weak`] no longer upgrades the stream has been removed, so there is
/// nothing to time and the hook is dropped. The body itself ends on its own once
/// the broadcast sender goes with the stream.
fn with_epoch_hook<S>(
    stream: S,
    hook: EpochHook,
    epoch_candidate: Option<Instant>,
) -> impl Stream<Item = FrameResult> + Send
where
    S: Stream<Item = FrameResult> + Send,
{
    stream.scan(Some(hook), move |hook, item: FrameResult| {
        if let Some(armed) = hook.take() {
            let is_audio = item.as_ref().is_ok_and(|frame| !frame.is_empty());
            if is_audio {
                armed.fire(epoch_candidate);
            } else if armed.stream_alive() {
                // Alive but nothing to time yet - stay armed.
                *hook = Some(armed);
            }
            // Otherwise the stream is gone - drop the hook.
        }
        futures::future::ready(Some(item))
    })
}

/// Injects ICY metadata blocks into a body stream at `ICY_METAINT` intervals.
///
/// Holds the stream weakly for the same reason as [`EpochHook`]: the body must
/// not keep a removed stream alive. A failed upgrade ends the body, which tears
/// down the connection instead of feeding a speaker from a stream that is gone.
fn with_icy_metadata<S>(
    stream: S,
    stream_state: Weak<StreamState>,
) -> impl Stream<Item = FrameResult> + Send
where
    S: Stream<Item = FrameResult> + Send,
{
    stream.scan(IcyMetadataInjector::new(), move |injector, res| {
        let item = match res {
            Ok(chunk) => stream_state.upgrade().map(|state| {
                let metadata = state.metadata.read();
                Ok(injector.inject(chunk.as_ref(), &metadata))
            }),
            Err(e) => Some(Err(e)),
        };
        futures::future::ready(item)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::AudioFormat;
    use std::net::Ipv4Addr;

    /// The companion's own advertised address in these tests.
    const LOCAL_IP: &str = "192.168.1.5";

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("test address")
    }

    fn speakers(ips: &[&str]) -> Vec<String> {
        ips.iter().map(|s| (*s).to_string()).collect()
    }

    /// Access is decided by `decide_stream_access` rather than inside the axum
    /// handler, so these exercise the real decision without an HTTP stack, a
    /// bound port or a Sonos speaker. What they cannot cover is the wiring —
    /// that the handler calls it with the coordinator's live allowlist and turns
    /// a refusal into the same 404 an expired stream returns.
    #[test]
    fn a_speaker_playing_this_stream_is_served() {
        let allowed = speakers(&["192.168.1.50", "192.168.1.51"]);
        for strict in [false, true] {
            assert_eq!(
                decide_stream_access(ip("192.168.1.51"), &allowed, LOCAL_IP, strict),
                StreamAccess::Speaker,
                "every speaker of an unsynced multi-speaker cast fetches the same URL"
            );
        }
    }

    #[test]
    fn an_unknown_address_is_served_and_logged_until_the_flag_is_on() {
        let allowed = speakers(&["192.168.1.50"]);
        assert_eq!(
            decide_stream_access(ip("192.168.1.200"), &allowed, LOCAL_IP, false),
            StreamAccess::UnlistedServed
        );
        assert_eq!(
            decide_stream_access(ip("192.168.1.200"), &allowed, LOCAL_IP, true),
            StreamAccess::UnlistedRefused
        );
    }

    /// Loopback in both forms, and the host's own LAN address, which the desktop
    /// Server view offers with a copy button.
    #[test]
    fn this_machine_is_always_allowed() {
        for peer in ["127.0.0.1", "::1", "::ffff:127.0.0.1", LOCAL_IP] {
            assert_eq!(
                decide_stream_access(ip(peer), &[], LOCAL_IP, true),
                StreamAccess::CompanionHost,
                "{peer} is this machine"
            );
        }
    }

    /// A dual-stack listener reports an IPv4 client as an IPv4-mapped IPv6
    /// address; session addresses come out of the Sonos topology as plain IPv4
    /// strings. Comparing either side raw would refuse a real speaker.
    #[test]
    fn an_ipv4_mapped_peer_matches_its_plain_session_address() {
        assert_eq!(
            decide_stream_access(
                ip("::ffff:192.168.1.50"),
                &speakers(&["192.168.1.50"]),
                LOCAL_IP,
                true
            ),
            StreamAccess::Speaker
        );
    }

    /// An unparsable or empty entry must not match, and must not poison the list.
    #[test]
    fn unparsable_addresses_are_ignored_not_fatal() {
        let allowed = speakers(&["", "not-an-ip", "192.168.1.50"]);
        assert_eq!(
            decide_stream_access(ip("192.168.1.50"), &allowed, LOCAL_IP, true),
            StreamAccess::Speaker
        );
        assert_eq!(
            decide_stream_access(ip("192.168.1.60"), &allowed, "", true),
            StreamAccess::UnlistedRefused,
            "a companion that has not resolved its own address yet still refuses strangers"
        );
    }

    /// Promotion hands a slave the stream URL while its session still reads
    /// `Slave` and calls `play_uri` before re-recording it as coordinator, so the
    /// promoted speaker must already be on the list when that call lands.
    #[test]
    fn a_promoted_coordinator_is_allowed_when_play_uri_runs() {
        // What the session store holds at that instant: the old coordinator has
        // been torn down, the promoted speaker is still recorded as a slave.
        let allowed = speakers(&["192.168.1.51", "192.168.1.52"]);
        assert_eq!(
            decide_stream_access(ip("192.168.1.51"), &allowed, LOCAL_IP, true),
            StreamAccess::Speaker
        );
    }

    #[test]
    fn the_reader_cap_trips_and_frees_its_slots() {
        let state = test_stream_state();

        let slots: Vec<_> = (0..MAX_UNLISTED_STREAM_READERS)
            .map(|n| {
                state
                    .acquire_unlisted_reader()
                    .unwrap_or_else(|| panic!("reader {n} is within the cap"))
            })
            .collect();
        assert_eq!(state.unlisted_reader_count(), MAX_UNLISTED_STREAM_READERS);
        assert!(
            state.acquire_unlisted_reader().is_none(),
            "a harvested stream id must not fan out past the cap"
        );

        drop(slots);
        assert_eq!(
            state.unlisted_reader_count(),
            0,
            "a closed body frees its slot"
        );
        assert!(state.acquire_unlisted_reader().is_some());
    }

    /// A PCM stream on this machine's own address (192.168.2.169) and a
    /// speaker (192.168.2.50), each connected once before.
    fn pcm_stream_with_epochs(host: IpAddr, speaker: IpAddr) -> Arc<StreamState> {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            8,
            16,
            200,
            20,
        ));
        for ip in [host, speaker] {
            state.timing.start_new_epoch(None, Instant::now(), ip, None);
        }
        state
    }

    /// The field case: VLC on the desktop machine reconnected, and the resume
    /// sent a Sonos `Play` to the computer's own address, which failed. It is
    /// still a resume (prefill skipped, its epoch kept), but no `Play` goes
    /// out; a speaker reconnecting still gets one.
    #[test]
    fn a_companion_host_reconnect_sends_no_resume_play() {
        let host = ip("192.168.2.169");
        let speaker = ip("192.168.2.50");
        let state = pcm_stream_with_epochs(host, speaker);
        let speakers = speakers(&["192.168.2.50"]);

        let access = decide_stream_access(host, &speakers, "192.168.2.169", false);
        assert_eq!(access, StreamAccess::CompanionHost);
        let decision = decide_resume(access, &state, host);
        assert!(decision.is_resume, "a local player's reconnect is a resume");
        assert_eq!(decision.play_ip, None, "but this machine is sent no Play");
        // Loopback is this machine too.
        let loopback = ip("127.0.0.1");
        state
            .timing
            .start_new_epoch(None, Instant::now(), loopback, None);
        let access = decide_stream_access(loopback, &speakers, "192.168.2.169", false);
        assert_eq!(decide_resume(access, &state, loopback).play_ip, None);
    }

    #[test]
    fn a_speaker_reconnect_still_sends_resume_play() {
        let host = ip("192.168.2.169");
        let speaker = ip("192.168.2.50");
        let state = pcm_stream_with_epochs(host, speaker);
        let access = decide_stream_access(
            speaker,
            &speakers(&["192.168.2.50"]),
            "192.168.2.169",
            false,
        );
        assert_eq!(access, StreamAccess::Speaker);
        assert_eq!(
            decide_resume(access, &state, speaker),
            ResumeDecision {
                is_resume: true,
                play_ip: Some("192.168.2.50".to_string()),
            }
        );
        // Its first connection is no resume, and sends nothing.
        let fresh = ip("192.168.2.51");
        let access = decide_stream_access(
            fresh,
            &speakers(&["192.168.2.50", "192.168.2.51"]),
            "192.168.2.169",
            false,
        );
        assert_eq!(
            decide_resume(access, &state, fresh),
            ResumeDecision {
                is_resume: false,
                play_ip: None,
            }
        );
        // An unlisted reader never counts as resuming, epoch or not.
        let stranger = ip("192.168.2.99");
        state
            .timing
            .start_new_epoch(None, Instant::now(), stranger, None);
        let access = decide_stream_access(
            stranger,
            &speakers(&["192.168.2.50"]),
            "192.168.2.169",
            false,
        );
        assert_eq!(access, StreamAccess::UnlistedServed);
        assert!(!decide_resume(access, &state, stranger).is_resume);
    }

    /// The cap must never be able to refuse a device the stream is actually
    /// for. An unsynced cast legitimately has one reader per speaker, each
    /// routine reconnect double-counts until the replaced connection is reaped,
    /// and a refusal is dead air — so speakers and this host take no slot at
    /// all, which is also what stops an unlisted flood from starving them.
    #[test]
    fn allowlisted_readers_are_exempt_from_the_cap() {
        assert!(!StreamAccess::Speaker.draws_unlisted_budget());
        assert!(!StreamAccess::CompanionHost.draws_unlisted_budget());
        assert!(StreamAccess::UnlistedServed.draws_unlisted_budget());
        assert!(StreamAccess::Speaker.tracks_playback());
        assert!(StreamAccess::CompanionHost.tracks_playback());
        assert!(!StreamAccess::UnlistedServed.tracks_playback());
        assert!(!StreamAccess::UnlistedRefused.tracks_playback());
        assert!(StreamAccess::Speaker.monitors_playback());
        assert!(StreamAccess::Speaker.resumes_speaker());
        assert!(!StreamAccess::CompanionHost.resumes_speaker());
        assert!(!StreamAccess::UnlistedServed.resumes_speaker());
        assert!(!StreamAccess::UnlistedRefused.resumes_speaker());
        assert!(
            !StreamAccess::CompanionHost.monitors_playback(),
            "this machine is not a Sonos speaker and cannot be polled"
        );
        assert!(!StreamAccess::UnlistedServed.monitors_playback());

        // A stream whose unlisted budget is fully spent still admits speakers:
        // they never consult it.
        let state = test_stream_state();
        let _flood: Vec<_> = (0..MAX_UNLISTED_STREAM_READERS)
            .map(|_| state.acquire_unlisted_reader().expect("within the cap"))
            .collect();
        assert!(state.acquire_unlisted_reader().is_none());
        assert_eq!(
            decide_stream_access(
                ip("192.168.1.50"),
                &speakers(&["192.168.1.50"]),
                LOCAL_IP,
                false
            ),
            StreamAccess::Speaker,
            "a real speaker's fetch is unaffected by the unlisted budget"
        );
    }

    fn test_stream_state() -> Arc<StreamState> {
        Arc::new(StreamState::new(
            "test-stream".to_string(),
            AudioCodec::Aac,
            AudioFormat::default(),
            8,
            16,
            200,
            20,
        ))
    }

    fn test_ip() -> IpAddr {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    }

    fn hook_for(state: &Arc<StreamState>) -> EpochHook {
        EpochHook::new(Arc::downgrade(state), Instant::now(), test_ip())
    }

    #[tokio::test]
    async fn epoch_hook_stays_armed_until_the_first_real_frame() {
        let state = test_stream_state();
        let source = futures::stream::iter(vec![
            Err(std::io::Error::other("transient")),
            Ok(Bytes::new()),
            Ok(Bytes::from_static(b"audio")),
        ]);
        let mut body = Box::pin(with_epoch_hook(source, hook_for(&state), None));

        body.next().await.expect("error item").expect_err("error");
        assert!(
            state.timing.current_epoch_for(test_ip()).is_none(),
            "an error must not start an epoch"
        );

        body.next().await.expect("empty frame").expect("ok");
        assert!(
            state.timing.current_epoch_for(test_ip()).is_none(),
            "an empty frame must not start an epoch"
        );

        body.next().await.expect("audio frame").expect("ok");
        assert!(
            state.timing.current_epoch_for(test_ip()).is_some(),
            "the first real frame must start an epoch"
        );
    }

    #[tokio::test]
    async fn epoch_hook_anchors_to_the_first_served_frame() {
        let state = test_stream_state();
        let first_served = Instant::now() - Duration::from_millis(150);
        let source = futures::stream::iter(vec![Ok(Bytes::from_static(b"audio"))]);
        let mut body = Box::pin(with_epoch_hook(
            source,
            hook_for(&state),
            Some(first_served),
        ));

        body.next().await.expect("audio frame").expect("ok");
        let epoch = state
            .timing
            .current_epoch_for(test_ip())
            .expect("the first real frame starts an epoch");
        assert_eq!(epoch.audio_epoch, first_served);
    }

    /// Monitoring follows whoever fetches: the connection reaches the monitor
    /// when its first real frame starts its epoch, and not before, so the
    /// monitor never sees a connection it cannot time.
    #[tokio::test]
    async fn epoch_hook_registers_a_monitored_connection_once_its_epoch_starts() {
        use crate::stream::MonitorRegistrar;
        let state = test_stream_state();
        let (registrar, mut registrations) = MonitorRegistrar::channel();
        let tap = Arc::new(ConnectionTap::new(
            "test-stream",
            test_ip(),
            Instant::now(),
            AudioCodec::Aac,
            &AudioFormat::default(),
            Arc::new(ChainStats::new("test-stream", test_ip())),
            true,
        ));
        let hook = hook_for(&state).with_monitor(Arc::clone(&tap), registrar);
        let source =
            futures::stream::iter(vec![Ok(Bytes::new()), Ok(Bytes::from_static(b"audio"))]);
        let mut body = Box::pin(with_epoch_hook(source, hook, None));

        body.next().await.expect("empty frame").expect("ok");
        assert!(
            registrations.try_recv().is_err(),
            "no epoch, no registration"
        );

        body.next().await.expect("audio frame").expect("ok");
        let registered = registrations
            .try_recv()
            .expect("registered on the first real frame")
            .upgrade()
            .expect("the connection is still open");
        let epoch = state.timing.current_epoch_for(test_ip()).expect("epoch");
        assert_eq!(registered.epoch().map(|e| e.id), Some(epoch.id));
        assert!(state
            .timing
            .current_tap_for(test_ip())
            .is_some_and(|t| Arc::ptr_eq(&t, &tap)));
    }

    #[tokio::test]
    async fn epoch_hook_does_not_keep_the_stream_alive() {
        let state = test_stream_state();
        let weak = Arc::downgrade(&state);
        // Never yields audio, so the hook is still armed when the stream is removed.
        let source = futures::stream::iter(vec![Ok(Bytes::new()), Ok(Bytes::from_static(b"late"))]);
        let mut body = Box::pin(with_epoch_hook(source, hook_for(&state), None));

        body.next().await.expect("empty frame").expect("ok");
        drop(state);

        assert!(
            weak.upgrade().is_none(),
            "an armed epoch hook must not hold the coordinator's stream alive"
        );
        // The armed hook is simply discarded; frames still pass through.
        body.next().await.expect("late frame").expect("ok");
    }

    #[tokio::test]
    async fn icy_injection_passes_chunks_while_the_stream_lives() {
        let state = test_stream_state();
        let source = futures::stream::iter(vec![Ok(Bytes::from_static(b"aac-frame"))]);
        let mut body = Box::pin(with_icy_metadata(source, Arc::downgrade(&state)));

        let chunk = body.next().await.expect("chunk").expect("ok");
        assert_eq!(chunk.as_ref(), b"aac-frame");
    }

    #[tokio::test]
    async fn icy_injection_ends_the_body_when_the_stream_is_removed() {
        let state = test_stream_state();
        let weak = Arc::downgrade(&state);
        let source = futures::stream::iter(vec![Ok(Bytes::from_static(b"aac-frame"))]);
        let mut body = Box::pin(with_icy_metadata(source, weak.clone()));

        drop(state);
        assert!(weak.upgrade().is_none());
        assert!(
            body.next().await.is_none(),
            "the body must end once the stream is gone"
        );
    }

    /// The compressed-codec body as it is assembled in `stream_audio`: dropping the
    /// coordinator's `Arc` must close the broadcast channel and end the response body.
    #[tokio::test]
    async fn compressed_body_ends_when_the_coordinator_drops_the_stream() {
        let state = test_stream_state();
        let (_, rx) = state.subscribe();
        let weak = Arc::downgrade(&state);

        let live = BroadcastStream::new(rx).map(|res| match res {
            Ok(frame) => Ok(frame),
            Err(BroadcastStreamRecvError::Lagged(n)) => Err(lagged_error(n)),
        });
        let mut body = Box::pin(with_icy_metadata(
            with_epoch_hook(live, hook_for(&state), None),
            weak.clone(),
        ));

        drop(state);

        assert!(
            weak.upgrade().is_none(),
            "the response body must not hold a strong reference to the stream"
        );
        assert!(
            body.next().await.is_none(),
            "the body must end when the stream's broadcast sender is dropped"
        );
    }

    /// Every item a PCM body yields before time moves on: the WAV header,
    /// the connect burst and the metronome's immediate first tick.
    async fn ready_now(body: &mut AudioStream) -> Vec<Bytes> {
        std::future::poll_fn(|cx| {
            let mut items = Vec::new();
            while let std::task::Poll::Ready(Some(item)) = body.as_mut().poll_next(cx) {
                items.push(item.expect("ok"));
            }
            std::task::Poll::Ready(items)
        })
        .await
    }

    /// One PCM connection assembled as `stream_audio` assembles it (subscribe,
    /// cadence body with the burst, WAV header, delivery record), with a
    /// monitored tap. Returns the body and the tap.
    fn pcm_connection(
        state: &Arc<StreamState>,
        remote: IpAddr,
        burst_ms: u64,
    ) -> (AudioStream, Arc<ConnectionTap>) {
        pcm_connection_with_drift(state, remote, burst_ms, DriftMode::Off, None)
    }

    /// [`pcm_connection`] made under drift correction `drift`, with the
    /// adapter forced to `forced` ppm when given.
    fn pcm_connection_with_drift(
        state: &Arc<StreamState>,
        remote: IpAddr,
        burst_ms: u64,
        drift: DriftMode,
        forced: Option<f64>,
    ) -> (AudioStream, Arc<ConnectionTap>) {
        use crate::stream::MonitorRegistrar;
        let is_resume = state.timing.current_epoch_for(remote).is_some();
        let (prefill, rx) = state.subscribe();
        let guard = Arc::new(LoggingStreamGuard::new(state.id.clone(), remote));
        let stats =
            ChainStats::for_connection(state.id.clone(), &guard, pcm_header(AudioCodec::Pcm));
        let tap = Arc::new(
            ConnectionTap::new(
                state.id.clone(),
                remote,
                Instant::now(),
                AudioCodec::Pcm,
                &state.audio_format,
                Arc::clone(&stats),
                true,
            )
            .with_drift(
                drift,
                connection_rate_control(drift, AudioCodec::Pcm, &state.audio_format, forced),
            )
            .with_connection(Arc::clone(&guard)),
        );
        let (registrar, _registrations) = MonitorRegistrar::channel();
        let hook = EpochHook::new(Arc::downgrade(state), Instant::now(), remote)
            .with_monitor(Arc::clone(&tap), registrar);
        let cadence = pcm_cadence_stream(
            state,
            burst_ms,
            prefill,
            rx,
            stats,
            Some(hook),
            Some(&tap),
            remote,
            is_resume,
        );
        let format = state.audio_format;
        let header = crate::stream::create_wav_header(
            format.sample_rate,
            format.channels,
            format.bits_per_sample,
        );
        let body =
            futures::StreamExt::chain(futures::stream::once(async move { Ok(header) }), cadence);
        let body: AudioStream = Box::pin(with_delivery_record(body, guard, Arc::clone(&tap)));
        (body, tap)
    }

    /// Pushes frames `from..to`, each a 10 ms PCM frame filled with its
    /// index, and returns their capture times.
    fn push_tagged(state: &StreamState, from: u8, to: u8) -> Vec<Instant> {
        (from..to)
            .map(|i| {
                state.push_frame(Bytes::from(vec![i; state.audio_format.frame_bytes(10)]));
                Instant::now()
            })
            .collect()
    }

    /// A speaker's first connection and its reconnect each get the full
    /// connect burst ahead of real-time pacing, each epoch is anchored to that
    /// connection's first burst frame, and the delivered-audio count the
    /// speaker monitor reads its reserve from includes the burst.
    #[tokio::test(start_paused = true)]
    async fn pcm_connection_and_its_reconnect_each_get_the_burst() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        let remote = ip("192.168.1.50");
        push_tagged(&state, 0, 100);

        // First connection: 100 frames in the ring, 50 burst (30..80), 20
        // queued (80..100), the first of which goes out on the first tick.
        let (mut body, tap) = pcm_connection(&state, remote, 500);
        let items = ready_now(&mut body).await;
        assert_eq!(items.len(), 1 + 50 + 1, "header, burst and first tick");
        assert_eq!(items[0].len(), 44, "the WAV header comes first");
        let tags: Vec<u8> = items[1..].iter().map(|f| f[0]).collect();
        assert_eq!(
            tags,
            (30..81).collect::<Vec<u8>>(),
            "in order, no gap or repeat"
        );
        assert_eq!(
            tap.delivered_ms(),
            Some(510),
            "the burst counts as delivered"
        );
        let first = state.timing.current_epoch_for(remote).expect("epoch");
        assert_eq!(tap.epoch().map(|e| e.id), Some(first.id));
        drop(body);
        drop(tap);

        // The speaker reconnects (a resume: it already has an epoch) after 20
        // more frames. It gets the burst again, from the newest frames.
        let times = push_tagged(&state, 100, 120);
        assert!(state.timing.current_epoch_for(remote).is_some());
        let (prefill_first, _rx) = state.subscribe();
        let first_burst_at = prefill_first[prefill_first.len() - 70].captured_at;
        assert!(first_burst_at < times[0]);

        let (mut body, tap) = pcm_connection(&state, remote, 500);
        let items = ready_now(&mut body).await;
        assert_eq!(items.len(), 1 + 50 + 1);
        let tags: Vec<u8> = items[1..].iter().map(|f| f[0]).collect();
        assert_eq!(tags, (50..101).collect::<Vec<u8>>());
        assert_eq!(tap.delivered_ms(), Some(510));
        let second = state.timing.current_epoch_for(remote).expect("epoch");
        assert!(second.id > first.id, "the reconnect starts its own epoch");
        assert_eq!(second.audio_epoch, first_burst_at);
    }

    /// A first connection waits until the ring holds the jitter buffer plus
    /// the burst, allowing for how long the stream has already been running,
    /// and never less than the jitter buffer.
    #[test]
    fn pcm_prefill_delay_fills_the_ring_for_jitter_and_burst() {
        let ms = Duration::from_millis;
        assert_eq!(pcm_prefill_delay(200, 500, Some(ms(100))), ms(600));
        assert_eq!(pcm_prefill_delay(200, 500, Some(ms(650))), ms(200));
        assert_eq!(pcm_prefill_delay(200, 500, Some(ms(5000))), ms(200));
        assert_eq!(pcm_prefill_delay(200, 500, None), ms(700));
        assert_eq!(
            pcm_prefill_delay(200, 0, Some(ms(10))),
            ms(200),
            "burst off"
        );
        assert_eq!(pcm_prefill_delay(0, 0, None), Duration::ZERO);
    }

    /// The wait is not capped: it follows the smoothing and the configured
    /// head start up to the head start's 2000 ms maximum, so a field test
    /// can find out what a speaker accepts.
    #[test]
    fn prefill_wait_follows_smoothing_and_head_start_up_to_2000ms() {
        let ms = Duration::from_millis;
        assert_eq!(pcm_prefill_delay(200, 1000, Some(ms(100))), ms(1100));
        assert_eq!(pcm_prefill_delay(300, 2000, Some(ms(100))), ms(2200));
        assert_eq!(pcm_prefill_delay(1000, 2000, None), ms(3000));
        assert_eq!(pcm_prefill_delay(300, 2000, Some(ms(4000))), ms(300));
    }

    /// The tap records the head start the ring allowed beside the one
    /// configured: all of it with a full ring, only what the ring held
    /// beyond the jitter buffer otherwise.
    #[tokio::test(start_paused = true)]
    async fn head_start_recorded_is_what_the_ring_allowed() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        // 45 frames: 20 for the jitter buffer, 25 (250 ms) for the burst.
        push_tagged(&state, 0, 45);
        let (_body, tap) = pcm_connection(&state, ip("192.168.1.50"), 500);
        let head_start = tap.head_start().expect("recorded");
        assert_eq!(head_start, HeadStart::new(250, 500));
        assert!(!head_start.is_full());

        push_tagged(&state, 45, 100);
        let (_body, tap) = pcm_connection(&state, ip("192.168.1.51"), 500);
        let head_start = tap.head_start().expect("recorded");
        assert_eq!(head_start, HeadStart::new(500, 500));
        assert!(head_start.is_full());

        let (_body, tap) = pcm_connection(&state, ip("192.168.1.52"), 0);
        assert_eq!(tap.head_start(), Some(HeadStart::new(0, 0)));
    }

    /// Only a PCM connection made with drift correction on, in a format the
    /// adapter takes, gets a rate control; observing or off, the cadence
    /// builds no adapter and every frame, burst included, is the captured
    /// buffer itself.
    #[tokio::test(start_paused = true)]
    async fn drift_on_engages_an_adapter_and_observe_sends_the_captured_frames() {
        let pcm = AudioFormat::default();
        let control =
            |mode, codec, fmt: &AudioFormat| connection_rate_control(mode, codec, fmt, None);
        assert!(control(DriftMode::On, AudioCodec::Pcm, &pcm).is_some());
        assert!(control(DriftMode::Observe, AudioCodec::Pcm, &pcm).is_none());
        assert!(control(DriftMode::Off, AudioCodec::Pcm, &pcm).is_none());
        assert!(control(DriftMode::On, AudioCodec::Flac, &pcm).is_none());
        let wide = AudioFormat::new(48_000, 2, 24);
        assert!(control(DriftMode::On, AudioCodec::Pcm, &wide).is_none());
        assert_eq!(
            control(DriftMode::On, AudioCodec::Pcm, &pcm).and_then(|c| c.forced_ppm()),
            None,
            "unset forces nothing"
        );

        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        push_tagged(&state, 0, 100);

        let (mut body, tap) =
            pcm_connection_with_drift(&state, ip("192.168.1.50"), 500, DriftMode::Observe, None);
        assert!(tap.rate_control().is_none());
        assert_eq!(tap.drift_mode(), DriftMode::Observe);
        let items = ready_now(&mut body).await;
        let tags: Vec<u8> = items[1..].iter().map(|f| f[0]).collect();
        assert_eq!(tags, (30..81).collect::<Vec<u8>>(), "the captured frames");
        assert_eq!(tap.net_inserted_ms(), None);
        drop(body);

        let (mut body, tap) =
            pcm_connection_with_drift(&state, ip("192.168.1.51"), 500, DriftMode::On, None);
        let control = Arc::clone(tap.rate_control().expect("a rate control"));
        assert!(!control.is_engaged(), "until the cadence body runs");
        let items = ready_now(&mut body).await;
        assert_eq!(items.len(), 1 + 50 + 1);
        assert!(control.is_engaged());
        assert_eq!(tap.net_inserted_ms(), Some(0.0));
    }

    /// THAUMIC_DRIFT_FORCE_PPM engages the adapter at exactly its rate on
    /// every PCM connection, whatever the drift mode, and no controller
    /// write moves it; a compressed connection or a format the adapter
    /// cannot take is left alone.
    #[tokio::test(start_paused = true)]
    async fn a_forced_rate_engages_the_adapter_in_every_mode() {
        let pcm = AudioFormat::default();
        for mode in [DriftMode::Off, DriftMode::Observe, DriftMode::On] {
            let control = connection_rate_control(mode, AudioCodec::Pcm, &pcm, Some(150.0))
                .expect("a forced rate control");
            assert_eq!(control.forced_ppm(), Some(150.0), "{mode}");
            control.set_ppm(0.0);
            assert_eq!(control.command_ppm(), 150.0, "{mode}");
        }
        assert!(
            connection_rate_control(DriftMode::Off, AudioCodec::Flac, &pcm, Some(150.0)).is_none()
        );
        let wide = AudioFormat::new(48_000, 2, 24);
        assert!(
            connection_rate_control(DriftMode::On, AudioCodec::Pcm, &wide, Some(150.0)).is_none()
        );

        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        push_tagged(&state, 0, 100);
        for (i, mode) in [DriftMode::Off, DriftMode::Observe, DriftMode::On]
            .into_iter()
            .enumerate()
        {
            let remote = IpAddr::from([192, 168, 1, 60 + i as u8]);
            let (mut body, tap) =
                pcm_connection_with_drift(&state, remote, 500, mode, Some(-150.0));
            assert_eq!(tap.drift_mode(), mode);
            let control = Arc::clone(tap.rate_control().expect("a rate control"));
            let items = ready_now(&mut body).await;
            assert!(items.len() > 1);
            assert!(control.is_engaged(), "{mode}");
            assert_eq!(control.command_ppm(), -150.0, "{mode}");
            assert!(tap.net_inserted_ms().is_some(), "{mode}");
        }
    }

    /// A speaker fetching 100 ms after the stream's first frame, as a fresh
    /// cast's first GET does, still gets the whole burst: the prefill delay
    /// waits for the ring to hold it as well as the jitter buffer.
    #[tokio::test(start_paused = true)]
    async fn first_connection_soon_after_the_first_frame_gets_the_full_burst() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        let producer_state = Arc::clone(&state);
        let producer = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_millis(10));
            for i in 0..=255u8 {
                ticks.tick().await;
                push_tagged(&producer_state, i, i + 1);
            }
        });
        tokio::task::yield_now().await;
        let first_frame = tokio::time::Instant::now();

        tokio::time::sleep(Duration::from_millis(100)).await;
        let delay = pcm_prefill_delay(200, 500, Some(first_frame.elapsed()));
        assert_eq!(delay, Duration::from_millis(600));
        tokio::time::sleep(delay).await;

        let (mut body, tap) = pcm_connection(&state, ip("192.168.1.50"), 500);
        let items = ready_now(&mut body).await;
        assert_eq!(
            items.len(),
            1 + 50 + 1,
            "header, the whole burst and first tick"
        );
        assert_eq!(tap.delivered_ms(), Some(510));
        producer.abort();
    }

    /// Dropping the body marks it closed, which stops the speaker monitor
    /// reading a socket handle that may be reused.
    #[test]
    fn dropping_the_body_marks_it_closed() {
        let guard = Arc::new(LoggingStreamGuard::new("s".into(), test_ip()));
        let body = with_delivery_record(futures::stream::empty(), Arc::clone(&guard), ());
        assert!(!guard.body_closed());
        drop(body);
        assert!(guard.body_closed());
    }

    /// The new-connection line names the HTTP version, the framing and the
    /// declared length, and a Range request gets the same line with its range.
    #[test]
    fn the_connection_line_says_how_the_body_is_framed() {
        let pcm = connection_line(
            ip("192.168.1.50"),
            "s1",
            None,
            AudioCodec::Pcm,
            Version::HTTP_11,
            BodyFraming::Length(4_294_967_295),
            None,
        );
        assert_eq!(
            pcm,
            "[Stream] New connection: client=192.168.1.50, stream=s1, codec=Pcm, \
             http=HTTP/1.1, framing=length, declared_len=4294967295"
        );
        let ranged = connection_line(
            ip("192.168.1.50"),
            "s1",
            None,
            AudioCodec::Flac,
            Version::HTTP_10,
            BodyFraming::Close,
            Some("bytes=0-"),
        );
        assert_eq!(
            ranged,
            "[Stream] New connection: client=192.168.1.50, stream=s1, codec=Flac, \
             http=HTTP/1.0, framing=close, declared_len=none, range='bytes=0-'"
        );
    }

    /// A fetch of `live/{n}.wav` says which segment it asked for.
    #[test]
    fn the_connection_line_names_the_segment_asked_for() {
        let line = connection_line(
            ip("192.168.1.50"),
            "s1",
            Some(3),
            AudioCodec::Pcm,
            Version::HTTP_11,
            BodyFraming::Chunked,
            Some("bytes=1000-"),
        );
        assert_eq!(
            line,
            "[Stream] New connection: client=192.168.1.50, stream=s1, segment=3, codec=Pcm, \
             http=HTTP/1.1, framing=chunked, declared_len=none, range='bytes=1000-'"
        );
    }

    /// A guard with no framing recorded counts wire bytes as payload.
    #[tokio::test]
    async fn without_framing_wire_bytes_are_the_payload() {
        let guard = Arc::new(LoggingStreamGuard::new("s".into(), test_ip()));
        let items = futures::stream::iter(vec![Ok(Bytes::from(vec![1u8; 1000]))]);
        let mut body = Box::pin(with_delivery_record(items, Arc::clone(&guard), ()));
        while body.next().await.is_some() {}
        assert_eq!(guard.wire_bytes(), 1000);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerShutdown);
    }

    /// Where a loopback test's server hands back the connection's guard.
    type GuardSlot = Arc<parking_lot::Mutex<Option<Arc<LoggingStreamGuard>>>>;

    /// Serves `items` once on loopback through axum and hyper, framed the way
    /// `stream_audio` frames a body: the framing is worked out from the
    /// request's HTTP version and `pcm` (the PCM switches, `None` for a
    /// compressed codec), recorded on the guard, its headers are set, and a
    /// server cap, if any, is applied. Returns the address and where the guard
    /// appears once the request arrives.
    async fn serve_once(
        items: AudioStream,
        pcm: Option<PcmHttpSettings>,
    ) -> (SocketAddr, GuardSlot) {
        let items = Arc::new(parking_lot::Mutex::new(Some(items)));
        let slot: GuardSlot = Arc::default();
        let handler_slot = Arc::clone(&slot);
        let app = axum::Router::new().route(
            "/",
            axum::routing::get(move |version: Version| {
                let items = items.lock().take().expect("one request per test");
                let slot = Arc::clone(&handler_slot);
                async move {
                    let response_framing = ResponseFraming::new(version, pcm.as_ref());
                    let guard = Arc::new(
                        LoggingStreamGuard::new("s".into(), test_ip())
                            .with_framing(response_framing.framing),
                    );
                    *slot.lock() = Some(Arc::clone(&guard));
                    let items = with_optional_server_cap(items, pcm.as_ref(), &guard);
                    response_head("audio/wav", false, response_framing)
                        .body(Body::from_stream(with_delivery_record(items, guard, ())))
                        .expect("response")
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let addr = listener.local_addr().expect("address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        (addr, slot)
    }

    /// Sends `request` and reads the response head, returning the connection,
    /// the head and whatever body bytes arrived with it.
    async fn request(addr: SocketAddr, request: &str) -> (tokio::net::TcpStream, String, Vec<u8>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut conn = tokio::net::TcpStream::connect(addr).await.expect("connect");
        conn.write_all(request.as_bytes()).await.expect("send");
        let mut received = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            if let Some(end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                let body = received.split_off(end + 4);
                let head = String::from_utf8(received).expect("ascii head");
                return (conn, head.to_ascii_lowercase(), body);
            }
            let n = conn.read(&mut buf).await.expect("read head");
            assert!(n > 0, "connection closed before the head");
            received.extend_from_slice(&buf[..n]);
        }
    }

    /// Reads until `done` says the body is complete or the peer closes.
    async fn read_body(
        conn: &mut tokio::net::TcpStream,
        mut body: Vec<u8>,
        done: impl Fn(&[u8]) -> bool,
    ) -> Vec<u8> {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 8192];
        while !done(&body) {
            match conn.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => body.extend_from_slice(&buf[..n]),
            }
        }
        body
    }

    /// Waits for the server to drop the body, and returns its guard.
    async fn closed_guard(slot: &GuardSlot) -> Arc<LoggingStreamGuard> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(guard) = slot.lock().as_ref().filter(|g| g.body_closed()) {
                    return Arc::clone(guard);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the server drops the body")
    }

    /// Items of these sizes, then the end of the stream.
    fn finite_items(sizes: &[usize]) -> AudioStream {
        let items: Vec<FrameResult> = sizes
            .iter()
            .map(|&n| Ok(Bytes::from(vec![7u8; n])))
            .collect();
        Box::pin(futures::stream::iter(items))
    }

    /// PCM switches for `length` framing declaring `len` bytes.
    fn pcm_length(len: u64) -> PcmHttpSettings {
        PcmHttpSettings {
            framing: PcmHttpFraming::Length,
            content_length: len,
            // A declared length fixes the connection's end: no segments.
            segments: false,
            ..PcmHttpSettings::default()
        }
    }

    /// PCM switches for `framing`, with nothing else changed.
    fn pcm_framed(framing: PcmHttpFraming) -> PcmHttpSettings {
        PcmHttpSettings {
            framing,
            ..PcmHttpSettings::default()
        }
    }

    /// An endless body of 1000-byte items.
    fn endless_items() -> AudioStream {
        Box::pin(futures::stream::repeat_with(|| {
            Ok(Bytes::from(vec![7u8; 1000]))
        }))
    }

    /// With a declared length hyper stops the body once that many bytes are
    /// written, though the stream would go on, and drops it without error.
    /// That is an end at the length, not the client hanging up, and the
    /// wire carried exactly the length though the last item counted in full.
    #[tokio::test]
    async fn a_body_stopped_at_its_declared_length_ends_by_length() {
        let (addr, slot) = serve_once(endless_items(), Some(pcm_length(4096))).await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        assert!(head.contains("content-length: 4096"), "{head}");
        let body = read_body(&mut conn, body, |b| b.len() >= 4096).await;
        assert_eq!(body.len(), 4096);

        // The connection is kept alive; the body is dropped all the same.
        let guard = closed_guard(&slot).await;
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::Length);
        assert_eq!(guard.wire_bytes(), 4096);
        assert!(guard.bytes_sent.load(std::sync::atomic::Ordering::Relaxed) >= 4096);
        drop(conn);
    }

    /// Chunked framing adds each chunk's hex length and two CRLFs, and a
    /// terminating chunk when the stream ends on our side: the guard's wire
    /// bytes match what arrived byte for byte, and the end is ours.
    #[tokio::test]
    async fn a_chunked_body_counts_its_framing_and_ends_by_the_server() {
        let (addr, slot) = serve_once(finite_items(&[1000, 1000, 44, 7]), None).await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        assert!(head.contains("transfer-encoding: chunked"), "{head}");
        let body = read_body(&mut conn, body, |b| b.ends_with(b"0\r\n\r\n")).await;

        let guard = closed_guard(&slot).await;
        assert_eq!(
            guard.bytes_sent.load(std::sync::atomic::Ordering::Relaxed),
            2051
        );
        assert_eq!(guard.wire_bytes(), body.len() as u64);
        assert_eq!(body.len(), 2051 + 2 * (3 + 4) + (2 + 4) + (1 + 4) + 5);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerShutdown);
    }

    /// An HTTP/1.0 client is answered as HTTP/1.0 with a close-delimited
    /// body, which carries the payload alone.
    #[tokio::test]
    async fn an_http10_client_gets_a_close_delimited_body() {
        let (addr, slot) = serve_once(finite_items(&[1000, 1000, 44, 7]), None).await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.0\r\n\r\n").await;
        assert!(head.starts_with("http/1.0 200"), "{head}");
        assert!(!head.contains("transfer-encoding"), "{head}");
        assert!(!head.contains("content-length"), "{head}");
        let body = read_body(&mut conn, body, |_| false).await;

        let guard = closed_guard(&slot).await;
        assert_eq!(body.len(), 2051);
        assert_eq!(guard.wire_bytes(), 2051);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerShutdown);
    }

    /// A client that hangs up mid-stream is the client ending it.
    #[tokio::test]
    async fn a_client_that_hangs_up_ends_by_client() {
        let (addr, slot) = serve_once(endless_items(), None).await;
        let (mut conn, _head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        read_body(&mut conn, body, |b| b.len() >= 10_000).await;
        drop(conn);

        let guard = closed_guard(&slot).await;
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::Client);
    }

    /// A body that yields an error is aborted, and says so.
    #[tokio::test]
    async fn a_body_that_fails_ends_by_error() {
        let items: Vec<FrameResult> = vec![
            Ok(Bytes::from(vec![7u8; 1000])),
            Err(std::io::Error::other("lagged")),
        ];
        let (addr, slot) = serve_once(Box::pin(futures::stream::iter(items)), None).await;
        // hyper may abort before the head is even flushed, so read raw.
        let mut conn = tokio::net::TcpStream::connect(addr).await.expect("connect");
        tokio::io::AsyncWriteExt::write_all(&mut conn, b"GET / HTTP/1.1\r\nHost: t\r\n\r\n")
            .await
            .expect("send");
        read_body(&mut conn, Vec::new(), |_| false).await;

        let guard = closed_guard(&slot).await;
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::Error);
    }

    /// The headers, in order, that `stream_audio` gives a response for a
    /// framing (without ICY metadata), read off a built response.
    fn framing_headers(framing: ResponseFraming) -> (Version, Vec<(String, String)>) {
        head_headers(AudioCodec::Pcm, false, framing)
    }

    /// The version and headers, in order, of the head `stream_audio` builds.
    fn head_headers(
        codec: AudioCodec,
        wants_icy: bool,
        framing: ResponseFraming,
    ) -> (Version, Vec<(String, String)>) {
        let response = response_head(codec.mime_type(), wants_icy, framing)
            .body(Body::empty())
            .expect("response");
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
            .collect();
        (response.version(), headers)
    }

    /// `(name, value)` pairs as owned strings, to compare with a head.
    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// With no switch set PCM declares no length, like a compressed codec,
    /// so hyper sends it chunked on a keep-alive connection, and the other
    /// headers keep their order.
    #[test]
    fn by_default_no_codec_declares_a_length() {
        let pcm = ResponseFraming::new(Version::HTTP_11, Some(&PcmHttpSettings::default()));
        assert_eq!(pcm.framing, BodyFraming::Chunked);
        assert_eq!(pcm.content_length, None);
        let (version, headers) = head_headers(AudioCodec::Pcm, false, pcm);
        assert_eq!(version, Version::HTTP_11);
        assert_eq!(
            headers,
            pairs(&[
                ("content-type", "audio/wav"),
                ("cache-control", "no-cache"),
                ("connection", "keep-alive"),
                ("transfermode.dlna.org", "Streaming"),
                ("icy-name", APP_NAME),
            ])
        );
        assert_eq!(
            ResponseFraming::new(Version::HTTP_10, Some(&PcmHttpSettings::default())).framing,
            BodyFraming::Close,
            "an HTTP/1.0 client gets a close-delimited body"
        );

        let compressed = ResponseFraming::new(Version::HTTP_11, None);
        assert_eq!(compressed.framing, BodyFraming::Chunked);
        let (_, headers) = head_headers(AudioCodec::Mp3, true, compressed);
        assert_eq!(
            headers,
            pairs(&[
                ("content-type", "audio/mpeg"),
                ("cache-control", "no-cache"),
                ("connection", "keep-alive"),
                ("transfermode.dlna.org", "Streaming"),
                ("icy-name", APP_NAME),
                ("icy-metaint", &ICY_METAINT.to_string()),
            ])
        );
        assert_eq!(
            ResponseFraming::new(Version::HTTP_10, None).framing,
            BodyFraming::Close
        );
    }

    /// Explicit `length` framing still serves PCM as it was served before
    /// chunked, header for header and in the same order: a 4294967295-byte
    /// Content-Length, last, on a keep-alive connection.
    #[test]
    fn explicit_length_framing_declares_the_largest_length() {
        let pcm = ResponseFraming::new(Version::HTTP_11, Some(&pcm_framed(PcmHttpFraming::Length)));
        assert_eq!(pcm.framing, BodyFraming::Length(4_294_967_295));
        let (version, headers) = head_headers(AudioCodec::Pcm, false, pcm);
        assert_eq!(version, Version::HTTP_11);
        assert_eq!(
            headers,
            pairs(&[
                ("content-type", "audio/wav"),
                ("cache-control", "no-cache"),
                ("connection", "keep-alive"),
                ("transfermode.dlna.org", "Streaming"),
                ("icy-name", APP_NAME),
                ("content-length", "4294967295"),
            ])
        );
    }

    /// `length` framing declares the length it is given; `chunked` declares
    /// none; `close` answers as HTTP/1.0 with `Connection: close`, except to
    /// an HTTP/2 request, which has no close-delimited body.
    #[test]
    fn each_pcm_framing_sets_its_own_headers() {
        let length = ResponseFraming::new(Version::HTTP_11, Some(&pcm_length(10_485_760)));
        assert_eq!(length.framing, BodyFraming::Length(10_485_760));
        assert!(framing_headers(length)
            .1
            .contains(&("content-length".to_string(), "10485760".to_string())));

        let chunked =
            ResponseFraming::new(Version::HTTP_11, Some(&pcm_framed(PcmHttpFraming::Chunked)));
        assert_eq!(chunked.framing, BodyFraming::Chunked);
        let (_, headers) = framing_headers(chunked);
        assert!(headers.contains(&("connection".to_string(), "keep-alive".to_string())));
        assert!(!headers.iter().any(|(k, _)| k == "content-length"));

        let close =
            ResponseFraming::new(Version::HTTP_11, Some(&pcm_framed(PcmHttpFraming::Close)));
        assert_eq!(close.framing, BodyFraming::Close);
        let (version, headers) = framing_headers(close);
        assert_eq!(version, Version::HTTP_10);
        assert!(headers.contains(&("connection".to_string(), "close".to_string())));
        assert!(!headers.iter().any(|(k, _)| k == "content-length"));
        assert!(!headers
            .iter()
            .any(|(k, v)| k == "connection" && v == "keep-alive"));

        let h2 = ResponseFraming::new(Version::HTTP_2, Some(&pcm_framed(PcmHttpFraming::Close)));
        assert_eq!(h2.framing, BodyFraming::Http2);
        assert!(!h2.close);
    }

    /// A default PCM body, WAV header first, as `stream_audio` builds it.
    fn default_pcm_items() -> AudioStream {
        let header = crate::stream::create_wav_header_with_data_size(
            48_000,
            2,
            16,
            PcmHttpSettings::default().wav_data_size,
        );
        Box::pin(futures::stream::once(async move { Ok(header) }).chain(finite_items(&[1920; 3])))
    }

    /// With no switch set a PCM response is chunked with no Content-Length,
    /// and the WAV header in its first chunk declares 0xFFFFFFFF in both size
    /// fields: the combination a Playbar plays past 2^31 bytes, up to the
    /// header's 4 GiB length.
    #[tokio::test]
    async fn default_pcm_is_chunked_with_a_max_length_wav_header() {
        let (addr, slot) = serve_once(default_pcm_items(), Some(PcmHttpSettings::default())).await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        assert!(head.starts_with("http/1.1 200"), "{head}");
        assert!(head.contains("transfer-encoding: chunked"), "{head}");
        assert!(!head.contains("content-length"), "{head}");
        let body = read_body(&mut conn, body, |b| b.ends_with(b"0\r\n\r\n")).await;

        // The first chunk is the 44-byte (0x2C) header.
        assert!(body.starts_with(b"2C\r\nRIFF"), "{:?}", &body[..8]);
        let header = &body[4..48];
        assert_eq!(&header[36..40], b"data");
        assert_eq!(header[4..8], [0xFF; 4], "RIFF size");
        assert_eq!(header[40..44], [0xFF; 4], "data size");

        let guard = closed_guard(&slot).await;
        assert_eq!(guard.wire_bytes(), body.len() as u64);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerShutdown);
    }

    /// With no switch set an HTTP/1.0 client still gets PCM, answered as
    /// HTTP/1.0 with neither a length nor chunking: hyper ends the body by
    /// closing the connection.
    #[tokio::test]
    async fn default_pcm_to_an_http10_client_is_close_delimited() {
        let (addr, slot) = serve_once(default_pcm_items(), Some(PcmHttpSettings::default())).await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.0\r\n\r\n").await;
        assert!(head.starts_with("http/1.0 200"), "{head}");
        assert!(!head.contains("transfer-encoding"), "{head}");
        assert!(!head.contains("content-length"), "{head}");
        let body = tokio::time::timeout(
            Duration::from_secs(5),
            read_body(&mut conn, body, |_| false),
        )
        .await
        .expect("the server closes the connection");
        assert_eq!(body.len(), 44 + 3 * 1920);
        assert_eq!(&body[..4], b"RIFF");

        let guard = closed_guard(&slot).await;
        assert_eq!(guard.wire_bytes(), body.len() as u64);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerShutdown);
    }

    /// Chunked PCM has no length and so no end of its own: the body goes on
    /// well past where a declared length would have stopped it, and its wire
    /// bytes count the chunk framing.
    #[tokio::test]
    async fn chunked_pcm_is_sent_chunked_with_no_end() {
        let (addr, slot) =
            serve_once(endless_items(), Some(pcm_framed(PcmHttpFraming::Chunked))).await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        assert!(head.contains("transfer-encoding: chunked"), "{head}");
        assert!(!head.contains("content-length"), "{head}");
        assert!(head.contains("connection: keep-alive"), "{head}");
        let body = read_body(&mut conn, body, |b| b.len() > 3 * 4096).await;
        assert!(
            body.len() > 3 * 4096,
            "the body ended after {} bytes",
            body.len()
        );
        drop(conn);

        let guard = closed_guard(&slot).await;
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::Client);
        let payload = guard.bytes_sent.load(std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            guard.wire_bytes(),
            payload + payload / 1000 * (3 + 4),
            "each 1000-byte chunk costs 3 hex digits and two CRLFs"
        );
    }

    /// Close framing answers even an HTTP/1.1 client as HTTP/1.0, says
    /// `Connection: close` rather than keep-alive, declares neither a length
    /// nor chunking, and ends the body by closing the connection.
    #[tokio::test]
    async fn close_framed_pcm_is_http10_and_ends_by_closing() {
        let (addr, slot) = serve_once(
            finite_items(&[1000, 1000, 44, 7]),
            Some(pcm_framed(PcmHttpFraming::Close)),
        )
        .await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        assert!(head.starts_with("http/1.0 200"), "{head}");
        assert!(head.contains("connection: close"), "{head}");
        assert!(!head.contains("keep-alive"), "{head}");
        assert!(!head.contains("transfer-encoding"), "{head}");
        assert!(!head.contains("content-length"), "{head}");
        let body = tokio::time::timeout(
            Duration::from_secs(5),
            read_body(&mut conn, body, |_| false),
        )
        .await
        .expect("the server closes the connection");
        assert_eq!(body.len(), 2051);

        let guard = closed_guard(&slot).await;
        assert_eq!(guard.wire_bytes(), 2051);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerShutdown);
    }

    /// A server cap on chunked PCM cuts the item that reaches it short and
    /// ends the body with a last zero-length chunk, and the end is logged as
    /// the cap's.
    #[tokio::test]
    async fn a_server_cap_ends_a_chunked_body_cleanly() {
        let pcm = PcmHttpSettings {
            end_after_bytes: Some(2500),
            ..pcm_framed(PcmHttpFraming::Chunked)
        };
        let (addr, slot) = serve_once(endless_items(), Some(pcm)).await;
        let (mut conn, head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        assert!(head.contains("transfer-encoding: chunked"), "{head}");
        let body = tokio::time::timeout(
            Duration::from_secs(5),
            read_body(&mut conn, body, |b| b.ends_with(b"0\r\n\r\n")),
        )
        .await
        .expect("the body ends");
        assert_eq!(body.len(), 2500 + 2 * (3 + 4) + (3 + 4) + 5);
        assert!(
            body.windows(5).any(|w| w == b"1F4\r\n"),
            "the last item is cut to 500 bytes"
        );

        let guard = closed_guard(&slot).await;
        assert_eq!(
            guard.bytes_sent.load(std::sync::atomic::Ordering::Relaxed),
            2500
        );
        assert_eq!(guard.wire_bytes(), body.len() as u64);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerCap);
        drop(conn);
    }

    /// A server cap on close-framed PCM ends the body by closing the
    /// connection after exactly that many bytes.
    #[tokio::test]
    async fn a_server_cap_ends_a_close_framed_body_by_closing() {
        let pcm = PcmHttpSettings {
            end_after_bytes: Some(5000),
            ..pcm_framed(PcmHttpFraming::Close)
        };
        let (addr, slot) = serve_once(endless_items(), Some(pcm)).await;
        let (mut conn, _head, body) = request(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n").await;
        let body = tokio::time::timeout(
            Duration::from_secs(5),
            read_body(&mut conn, body, |_| false),
        )
        .await
        .expect("the server closes the connection");
        assert_eq!(body.len(), 5000);

        let guard = closed_guard(&slot).await;
        assert_eq!(guard.wire_bytes(), 5000);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerCap);
    }

    /// A cap that falls exactly on an item boundary still ends the body at
    /// once, without waiting for another item, and still says so.
    #[tokio::test]
    async fn a_cap_on_an_item_boundary_ends_without_waiting() {
        let guard = Arc::new(LoggingStreamGuard::new("s".into(), test_ip()));
        let items: AudioStream = Box::pin(
            futures::stream::iter(vec![Ok(Bytes::from(vec![7u8; 1000]))])
                .chain(futures::stream::pending()),
        );
        let capped = with_server_cap(items, 1000, Arc::clone(&guard));
        let collected: Vec<_> = tokio::time::timeout(Duration::from_secs(1), capped.collect())
            .await
            .expect("the cap ends the body");
        assert_eq!(collected.len(), 1);
        assert_eq!(guard.ended_by(), crate::stream::EndedBy::ServerCap);
    }

    /// Without `end_after_bytes` the body is left alone.
    #[tokio::test]
    async fn no_cap_leaves_the_body_alone() {
        let guard = Arc::new(LoggingStreamGuard::new("s".into(), test_ip()));
        let body = with_optional_server_cap(
            finite_items(&[1000, 1000]),
            Some(&pcm_framed(PcmHttpFraming::Chunked)),
            &guard,
        );
        let collected: Vec<_> = body.collect().await;
        assert_eq!(collected.len(), 2);
        assert_ne!(guard.ended_by(), crate::stream::EndedBy::ServerCap);
    }

    /// The switches line gives every setting a connection is served with.
    /// The first byte of a `Range` header, as a Sonos speaker sends it after
    /// a pause (`bytes=4227072-`) or past a segment's end.
    #[test]
    fn a_range_header_gives_its_first_byte() {
        assert_eq!(parse_range_start("bytes=4227072-"), Some(4_227_072));
        assert_eq!(parse_range_start(" bytes=0-99 "), Some(0));
        assert_eq!(parse_range_start("bytes=10-20, 30-40"), Some(10));
        assert_eq!(parse_range_start("bytes=-500"), None, "a suffix range");
        assert_eq!(parse_range_start("items=1-"), None);
        assert_eq!(parse_range_start("bytes=x-"), None);
    }

    /// A fetch of part of a segment is answered `206` with the range it
    /// carries, to the segment's end; a whole one keeps `200`.
    #[test]
    fn a_partial_segment_fetch_is_answered_206() {
        let layout = SegmentLayout::new(&AudioFormat::default(), 10_485_760);
        let head = |range: Option<u64>| {
            let start = SegmentStart::new(1, range, &layout).expect("inside the segment");
            let framing = ResponseFraming::new(Version::HTTP_11, None);
            segment_head(response_head("audio/wav", false, framing), &start, &layout)
                .body(Body::empty())
                .expect("response")
        };
        let whole = head(None);
        assert_eq!(whole.status(), axum::http::StatusCode::OK);
        assert!(whole.headers().get(header::CONTENT_RANGE).is_none());

        let partial = head(Some(4_227_072));
        assert_eq!(partial.status(), axum::http::StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            partial.headers()[header::CONTENT_RANGE],
            "bytes 4227072-10485163/10485164"
        );
    }

    #[test]
    fn the_switches_line_names_every_setting() {
        let line = pcm_switches_line(
            ip("192.168.1.50"),
            "s1",
            &PcmHttpSettings {
                framing: PcmHttpFraming::Chunked,
                content_length: 10_485_760,
                wav_data_size: 10_485_760,
                end_after_bytes: Some(2_000_000),
                segments: false,
                segment_bytes: 0xFFFF_0000,
                continuation: PcmContinuation::Restart,
                segment_didl: PcmSegmentDidl::Track,
            },
        );
        assert_eq!(
            line,
            "[Stream] PCM HTTP switches: client=192.168.1.50, stream=s1, framing=chunked, \
             content_length=none, wav_data_size=10485760, end_after_bytes=2000000, \
             segment_bytes=off, continuation=off, segment_didl=off"
        );
        let line = pcm_switches_line(ip("192.168.1.50"), "s1", &pcm_length(10_485_760));
        assert_eq!(
            line,
            "[Stream] PCM HTTP switches: client=192.168.1.50, stream=s1, framing=length, \
             content_length=10485760, wav_data_size=4294967295, end_after_bytes=none, \
             segment_bytes=off, continuation=off, segment_didl=off"
        );
        let segmented = PcmHttpSettings {
            segment_bytes: 10_485_760,
            ..PcmHttpSettings::default()
        };
        assert!(
            pcm_switches_line(ip("192.168.1.50"), "s1", &segmented).ends_with(
                "end_after_bytes=none, segment_bytes=10485760, continuation=auto, \
                 segment_didl=broadcast"
            )
        );
    }

    /// The speaker monitor's ack lag counts what the speaker has acknowledged
    /// against the bytes on the wire. On a chunked body, which is how PCM is
    /// served by default, the framing is acknowledged too, 7 bytes per
    /// 1920-byte frame, so counted against the payload the acknowledged count
    /// overtakes it within a few hundred frames and the lag reads zero however
    /// much is really outstanding.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_default_pcm_connection_reports_its_real_ack_lag() {
        use std::io::{Read, Write};
        use std::os::fd::AsRawFd;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let mut peer =
            std::net::TcpStream::connect(listener.local_addr().unwrap()).expect("connect");
        let (mut accepted, _) = listener.accept().expect("accept");
        let registry = crate::api::link::TcpLinkRegistry::new();
        let peer_addr = accepted.peer_addr().unwrap();
        registry.register(peer_addr, accepted.as_raw_fd() as u64);
        // Framed as a PCM connection is with no switch set.
        let framing =
            ResponseFraming::new(Version::HTTP_11, Some(&PcmHttpSettings::default())).framing;
        assert_eq!(framing, BodyFraming::Chunked);
        let guard = LoggingStreamGuard::new("s".into(), test_ip())
            .with_link_probe(registry.claim(peer_addr))
            .with_framing(framing);

        // 1000 frames handed over, framed and written as hyper would, and read.
        let frame = vec![7u8; 1920];
        let mut wire = Vec::new();
        for _ in 0..1000 {
            guard.record_body_bytes(frame.len());
            wire.extend_from_slice(format!("{:X}\r\n", frame.len()).as_bytes());
            wire.extend_from_slice(&frame);
            wire.extend_from_slice(b"\r\n");
        }
        accepted.write_all(&wire).expect("write");
        let mut received = vec![0u8; wire.len()];
        peer.read_exact(&mut received).expect("read");
        assert_eq!(guard.wire_bytes(), wire.len() as u64);

        // One more frame handed over but not yet written: that is the lag.
        guard.record_body_bytes(frame.len());
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let unacked = guard.unacked_bytes_now().expect("kernel 4.1 or later");
            if unacked == 1920 + 7 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "ack lag stuck at {unacked} bytes, not the one frame outstanding"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Without the burst a connection starts exactly as before: one frame
    /// ahead of real time.
    #[tokio::test(start_paused = true)]
    async fn pcm_connection_without_burst_starts_one_frame_ahead() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        push_tagged(&state, 0, 100);
        let (mut body, tap) = pcm_connection(&state, ip("192.168.1.50"), 0);
        let items = ready_now(&mut body).await;
        assert_eq!(items.len(), 2, "header and first tick");
        assert_eq!(items[1][0], 80);
        assert_eq!(tap.delivered_ms(), Some(10));
    }
}
