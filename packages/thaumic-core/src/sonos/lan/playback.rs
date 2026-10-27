//! Casts over port 1443: the speaker plays a cloud queue Thaumic serves.
//!
//! A cast on a coordinator creates a playback session on its group, follows
//! the session's and the group's events, and loads a queue whose item is the
//! PCM segment the services asked for (see [`super::queue`]). The household's
//! route is held on port 1443 for as long as the cast is live.
//!
//! What the services see is what UPnP gives them (measured on firmware 86.10):
//! - **State and position** come from `getPlaybackStatus`. The position is
//!   floored to whole seconds, as RelTime is, so the monitor's model is
//!   unchanged. A cast paused at its item's declared end reads as STOPPED,
//!   as a UPnP speaker stops when a body ends, so the services' restart
//!   path takes over; a pause before the end stays PAUSED.
//! - **The track URI** is the item's own segment URL, or, while the speaker
//!   is idle, the item it last played.
//! - **The next segment** is listed in the queue behind the current one
//!   when the cast continues (`PcmContinuation` `auto` or `next`), so the
//!   speaker fetches and plays it itself with no gap, and `set_next_uri`
//!   has nothing left to send. A next segment the speaker could not play
//!   leaves it PAUSED on that segment, never having played it: that reads as
//!   STOPPED on the segment before, so the restart path loads the next one.
//! - **Resume** loads the current item again: after a pause, `play` makes the
//!   speaker fetch once and end the item.
//! - **Stop** ends the queue first, so a speaker that asks again gets nothing,
//!   then pauses and leaves the session. The HTTP side is closed before
//!   this, as for every PCM stop.
//! - **A takeover** is any eviction of a live session we did not cause:
//!   another app's session, the Sonos app, or the TV input. Its reason cannot
//!   tell it from our own leave, so a session is ours to end only through
//!   [`LanClient::end_cast`], which forgets it first. An evicted session is
//!   never paused afterwards: that would pause the TV.
//! - **A dropped socket** is reopened and the session joined again: playback
//!   carries on over the same audio request, and the speaker returns the same
//!   session.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::client::LanClient;
use super::protocol::{code, transport_error, Command, Frame, Target};
use super::queue::{CloudQueue, CloudQueues, QueueItem, TrackInfo, API_VERSION, PATH_PREFIX};
use crate::error::SoapResult;
use crate::sonos::gena::SonosEvent;
use crate::sonos::routed::LanHold;
use crate::sonos::traits::{NextItem, SonosPlayback};
use crate::sonos::types::{PositionInfo, TransportState};
use crate::sonos::utils::build_sonos_stream_uri;
use crate::stream::{
    parse_stream_uri, AudioCodec, AudioFormat, PcmContinuation, PcmHttpSwitches, SegmentLayout,
    StreamMetadata,
};
use crate::utils::now_millis;

/// The app id our sessions carry.
pub const APP_ID: &str = "com.thaumic.cast";

/// The namespaces a cast uses.
const PLAYBACK: &str = "playback:1";
const SESSION: &str = "playbackSession:1";

/// A cast paused this close to its item's declared end has reached it.
const END_TOLERANCE_MS: u64 = 2_000;

/// A status read this recently is reused by the event pump instead of
/// asking again.
pub const STATUS_FRESH_FOR: Duration = Duration::from_millis(1_500);

/// A resume this soon after a load is the speaker still starting it, and
/// loading again would only restart it.
const RELOAD_GUARD: Duration = Duration::from_secs(5);

/// What `getPlaybackStatus` and `playbackStatus` events carry that a cast
/// needs.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    /// `PLAYBACK_STATE_PLAYING`, `…_PAUSED`, `…_IDLE` or `…_BUFFERING`.
    pub playback_state: String,
    /// The position in the item, in ms.
    #[serde(default)]
    pub position_millis: u64,
    /// The item playing.
    #[serde(default)]
    pub item_id: Option<String>,
    /// The item played before it.
    #[serde(default)]
    pub previous_item_id: Option<String>,
}

/// One live cast, on the coordinator it plays on.
pub struct Cast {
    /// The stream it plays.
    pub stream_id: String,
    /// The playback session.
    pub session_id: String,
    /// The queue loaded now.
    pub gen: String,
    /// The item loaded, or the last seen playing since.
    pub item: QueueItem,
    /// The segments seen playing since the load.
    pub played: HashSet<u32>,
    /// The queue's base URL.
    pub queue_url: String,
    /// When it was last loaded.
    pub loaded_at: Instant,
    /// The last status read, and when.
    pub status: Option<(Instant, TransportState, PositionInfo)>,
    /// The state and track last reported as an event.
    pub reported: Option<(TransportState, String)>,
    /// Keeps the household on port 1443.
    _hold: LanHold,
}

/// The state and track URI a status means for the services, given the
/// segments seen playing since the load.
fn read_status(
    queues: &CloudQueues,
    status: &PlaybackStatus,
    played: &HashSet<u32>,
) -> (TransportState, String) {
    let ours = |id: &Option<String>| {
        id.as_deref()
            .filter(|id| !id.is_empty())
            .and_then(|id| queues.item(id))
    };
    let item = ours(&status.item_id);
    // A segment after the first that the speaker moved onto and never
    // played: it could not fetch it.
    let stuck = item
        .as_ref()
        .filter(|(item, first)| item.segment != *first && !played.contains(&item.segment));
    let state = match status.playback_state.as_str() {
        "PLAYBACK_STATE_PLAYING" => TransportState::Playing,
        "PLAYBACK_STATE_BUFFERING" => TransportState::Transitioning,
        "PLAYBACK_STATE_IDLE" => TransportState::Stopped,
        "PLAYBACK_STATE_PAUSED" if stuck.is_some() => TransportState::Stopped,
        "PLAYBACK_STATE_PAUSED" => {
            let at_end = item
                .as_ref()
                .and_then(|(i, _)| i.track.duration_ms)
                .is_some_and(|ms| status.position_millis + END_TOLERANCE_MS >= ms);
            if at_end {
                TransportState::Stopped
            } else {
                TransportState::Paused
            }
        }
        _ => TransportState::Transitioning,
    };
    let track = match (&item, state) {
        (Some((item, _)), TransportState::Stopped) if stuck.is_some() => {
            let before = CloudQueues::item_id(
                item.id.rsplit_once('-').map_or("", |(g, _)| g),
                item.segment - 1,
            );
            queues
                .item(&before)
                .map(|(i, _)| i.media_url)
                .unwrap_or_default()
        }
        (Some((item, _)), _) => item.media_url.clone(),
        (None, TransportState::Stopped) => ours(&status.previous_item_id)
            .map(|(i, _)| i.media_url)
            .unwrap_or_default(),
        (None, _) => status
            .item_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .map(|id| format!("x-sonos-lan-item:{id}"))
            .unwrap_or_default(),
    };
    (state, track)
}

/// Whether a cast lists the next segment behind each one: when the services
/// move a speaker on with a queued next item.
fn continues() -> bool {
    matches!(
        PcmHttpSwitches::from_env().settings.continuation,
        PcmContinuation::Auto | PcmContinuation::Next
    )
}

/// The stream's base URL (`…/stream/{id}/live`) from the URL of any of its
/// segments, as the services pass it (`…/live` or `…/live/{n}`).
fn stream_base(uri: &str) -> &str {
    match uri.rsplit_once('/') {
        Some((head, tail)) if head.ends_with("/live") && tail.parse::<u32>().is_ok() => head,
        _ => uri,
    }
}

/// The declared length of a PCM segment of `format`, as served now.
fn segment_duration_ms(format: &AudioFormat) -> Option<u64> {
    let settings = PcmHttpSwitches::from_env().settings;
    if !settings.segments {
        return None;
    }
    let layout = SegmentLayout::new(format, settings.segment_bytes);
    Some(layout.data_bytes() * 1000 / layout.byte_rate())
}

impl LanClient {
    /// Sends `command` for session `session_id`, on `ip`'s socket.
    async fn on_session(
        &self,
        ip: &str,
        session_id: &str,
        command: &'static str,
        body: Value,
    ) -> SoapResult<Value> {
        let household_id = self.household()?;
        let cmd =
            Command::new(SESSION, command, Target::Session(session_id.to_string())).with_body(body);
        Ok(self
            .hub()
            .call(ip, &household_id, &cmd)
            .await?
            .frame()
            .body
            .clone())
    }

    /// Follows the group's playback and the session's errors on `ip`'s
    /// socket. A failure is logged: the poll still sees the state.
    async fn follow(&self, ip: &str, session_id: &str) {
        if let Err(e) = self.on_group(ip, PLAYBACK, "subscribe", json!({})).await {
            log::warn!("[Lan] {ip}: playback subscribe: {e}");
        }
        if let Err(e) = self
            .on_session(ip, session_id, "subscribe", json!({}))
            .await
        {
            log::warn!("[Lan] {ip}: session subscribe: {e}");
        }
    }

    /// Loads `item` of queue `gen` at `queue_url` into session `session_id`.
    async fn load(
        &self,
        ip: &str,
        session_id: &str,
        queue_url: &str,
        item: &QueueItem,
        gen: &str,
    ) -> SoapResult<()> {
        let body = json!({
            "queueBaseUrl": queue_url,
            "itemId": item.id,
            "queueVersion": gen,
            "positionMillis": 0,
            "playOnCompletion": true,
        });
        self.on_session(ip, session_id, "loadCloudQueue", body)
            .await
            .map(drop)
    }

    /// Starts `uri` on the coordinator at `ip`: a session on its group if it
    /// has none of ours, then a fresh queue holding the segment `uri` names.
    async fn cast(
        &self,
        ip: &str,
        uri: &str,
        codec: AudioCodec,
        audio_format: &AudioFormat,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> SoapResult<()> {
        if codec != AudioCodec::Pcm {
            return Err(transport_error(
                code::UNSUPPORTED,
                format!("{codec:?} is not cast on port 1443"),
            ));
        }
        let media_url = build_sonos_stream_uri(uri, codec);
        let parsed = parse_stream_uri(&media_url)
            .ok_or_else(|| transport_error(code::BAD_REPLY, format!("not a stream URL: {uri}")))?;
        let segment = parsed
            .resource
            .pcm_segment()
            .ok_or_else(|| transport_error(code::BAD_REPLY, format!("not a PCM segment: {uri}")))?;
        let stream_id = parsed.stream_id.to_string();
        let gen = self.queues.next_gen();
        let queue_url = format!(
            "http://{}{PATH_PREFIX}/{stream_id}/{gen}/{API_VERSION}/",
            parsed.authority
        );
        let queue = CloudQueue {
            stream_id: stream_id.clone(),
            gen: gen.clone(),
            stream_url: build_sonos_stream_uri(stream_base(uri), codec)
                .trim_end_matches(".wav")
                .to_string(),
            first: segment,
            continues: continues(),
            track: TrackInfo {
                content_type: "audio/wav".into(),
                duration_ms: segment_duration_ms(audio_format),
                title: metadata
                    .and_then(|m| m.title.clone())
                    .unwrap_or_else(|| "Thaumic".into()),
                artist: metadata.and_then(|m| m.artist.clone()),
                image_url: (!artwork_url.is_empty()).then(|| artwork_url.to_string()),
            },
            ended: false,
        };
        let item = queue
            .item(segment)
            .expect("a queue holds the segment it is loaded at");
        debug_assert_eq!(item.media_url, media_url);
        self.queues.insert(queue);

        let existing = self
            .casts
            .lock()
            .get(ip)
            .map(|c| (c.session_id.clone(), c.gen.clone()));
        let session_id = match &existing {
            Some((session_id, _)) => session_id.clone(),
            None => {
                let created = self
                    .on_group(
                        ip,
                        SESSION,
                        "createSession",
                        json!({ "appId": APP_ID, "appContext": stream_id }),
                    )
                    .await;
                let session_id = created.and_then(|body| {
                    body["sessionId"]
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| {
                            transport_error(code::BAD_REPLY, "createSession named no session")
                        })
                });
                match session_id {
                    Ok(id) => id,
                    Err(e) => {
                        self.queues.remove(&gen);
                        return Err(e);
                    }
                }
            }
        };
        // Recorded before the load, so the session's own events are known
        // as ours from the start.
        let hold = self.route.hold();
        {
            let mut casts = self.casts.lock();
            let reported = casts.get(ip).and_then(|c| c.reported.clone());
            casts.insert(
                ip.to_string(),
                Cast {
                    stream_id: stream_id.clone(),
                    session_id: session_id.clone(),
                    gen: gen.clone(),
                    item: item.clone(),
                    played: HashSet::new(),
                    queue_url: queue_url.clone(),
                    loaded_at: Instant::now(),
                    status: None,
                    reported,
                    _hold: hold,
                },
            );
        }
        if existing.is_none() {
            self.follow(ip, &session_id).await;
        }
        if let Err(e) = self.load(ip, &session_id, &queue_url, &item, &gen).await {
            log::warn!("[Lan] {ip}: loadCloudQueue of {stream_id} segment {segment}: {e}");
            if existing.is_none() {
                self.casts.lock().remove(ip);
                let _ = self
                    .on_session(ip, &session_id, "leaveSession", json!({}))
                    .await;
            }
            self.queues.remove(&gen);
            return Err(e);
        }
        if let Some((_, old)) = existing {
            self.queues.remove(&old);
        }
        log::info!("[Lan] {ip}: casting {stream_id} segment {segment} (session {session_id})");
        Ok(())
    }

    /// Plays the cast on `ip` again by loading its current item: the way to
    /// resume on this route.
    async fn resume(&self, ip: &str) -> SoapResult<()> {
        let cast = {
            let casts = self.casts.lock();
            casts.get(ip).map(|c| {
                (
                    c.session_id.clone(),
                    c.queue_url.clone(),
                    c.item.clone(),
                    c.gen.clone(),
                    c.loaded_at,
                )
            })
        };
        let Some((session_id, queue_url, item, gen, loaded_at)) = cast else {
            return Err(transport_error(
                code::UNSUPPORTED,
                format!("no cast on {ip} to resume"),
            ));
        };
        if loaded_at.elapsed() < RELOAD_GUARD {
            return Ok(());
        }
        self.load(ip, &session_id, &queue_url, &item, &gen).await?;
        if let Some(cast) = self.casts.lock().get_mut(ip) {
            cast.loaded_at = Instant::now();
        }
        Ok(())
    }

    /// Ends the cast on `ip`, if there is one: the queue lists nothing from
    /// now on, then the group is paused and the session left. Refusals are
    /// logged; the cast is forgotten either way.
    pub(super) async fn end_cast(&self, ip: &str) {
        let Some(cast) = self.casts.lock().remove(ip) else {
            return;
        };
        self.queues.end(&cast.gen);
        if let Err(e) = self.on_group(ip, PLAYBACK, "pause", json!({})).await {
            log::warn!("[Lan] {ip}: pause at stop: {e}");
        }
        if let Err(e) = self
            .on_session(ip, &cast.session_id, "leaveSession", json!({}))
            .await
        {
            log::warn!("[Lan] {ip}: leaveSession at stop: {e}");
        }
        self.queues.remove(&cast.gen);
        log::info!("[Lan] {ip}: cast of {} ended", cast.stream_id);
    }

    /// Reads the playback of the group `ip` leads, as the services see it.
    async fn status(&self, ip: &str) -> SoapResult<(TransportState, PositionInfo)> {
        let body = self
            .on_group(ip, PLAYBACK, "getPlaybackStatus", json!({}))
            .await?;
        let status = PlaybackStatus::deserialize(&body)
            .map_err(|e| transport_error(code::BAD_REPLY, format!("playback status: {e}")))?;
        let played = self
            .casts
            .lock()
            .get(ip)
            .map(|c| c.played.clone())
            .unwrap_or_default();
        let (state, track_uri) = read_status(&self.queues, &status, &played);
        let position = PositionInfo {
            track_uri,
            rel_time_ms: status.position_millis / 1000 * 1000,
        };
        if let Some(cast) = self.casts.lock().get_mut(ip) {
            cast.status = Some((Instant::now(), state, position.clone()));
            let playing = status
                .item_id
                .as_deref()
                .and_then(|id| CloudQueues::segment_of(&cast.gen, id))
                .filter(|_| state == TransportState::Playing);
            if let Some(segment) = playing {
                cast.played.insert(segment);
                if let Some(item) = self.queues.get(&cast.gen).and_then(|q| q.item(segment)) {
                    cast.item = item;
                }
            }
        }
        Ok((state, position))
    }

    /// The coordinators with a live cast.
    #[must_use]
    pub fn live_casts(&self) -> Vec<String> {
        self.casts.lock().keys().cloned().collect()
    }

    /// Whether a cast is live on `ip`.
    #[must_use]
    pub fn has_cast(&self, ip: &str) -> bool {
        self.casts.lock().contains_key(ip)
    }

    /// Forgets the last status read on `ip`, so the next poll asks.
    pub fn status_stale(&self, ip: &str) {
        if let Some(cast) = self.casts.lock().get_mut(ip) {
            cast.status = None;
        }
    }

    /// The event for the cast on `ip`'s state, if it changed since the last
    /// one: from a status read within [`STATUS_FRESH_FOR`], or a fresh one.
    pub async fn poll(&self, ip: &str) -> Option<SonosEvent> {
        let fresh = {
            let casts = self.casts.lock();
            let cast = casts.get(ip)?;
            cast.status
                .as_ref()
                .filter(|(at, ..)| at.elapsed() < STATUS_FRESH_FOR)
                .map(|(_, state, position)| (*state, position.track_uri.clone()))
        };
        let (state, track) = match fresh {
            Some(read) => read,
            None => match self.status(ip).await {
                Ok((state, position)) => (state, position.track_uri),
                Err(e) => {
                    log::debug!("[Lan] {ip}: status poll: {e}");
                    return None;
                }
            },
        };
        let mut casts = self.casts.lock();
        let cast = casts.get_mut(ip)?;
        let now = (state, track.clone());
        if cast.reported.as_ref() == Some(&now) {
            return None;
        }
        cast.reported = Some(now);
        Some(SonosEvent::TransportState {
            speaker_ip: ip.to_string(),
            state,
            current_uri: (!track.is_empty()).then_some(track),
            next_uri: None,
            timestamp: now_millis(),
        })
    }

    /// What a `sessionError` from `ip` means: when it evicts a live session
    /// of ours, the cast was taken over, and the services are told so.
    pub fn session_error(&self, ip: &str, frame: &Frame) -> Option<SonosEvent> {
        let reason = frame.reason().unwrap_or_default().to_string();
        if frame.error_code() != Some(code::SESSION_EVICTED) {
            log::warn!(
                "[Lan] {ip}: session error {:?}: {reason}",
                frame.error_code()
            );
            return None;
        }
        let session_id = frame.session_id()?;
        let (at, cast) = {
            let mut casts = self.casts.lock();
            let at = casts
                .iter()
                .find(|(_, c)| c.session_id == session_id)
                .map(|(at, _)| at.clone())?;
            let cast = casts.remove(&at)?;
            (at, cast)
        };
        self.queues.end(&cast.gen);
        self.queues.remove(&cast.gen);
        log::warn!(
            "[Lan] {at}: cast of {} taken over (session evicted: {reason})",
            cast.stream_id
        );
        Some(SonosEvent::SourceChanged {
            speaker_ip: at,
            current_uri: format!("x-sonos-lan-evicted:{reason}"),
            expected_uri: Some(cast.item.media_url),
            timestamp: now_millis(),
        })
    }

    /// Joins the cast on `ip` again after its socket dropped, and follows it
    /// on the new socket. When the speaker no longer has the session, the
    /// cast ended while we were away, and the services are told it was taken
    /// over.
    pub async fn rejoin(&self, ip: &str) -> SoapResult<Option<SonosEvent>> {
        let Some((session_id, stream_id, media_url, gen)) = self.casts.lock().get(ip).map(|c| {
            (
                c.session_id.clone(),
                c.stream_id.clone(),
                c.item.media_url.clone(),
                c.gen.clone(),
            )
        }) else {
            return Ok(None);
        };
        let body = self
            .on_group(
                ip,
                SESSION,
                "joinSession",
                json!({ "appId": APP_ID, "appContext": stream_id }),
            )
            .await?;
        let joined = body["sessionId"].as_str().unwrap_or_default().to_string();
        if joined == session_id {
            self.follow(ip, &session_id).await;
            log::info!("[Lan] {ip}: session {session_id} joined again");
            return Ok(None);
        }
        // A session of ours that is not the cast's: the cast is gone.
        let _ = self
            .on_session(ip, &joined, "leaveSession", json!({}))
            .await;
        if self.casts.lock().remove(ip).is_none() {
            return Ok(None);
        }
        self.queues.end(&gen);
        self.queues.remove(&gen);
        log::warn!("[Lan] {ip}: cast of {stream_id} was gone after its socket dropped");
        Ok(Some(SonosEvent::SourceChanged {
            speaker_ip: ip.to_string(),
            current_uri: "x-sonos-lan-evicted:session gone".into(),
            expected_uri: Some(media_url),
            timestamp: now_millis(),
        }))
    }
}

#[async_trait]
impl SonosPlayback for LanClient {
    async fn play_uri(
        &self,
        ip: &str,
        uri: &str,
        codec: AudioCodec,
        audio_format: &AudioFormat,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> SoapResult<()> {
        self.cast(ip, uri, codec, audio_format, metadata, artwork_url)
            .await
    }

    async fn set_next_uri(&self, ip: &str, _item: &NextItem<'_>) -> SoapResult<()> {
        // The queue already lists every next segment behind the current one.
        let listed = self
            .casts
            .lock()
            .get(ip)
            .and_then(|c| self.queues.get(&c.gen))
            .is_some_and(|q| q.continues);
        if listed {
            Ok(())
        } else {
            Err(transport_error(
                code::UNSUPPORTED,
                format!("no continuing cast on {ip} to queue a next item for"),
            ))
        }
    }

    async fn play(&self, ip: &str) -> SoapResult<()> {
        self.resume(ip).await
    }

    async fn stop(&self, ip: &str) -> SoapResult<()> {
        self.end_cast(ip).await;
        Ok(())
    }

    async fn switch_to_queue(&self, _ip: &str, _coordinator_uuid: &str) -> SoapResult<()> {
        // Leaving the session at stop already hands the room back.
        Ok(())
    }

    async fn get_position_info(&self, ip: &str) -> SoapResult<PositionInfo> {
        Ok(self.status(ip).await?.1)
    }

    async fn get_transport_info(&self, ip: &str) -> SoapResult<TransportState> {
        Ok(self.status(ip).await?.0)
    }

    async fn join_group(&self, _ip: &str, _coordinator_uuid: &str) -> SoapResult<()> {
        Err(transport_error(
            code::UNSUPPORTED,
            "grouping is not carried out on port 1443",
        ))
    }

    async fn leave_group(&self, _ip: &str) -> SoapResult<()> {
        Err(transport_error(
            code::UNSUPPORTED,
            "grouping is not carried out on port 1443",
        ))
    }

    async fn rejoin_group(&self, _ip: &str, _coordinator_uuid: &str) -> SoapResult<()> {
        Err(transport_error(
            code::UNSUPPORTED,
            "grouping is not carried out on port 1443",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queues_with(duration_ms: Option<u64>) -> (CloudQueues, String) {
        let queues = CloudQueues::default();
        let gen = queues.next_gen();
        queues.insert(CloudQueue {
            stream_id: "s1".into(),
            gen: gen.clone(),
            stream_url: "http://10.0.0.2:1/stream/s1/live".into(),
            first: 3,
            continues: true,
            track: TrackInfo {
                content_type: "audio/wav".into(),
                duration_ms,
                title: "Tab".into(),
                artist: None,
                image_url: None,
            },
            ended: false,
        });
        (queues, gen)
    }

    fn none() -> HashSet<u32> {
        HashSet::new()
    }

    fn status(
        state: &str,
        position: u64,
        item: Option<&str>,
        previous: Option<&str>,
    ) -> PlaybackStatus {
        PlaybackStatus {
            playback_state: format!("PLAYBACK_STATE_{state}"),
            position_millis: position,
            item_id: item.map(str::to_string),
            previous_item_id: previous.map(str::to_string),
        }
    }

    fn read_status_(queues: &CloudQueues, status: &PlaybackStatus) -> (TransportState, String) {
        read_status(queues, status, &none())
    }

    #[test]
    fn a_next_segment_never_played_reads_as_stopped_on_the_one_before() {
        let (queues, gen) = queues_with(Some(60_000));
        let next = CloudQueues::item_id(&gen, 4);
        let first_url = "http://10.0.0.2:1/stream/s1/live/3.wav".to_string();
        let next_url = "http://10.0.0.2:1/stream/s1/live/4.wav".to_string();
        let played: HashSet<u32> = [3].into();

        assert_eq!(
            read_status(
                &queues,
                &status("PAUSED", 0, Some(&next), Some("x")),
                &played
            ),
            (TransportState::Stopped, first_url)
        );
        // Moving onto it, and playing it: it is the current one.
        assert_eq!(
            read_status(&queues, &status("BUFFERING", 0, Some(&next), None), &played),
            (TransportState::Transitioning, next_url.clone())
        );
        assert_eq!(
            read_status(&queues, &status("PLAYING", 0, Some(&next), None), &played),
            (TransportState::Playing, next_url.clone())
        );
        // Once played, a pause on it is a pause.
        let both: HashSet<u32> = [3, 4].into();
        assert_eq!(
            read_status(&queues, &status("PAUSED", 9_000, Some(&next), None), &both),
            (TransportState::Paused, next_url)
        );
    }

    #[test]
    fn segment_urls_have_one_base() {
        assert_eq!(
            stream_base("http://h:1/stream/s/live"),
            "http://h:1/stream/s/live"
        );
        assert_eq!(
            stream_base("http://h:1/stream/s/live/7"),
            "http://h:1/stream/s/live"
        );
        assert_eq!(
            stream_base("http://h:1/stream/s/other/7"),
            "http://h:1/stream/s/other/7"
        );
    }

    #[test]
    fn our_item_reads_as_its_segment_url_in_each_state() {
        let (queues, gen) = queues_with(Some(60_000));
        let id = CloudQueues::item_id(&gen, 3);
        let url = "http://10.0.0.2:1/stream/s1/live/3.wav".to_string();
        for (state, expected) in [
            ("PLAYING", TransportState::Playing),
            ("BUFFERING", TransportState::Transitioning),
            ("PAUSED", TransportState::Paused),
        ] {
            assert_eq!(
                read_status_(&queues, &status(state, 10_000, Some(&id), None)),
                (expected, url.clone())
            );
        }
    }

    #[test]
    fn a_pause_at_the_item_s_end_reads_as_stopped_and_one_before_it_as_paused() {
        let (queues, gen) = queues_with(Some(60_000));
        let id = CloudQueues::item_id(&gen, 3);
        assert_eq!(
            read_status_(&queues, &status("PAUSED", 60_000, Some(&id), None)).0,
            TransportState::Stopped
        );
        assert_eq!(
            read_status_(&queues, &status("PAUSED", 58_500, Some(&id), None)).0,
            TransportState::Stopped
        );
        assert_eq!(
            read_status_(&queues, &status("PAUSED", 50_000, Some(&id), None)).0,
            TransportState::Paused
        );
        // With no declared length there is no end to reach.
        let (queues, gen) = queues_with(None);
        let id = CloudQueues::item_id(&gen, 3);
        assert_eq!(
            read_status_(&queues, &status("PAUSED", 86_400_000, Some(&id), None)).0,
            TransportState::Paused
        );
    }

    #[test]
    fn an_idle_speaker_names_the_item_it_last_played_and_a_foreign_one_is_not_ours() {
        let (queues, gen) = queues_with(Some(60_000));
        let id = CloudQueues::item_id(&gen, 3);
        assert_eq!(
            read_status_(&queues, &status("IDLE", 0, Some("0"), Some(&id))),
            (
                TransportState::Stopped,
                "http://10.0.0.2:1/stream/s1/live/3.wav".to_string()
            )
        );
        assert_eq!(
            read_status_(&queues, &status("IDLE", 0, None, Some("other"))),
            (TransportState::Stopped, String::new())
        );
        assert_eq!(
            read_status_(&queues, &status("PLAYING", 0, Some("spotify:1"), None)),
            (TransportState::Playing, "x-sonos-lan-item:spotify:1".into())
        );
    }

    #[test]
    fn a_recorded_status_reads() {
        let frame = Frame::parse(&super::super::protocol::tests::recorded(
            "event_playback_status",
        ))
        .unwrap();
        let status = PlaybackStatus::deserialize(&frame.body).unwrap();
        assert_eq!(status.playback_state, "PLAYBACK_STATE_IDLE");
        assert_eq!(status.previous_item_id.as_deref(), Some("i1793009200823"));
    }

    #[test]
    fn a_segment_lasts_its_data_bytes() {
        // The default 0xFFFF_0000 bytes at 48 kHz, 16-bit stereo: 6h12m49s.
        let ms = segment_duration_ms(&AudioFormat::default()).unwrap();
        assert_eq!(ms / 1000, 6 * 3600 + 12 * 60 + 49);
    }
}
