//! Sync group lifecycle management for multi-room Sonos playback.
//!
//! Responsibilities:
//! - Joining rooms to a cast's group via x-rincon, each standing alone first
//! - Stop orchestration (ordered slave unjoin → coordinator stop)
//! - Coordinator promotion (slave takeover when coordinator removed)
//! - Putting rooms back into the groups they left, when nothing else has
//!   regrouped them since

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard, Notify};

use crate::context::NetworkContext;
use crate::events::{EventEmitter, SonosEvent, SpeakerRemovalReason, StreamEvent};
use crate::sonos::subscription_arbiter::SubscriptionArbiter;
use crate::sonos::traits::{SonosTopology, SonosVolumeControl};
use crate::sonos::types::ZoneGroup;
use crate::sonos::SonosPlayback;
use crate::state::SonosState;
use crate::stream::{AudioCodec, CleanupOrder, StreamRegistry};
use crate::utils::now_millis;

use super::playback_session_store::{
    GroupRole, PlaybackResult, PlaybackSession, PlaybackSessionKey, PlaybackSessionStore,
};
use super::regroup::{plan_restore, Leaving, OldGroup};
use super::stream_coordinator::StartLevels;

/// A failed [`PlaybackResult`] for `speaker_ip`.
fn failed(speaker_ip: &str, error: String) -> PlaybackResult {
    PlaybackResult {
        speaker_ip: speaker_ip.to_string(),
        success: false,
        stream_url: None,
        error: Some(error),
    }
}

/// Manages sync group lifecycle for multi-room Sonos playback.
///
/// Handles the x-rincon protocol coordination: joining rooms to a cast's
/// group, unjoining them, promoting a slave when the coordinator is removed,
/// and putting rooms back into the groups they left.
pub(crate) struct SyncGroupManager {
    sessions: Arc<PlaybackSessionStore>,
    sonos: Arc<dyn SonosPlayback>,
    sonos_state: Arc<SonosState>,
    emitter: Arc<dyn EventEmitter>,
    arbiter: Arc<SubscriptionArbiter>,
    stream_registry: Arc<StreamRegistry>,
    network: NetworkContext,
    topology_refresh: Option<Arc<Notify>>,
    /// Where the household's grouping is read fresh before a regroup.
    topology: Option<Arc<dyn SonosTopology>>,
    /// Where a room's own level is read as it enters a sync session (see
    /// [`Self::announce_own_levels`]).
    volume: Option<Arc<dyn SonosVolumeControl>>,
    /// One regroup at a time (see [`Self::lock_regroup`]).
    regroup_lock: AsyncMutex<()>,
}

/// How long one fresh read of the household's grouping may take.
const FRESH_TOPOLOGY_TIMEOUT: Duration = Duration::from_secs(3);

/// How long one read of a room's own level or mute may take.
const OWN_LEVEL_TIMEOUT: Duration = Duration::from_secs(1);

/// How many times a room's own level or mute is asked for as it enters a
/// sync session, and how long apart.
const OWN_LEVEL_ATTEMPTS: usize = 2;
const OWN_LEVEL_RETRY_DELAY: Duration = Duration::from_millis(300);

/// Reads a room's own level or mute with `read`, asking once more after a
/// short wait if the first answer is a fault or does not come within
/// [`OWN_LEVEL_TIMEOUT`]: a speaker that has just joined a group can fault a
/// request while it settles, and nothing else would ever send the level.
async fn read_own<T, F, Fut>(read: F) -> Option<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = crate::error::SoapResult<T>>,
{
    for attempt in 0..OWN_LEVEL_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(OWN_LEVEL_RETRY_DELAY).await;
        }
        if let Ok(Ok(value)) = tokio::time::timeout(OWN_LEVEL_TIMEOUT, read()).await {
            return Some(value);
        }
    }
    None
}

/// How many speakers are asked for the grouping before the cache is used.
const FRESH_TOPOLOGY_ATTEMPTS: usize = 3;

/// A room joining a cast's Sonos group (see
/// [`SyncGroupManager::join_room`]).
pub(crate) struct JoinRoomRequest<'a> {
    /// The room's primary: its player UUID and IP.
    pub room_uuid: &'a str,
    pub room_ip: &'a str,
    /// The room leading the cast's group.
    pub coordinator_ip: &'a str,
    pub coordinator_uuid: &'a str,
    pub stream_id: &'a str,
    pub codec: AudioCodec,
    /// Whether the room shares a group with other rooms it must leave first.
    pub leave_first: bool,
    /// Start levels to set after leaving and before joining.
    pub start_levels: Option<StartLevels<'a>>,
    /// The group the room was in, recorded on its session.
    pub old_group: Option<OldGroup>,
}

/// What a room's join did.
pub(crate) struct JoinOutcome {
    pub result: PlaybackResult,
    /// Whether the room left a group on the way, so a failed join has a
    /// room to put back.
    pub left_group: bool,
}

impl SyncGroupManager {
    /// Creates a new SyncGroupManager.
    pub fn new(
        sessions: Arc<PlaybackSessionStore>,
        sonos: Arc<dyn SonosPlayback>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
        arbiter: Arc<SubscriptionArbiter>,
        stream_registry: Arc<StreamRegistry>,
        network: NetworkContext,
    ) -> Self {
        Self {
            sessions,
            sonos,
            sonos_state,
            emitter,
            arbiter,
            stream_registry,
            network,
            topology_refresh: None,
            topology: None,
            volume: None,
            regroup_lock: AsyncMutex::new(()),
        }
    }

    /// Sets where the household's grouping is read fresh before a regroup.
    /// Unset, the cached topology is used.
    pub fn set_topology_source(&mut self, topology: Arc<dyn SonosTopology>) {
        self.topology = Some(topology);
    }

    /// Sets where a room's own level is read as it enters a sync session.
    /// Unset, the level comes only from the room's RenderingControl events.
    pub fn set_volume_source(&mut self, volume: Arc<dyn SonosVolumeControl>) {
        self.volume = Some(volume);
    }

    /// Takes the regroup lock: one regroup at a time on this companion.
    ///
    /// `ZoneGroupState` carries no household id, so this covers the whole
    /// household; a second household on one companion only queues behind
    /// the first. Taken before any speaker's start lock, and never while
    /// holding one.
    pub(crate) async fn lock_regroup(&self) -> AsyncMutexGuard<'_, ()> {
        self.regroup_lock.lock().await
    }

    /// The household's grouping, read from a speaker now rather than from
    /// the GENA cache, which can trail a change made a moment ago. Asks the
    /// rooms in `ask_first` (the rooms at hand), then the cached
    /// coordinators, a few at most; `None` when none of them answers. With
    /// no topology source set, the cache. The cache itself is left to the
    /// topology monitor, so clients still hear of every change.
    pub(crate) async fn read_groups(&self, ask_first: &[String]) -> Option<Vec<ZoneGroup>> {
        let cached = self.sonos_state.groups.read().clone();
        let Some(topology) = &self.topology else {
            return Some(cached);
        };
        let mut ips: Vec<String> = Vec::new();
        for ip in ask_first
            .iter()
            .cloned()
            .chain(cached.iter().map(|g| g.coordinator_ip.clone()))
        {
            if !ips.contains(&ip) {
                ips.push(ip);
            }
        }
        for ip in ips.iter().take(FRESH_TOPOLOGY_ATTEMPTS) {
            match tokio::time::timeout(FRESH_TOPOLOGY_TIMEOUT, topology.get_zone_group_state(ip))
                .await
            {
                Ok(Ok(snapshot)) if !snapshot.groups.is_empty() => return Some(snapshot.groups),
                Ok(Ok(_)) => log::debug!("[Regroup] {ip} reported no groups"),
                Ok(Err(e)) => log::debug!("[Regroup] {ip} could not report the groups: {e}"),
                Err(_) => log::debug!("[Regroup] {ip} did not report the groups in time"),
            }
        }
        None
    }

    /// [`Self::read_groups`], falling back to the cache when no speaker
    /// answers. Only for a stop or a restore, which must go ahead: a cast
    /// start refuses instead, since a plan made from a stale cache could
    /// tell a room that now leads others to join.
    async fn fresh_groups(&self, ask_first: &[String]) -> Vec<ZoneGroup> {
        match self.read_groups(ask_first).await {
            Some(groups) => groups,
            None => {
                log::warn!("[Regroup] No speaker reported the grouping; using the cached one");
                self.sonos_state.groups.read().clone()
            }
        }
    }

    /// Joins one room to a cast's Sonos group: it leaves a group of other
    /// rooms first if it is in one, its start level is set, then it is told
    /// to join (`x-rincon:`). A room is never told to join while other
    /// rooms follow it.
    ///
    /// Runs under the room's start lock, like every start on a speaker. A
    /// room that cannot leave its group is left as it was; a room that left
    /// and then could not join says so, so the caller can put it back.
    pub(crate) async fn join_room(&self, request: JoinRoomRequest<'_>) -> JoinOutcome {
        let JoinRoomRequest {
            room_uuid,
            room_ip,
            coordinator_ip,
            coordinator_uuid,
            stream_id,
            codec,
            leave_first,
            start_levels,
            old_group,
        } = request;
        let _start = self.sessions.lock_speaker_start(stream_id, room_ip).await;
        let mut left_group = false;

        // A room already in this cast never gets here: the caller ends the
        // session of one that was regrouped away instead of pulling it back.
        if let Some((old_key, old_session)) = self.sessions.find_other_stream(room_ip, stream_id) {
            log::info!(
                "[Regroup] {} switching from stream {} to {}",
                room_ip,
                old_session.stream_id,
                stream_id
            );
            self.sessions
                .remove(&old_key.stream_id, &old_key.speaker_ip);
            match self.sonos.leave_group(room_ip).await {
                Ok(()) => left_group = true,
                Err(e) => log::warn!("[Regroup] Failed to unjoin {room_ip}: {e}"),
            }
            self.emit_event(StreamEvent::PlaybackStopped {
                stream_id: old_session.stream_id,
                speaker_ip: room_ip.to_string(),
                reason: Some(SpeakerRemovalReason::SpeakerTakenOver),
                timestamp: now_millis(),
            });
        }

        if leave_first && !left_group {
            if let Err(e) = self.sonos.leave_group(room_ip).await {
                log::warn!("[Regroup] {room_ip} could not leave its Sonos group: {e}");
                return JoinOutcome {
                    result: failed(room_ip, format!("Could not leave its Sonos group: {e}")),
                    left_group: false,
                };
            }
            left_group = true;
        }

        // A Sonos member keeps its own volume when it joins, so the level
        // goes in first.
        if let Some(levels) = start_levels {
            levels
                .apply(&[(room_uuid.to_string(), room_ip.to_string())])
                .await;
        }

        match self.sonos.join_group(room_ip, coordinator_uuid).await {
            Ok(()) => {
                let rincon_uri = format!("x-rincon:{coordinator_uuid}");
                self.sessions.insert(PlaybackSession {
                    stream_id: stream_id.to_string(),
                    speaker_ip: room_ip.to_string(),
                    stream_url: rincon_uri.clone(),
                    codec,
                    role: GroupRole::Slave,
                    coordinator_ip: Some(coordinator_ip.to_string()),
                    coordinator_uuid: Some(coordinator_uuid.to_string()),
                    old_group,
                });
                self.emit_event(StreamEvent::PlaybackStarted {
                    stream_id: stream_id.to_string(),
                    speaker_ip: room_ip.to_string(),
                    stream_url: rincon_uri.clone(),
                    timestamp: now_millis(),
                });
                log::info!("[Regroup] {room_ip} joined {coordinator_ip}");
                JoinOutcome {
                    result: PlaybackResult {
                        speaker_ip: room_ip.to_string(),
                        success: true,
                        stream_url: Some(rincon_uri),
                        error: None,
                    },
                    left_group,
                }
            }
            Err(e) => {
                log::warn!("[Regroup] {room_ip} could not join {coordinator_ip}: {e}");
                JoinOutcome {
                    result: failed(room_ip, format!("Failed to join group: {e}")),
                    left_group,
                }
            }
        }
    }

    /// Records `room_ip` as a member of the cast's group it is already in:
    /// nothing is sent to the speaker. A room recorded already keeps its
    /// session; one playing another stream is taken over from it.
    pub(crate) fn adopt_room(
        &self,
        room_ip: &str,
        coordinator_ip: &str,
        coordinator_uuid: &str,
        stream_id: &str,
        codec: AudioCodec,
        old_group: Option<OldGroup>,
    ) -> PlaybackResult {
        let rincon_uri = format!("x-rincon:{coordinator_uuid}");
        if self.sessions.get(stream_id, room_ip).is_none() {
            if let Some((old_key, old_session)) =
                self.sessions.find_other_stream(room_ip, stream_id)
            {
                self.sessions
                    .remove(&old_key.stream_id, &old_key.speaker_ip);
                self.emit_event(StreamEvent::PlaybackStopped {
                    stream_id: old_session.stream_id,
                    speaker_ip: room_ip.to_string(),
                    reason: Some(SpeakerRemovalReason::SpeakerTakenOver),
                    timestamp: now_millis(),
                });
            }
            self.sessions.insert(PlaybackSession {
                stream_id: stream_id.to_string(),
                speaker_ip: room_ip.to_string(),
                stream_url: rincon_uri.clone(),
                codec,
                role: GroupRole::Slave,
                coordinator_ip: Some(coordinator_ip.to_string()),
                coordinator_uuid: Some(coordinator_uuid.to_string()),
                old_group,
            });
            self.emit_event(StreamEvent::PlaybackStarted {
                stream_id: stream_id.to_string(),
                speaker_ip: room_ip.to_string(),
                stream_url: rincon_uri.clone(),
                timestamp: now_millis(),
            });
        }
        PlaybackResult {
            speaker_ip: room_ip.to_string(),
            success: true,
            stream_url: Some(rincon_uri),
            error: None,
        }
    }

    /// Ends the session of a room someone regrouped out of the cast, without
    /// sending it anything: the household has taken it.
    pub(crate) async fn drop_regrouped_room(&self, stream_id: &str, room_ip: &str) {
        log::info!("[Regroup] {room_ip} was regrouped outside the cast; ending its session");
        self.sessions.remove(stream_id, room_ip);
        self.leave_sync_session(room_ip).await;
        self.emit_event(StreamEvent::PlaybackStopped {
            stream_id: stream_id.to_string(),
            speaker_ip: room_ip.to_string(),
            reason: Some(SpeakerRemovalReason::SourceChanged),
            timestamp: now_millis(),
        });
    }

    /// Ends the session of a speaker that switched to another source, and,
    /// when it led the cast's group, the sessions of the rooms that follow
    /// it: they play the new source with it now. Nothing is sent to any
    /// speaker and nothing is put back: the household took the rooms.
    ///
    /// A speaker the companion is moving off the stream itself (see
    /// [`PlaybackSessionStore::release`]) is left alone: that stop or
    /// promotion owns its session.
    ///
    /// Returns the stream the speaker played, if it had a session.
    pub(crate) fn end_after_source_change(&self, speaker_ip: &str) -> Option<String> {
        if self.sessions.is_releasing(speaker_ip) {
            log::debug!(
                "Source change on {speaker_ip} ignored: the companion is moving it off the stream"
            );
            return None;
        }
        let key = self.sessions.get_key_by_speaker_ip(speaker_ip)?;
        let stream_id = key.stream_id;
        let session = self.sessions.remove(&stream_id, speaker_ip)?;
        let followers: Vec<String> = if session.role == GroupRole::Coordinator {
            self.sessions
                .get_slaves_for_coordinator(&stream_id, speaker_ip)
                .into_iter()
                .map(|(key, _)| key.speaker_ip)
                .collect()
        } else {
            Vec::new()
        };
        log::info!(
            "Removed playback session for {} due to source change (stream: {}, {} following)",
            speaker_ip,
            stream_id,
            followers.len()
        );
        let mut ended = vec![speaker_ip.to_string()];
        ended.extend(followers);
        for ip in &ended {
            self.end_session(&stream_id, ip, Some(SpeakerRemovalReason::SourceChanged));
        }
        // Release their sync sessions, as a stop does, a lone room's too: left
        // in it, its group's level would never be followed again, and the
        // next cast to take it would not read its own.
        ended.retain(|ip| self.arbiter.is_in_sync_session(ip));
        if !ended.is_empty() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let arbiter = Arc::clone(&self.arbiter);
                let callback_url = self.network.gena_callback_url();
                runtime.spawn(async move {
                    for ip in ended {
                        arbiter.leave_sync_session(&ip, &callback_url).await;
                    }
                });
            }
        }
        self.cleanup_stream_if_no_sessions(&stream_id);
        Some(stream_id)
    }

    /// Enters the sync session for every speaker of `stream_id`.
    pub(crate) async fn enter_stream_sync_session(&self, stream_id: &str) {
        self.enter_sync_session(stream_id).await;
    }

    /// Sets the topology refresh notifier.
    pub fn set_topology_refresh(&mut self, notify: Arc<Notify>) {
        self.topology_refresh = Some(notify);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────────

    /// Emits a stream event to all listeners.
    fn emit_event(&self, event: StreamEvent) {
        self.emitter.emit_stream(event);
    }

    /// Schedules a delayed topology refresh.
    ///
    /// Sonos needs time to propagate zone group changes internally after
    /// accepting a join/unjoin command. A direct SOAP query immediately after
    /// would return stale data.
    pub(crate) fn schedule_topology_refresh(&self) {
        if let Some(ref notify) = self.topology_refresh {
            let notify = Arc::clone(notify);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                notify.notify_one();
            });
        }
    }

    /// Enters a sync session for all speakers in the given stream.
    async fn enter_sync_session(&self, stream_id: &str) {
        let callback_url = self.network.gena_callback_url();
        let speaker_ips = self.sessions.get_ips_for_stream(stream_id);
        let entering: Vec<String> = speaker_ips
            .iter()
            .filter(|ip| !self.arbiter.is_in_sync_session(ip))
            .cloned()
            .collect();
        self.arbiter
            .enter_sync_session(&speaker_ips, &callback_url)
            .await;
        self.announce_own_levels(entering).await;
    }

    /// Reads the own level and mute of each room that has just entered the
    /// sync session, once they are followed, and records and broadcasts them
    /// as its `own` events.
    ///
    /// A room's own level otherwise comes only from the first
    /// RenderingControl event after subscribing, and Sonos sends nothing
    /// more until the level changes. That first event is lost when it
    /// reaches the callback before the subscribe reply is handled (its SID
    /// is not known yet), so a room that joins a cast without a level change
    /// would show no level for as long as it plays. The reads are made in
    /// parallel and each is short, so the start waits little for them; an
    /// event handled after them is newer and replaces what they recorded.
    async fn announce_own_levels(&self, ips: Vec<String>) {
        let Some(volume) = self.volume.as_deref() else {
            return;
        };
        let reads = ips.iter().map(|ip| async move {
            let (level, muted) = futures::future::join(
                read_own(|| volume.get_speaker_volume(ip)),
                read_own(|| volume.get_speaker_mute(ip)),
            )
            .await;
            (ip, level, muted)
        });
        for (ip, level, muted) in futures::future::join_all(reads).await {
            if let Some(level) = level {
                self.sonos_state.group_volumes.insert(ip.clone(), level);
                self.emitter.emit_sonos(SonosEvent::GroupVolume {
                    speaker_ip: ip.clone(),
                    volume: level,
                    fixed: None,
                    own: true,
                    timestamp: now_millis(),
                });
            } else {
                log::debug!("[SyncGroupManager] {ip}: could not read its own level");
            }
            if let Some(muted) = muted {
                self.sonos_state.group_mutes.insert(ip.clone(), muted);
                self.emitter.emit_sonos(SonosEvent::GroupMute {
                    speaker_ip: ip.clone(),
                    muted,
                    own: true,
                    timestamp: now_millis(),
                });
            }
        }
    }

    /// Leaves a sync session for a single speaker.
    async fn leave_sync_session(&self, speaker_ip: &str) {
        let callback_url = self.network.gena_callback_url();
        self.arbiter
            .leave_sync_session(speaker_ip, &callback_url)
            .await;
    }

    /// Cleans up a stream if no playback sessions remain.
    pub(crate) fn cleanup_stream_if_no_sessions(&self, stream_id: &str) {
        let has_remaining_sessions = self.sessions.has_sessions_for_stream(stream_id);

        if !has_remaining_sessions {
            log::info!(
                "[SyncGroupManager] Last speaker removed from stream {}, ending stream",
                stream_id
            );
            self.stream_registry.remove_stream(stream_id);
            self.emit_event(StreamEvent::Ended {
                stream_id: stream_id.to_string(),
                timestamp: now_millis(),
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Stop orchestration
    // ─────────────────────────────────────────────────────────────────────────────

    /// Session store's sessions for `stream_id`.
    fn stream_sessions(&self, stream_id: &str) -> Vec<PlaybackSession> {
        self.sessions
            .get_ips_for_stream(stream_id)
            .iter()
            .filter_map(|ip| self.sessions.get(stream_id, ip))
            .collect()
    }

    /// Room UUIDs of the speakers of `sessions`, as `seen` names them.
    fn room_uuids(&self, seen: &Household, sessions: &[PlaybackSession]) -> HashSet<String> {
        sessions
            .iter()
            .filter_map(|s| self.room_uuid(seen, &s.speaker_ip))
            .collect()
    }

    /// The room UUID of the speaker at `ip`: from `seen`, else the cache.
    fn room_uuid(&self, seen: &Household, ip: &str) -> Option<String> {
        seen.uuid_of(ip)
            .or_else(|| self.sonos_state.get_member_uuid_by_ip(ip))
    }

    /// The household as a stop sees it: read fresh when anything may need
    /// putting back or checking, else the cache.
    async fn household_for_stop(&self, sessions: &[PlaybackSession]) -> Household {
        let needs_fresh = sessions
            .iter()
            .any(|s| s.role == GroupRole::Slave || s.old_group.is_some());
        let ips: Vec<String> = sessions.iter().map(|s| s.speaker_ip.clone()).collect();
        let groups = if needs_fresh {
            self.fresh_groups(&ips).await
        } else {
            self.sonos_state.groups.read().clone()
        };
        Household { groups }
    }

    /// Splits a cast group's slaves for a stop: rooms to make leave, rooms
    /// that stay grouped with the coordinator because they were grouped with
    /// it before the cast, and rooms someone else has regrouped since, which
    /// get nothing at all.
    fn split_slaves(&self, seen: &Household, slaves: Vec<PlaybackSession>) -> SlaveSplit {
        let mut split = SlaveSplit::default();
        for slave in slaves {
            if !seen.still_follows(&slave.speaker_ip, slave.coordinator_uuid.as_deref()) {
                log::info!(
                    "[GroupSync] {} was regrouped by someone else; leaving it alone",
                    slave.speaker_ip
                );
                split.regrouped.push(slave);
            } else if slave.old_group.as_ref().is_some_and(|g| g.kept) {
                split.stay.push(slave);
            } else {
                split.leave.push(slave);
            }
        }
        split
    }

    /// Whether the cast coordinator at `ip` is put back when it stops: it
    /// left a group for the cast (or every room it kept has gone), and it
    /// still leads a group of cast rooms only, so nobody else regrouped it.
    fn coordinator_goes_back(
        &self,
        seen: &Household,
        coordinator: &PlaybackSession,
        cast_rooms: &HashSet<String>,
        keeps_partners: bool,
    ) -> bool {
        let Some(old) = &coordinator.old_group else {
            return false;
        };
        if old.kept && keeps_partners {
            return false;
        }
        let ours = self
            .room_uuid(seen, &coordinator.speaker_ip)
            .is_some_and(|uuid| seen.leads_only(&uuid, cast_rooms));
        if !ours {
            log::info!(
                "[GroupSync] {} was regrouped by someone else; not putting it back",
                coordinator.speaker_ip
            );
        }
        ours
    }

    /// A [`Leaving`] for a room that recorded its old group.
    fn leaving(&self, seen: &Household, session: &PlaybackSession) -> Option<Leaving> {
        let old_group = session.old_group.clone()?;
        Some(Leaving {
            uuid: self.room_uuid(seen, &session.speaker_ip)?,
            ip: session.speaker_ip.clone(),
            old_group,
        })
    }

    /// Puts rooms that have just left a cast back into the groups they were
    /// in (see [`plan_restore`]), with no Play. Every room of the cast that
    /// is not being put back is listed in `other_cast_rooms`, so no room is
    /// ever sent into a group the cast still plays in. Best effort: a room
    /// that cannot be put back is left standing alone.
    async fn put_back(
        &self,
        seen: &Household,
        leaving: &[Leaving],
        other_cast_rooms: &HashSet<String>,
    ) -> usize {
        if leaving.is_empty() {
            return 0;
        }
        let rejoins = plan_restore(leaving, &seen.groups, other_cast_rooms);
        let futures = rejoins.iter().map(|rejoin| async move {
            match self
                .sonos
                .rejoin_group(&rejoin.ip, &rejoin.coordinator_uuid)
                .await
            {
                Ok(()) => log::info!(
                    "[GroupSync] Put {} back into the group of {}",
                    rejoin.ip,
                    rejoin.coordinator_uuid
                ),
                Err(e) => log::warn!(
                    "[GroupSync] Could not put {} back into the group of {}: {} (left standing alone)",
                    rejoin.ip,
                    rejoin.coordinator_uuid,
                    e
                ),
            }
        });
        futures::future::join_all(futures).await;
        rejoins.len()
    }

    /// Puts back the rooms a failed cast start moved: called by the start
    /// path, which already holds the regroup lock. The grouping is read
    /// fresh, since the start itself may just have promoted a room.
    pub(crate) async fn put_back_after_failed_start(
        &self,
        moved: &[(String, OldGroup)],
        other_cast_rooms: &HashSet<String>,
    ) {
        if moved.is_empty() {
            return;
        }
        let ips: Vec<String> = moved.iter().map(|(ip, _)| ip.clone()).collect();
        let seen = Household {
            groups: self.fresh_groups(&ips).await,
        };
        let leaving: Vec<Leaving> = moved
            .iter()
            .filter_map(|(ip, old_group)| {
                Some(Leaving {
                    uuid: self.room_uuid(&seen, ip)?,
                    ip: ip.clone(),
                    old_group: old_group.clone(),
                })
            })
            .collect();
        if self.put_back(&seen, &leaving, other_cast_rooms).await > 0 {
            self.schedule_topology_refresh();
        }
    }

    /// Stops every speaker of `streams` (best effort), puts their rooms back,
    /// and ends the streams: their sessions are removed and their HTTP
    /// closed, before the speaker calls for a stream whose codec needs that
    /// ([`CleanupOrder::HttpFirst`]) and after them otherwise.
    ///
    /// All of it runs under the regroup lock, and the speakers are read from
    /// the sessions only once the lock is held: a cast start still joining
    /// rooms finishes first, so the rooms it joined are stopped and put back
    /// too, and once the lock is released the streams are gone, so a start
    /// queued behind it finds no stream to play.
    ///
    /// With `budget`, the speaker calls are cut off that long after the
    /// lock is held (a shutdown bounds them); the streams still end. The
    /// wait for the lock is not counted: a cast start in flight is bounded by
    /// its own speaker timeouts, and counting it would leave rooms it joined
    /// playing and out of their groups.
    pub async fn stop_streams(&self, streams: &[(String, CleanupOrder)], budget: Option<Duration>) {
        let _regroup = self.lock_regroup().await;
        let by = budget.map(|budget| tokio::time::Instant::now() + budget);
        // The stop switches every room to its queue, out of the group or back
        // into an old one before the sessions are removed below: none of
        // their NOTIFYs is a source change meanwhile.
        let _releasing = self.sessions.release(
            streams
                .iter()
                .flat_map(|(id, _)| self.sessions.get_ips_for_stream(id)),
        );
        for (stream_id, order) in streams {
            if *order == CleanupOrder::HttpFirst {
                self.stream_registry.remove_stream(stream_id);
            }
        }
        let ids: Vec<String> = streams.iter().map(|(id, _)| id.clone()).collect();
        match by {
            Some(deadline) => {
                if tokio::time::timeout_at(deadline, self.stop_locked(&ids))
                    .await
                    .is_err()
                {
                    log::warn!("[GroupSync] Ran out of time stopping and putting rooms back");
                    self.schedule_topology_refresh();
                }
            }
            None => self.stop_locked(&ids).await,
        }
        for (stream_id, order) in streams {
            self.sessions.remove_all_for_stream(stream_id);
            if *order == CleanupOrder::SoapFirst {
                self.stream_registry.remove_stream(stream_id);
            }
        }
    }

    /// The speaker calls of [`Self::stop_streams`], under the regroup lock,
    /// with the grouping read fresh:
    /// 1. Slaves leave the cast's group, except rooms that were grouped with
    ///    the coordinator before the cast (they stay with it) and rooms
    ///    someone else has regrouped since (they are not touched).
    /// 2. Coordinators are stopped and switched to their queue.
    /// 3. Rooms that left a group for the cast are put back (see
    ///    [`plan_restore`]), with no Play; the coordinator only if it still
    ///    leads a group of cast rooms only and every slave that had to leave
    ///    it did. A slave that could not leave stays where it is.
    ///
    /// A speaker whose session belongs to another stream is never touched,
    /// so this teardown cannot silence a cast that has just replaced it.
    async fn stop_locked(&self, stream_ids: &[String]) {
        let mut coordinators: Vec<PlaybackSession> = Vec::new();
        let mut slaves = Vec::new();
        for stream_id in stream_ids {
            for ip in self.sessions.get_ips_for_stream(stream_id) {
                let Some(session) = self.sessions.get(stream_id, &ip) else {
                    continue;
                };
                match session.role {
                    GroupRole::Coordinator => coordinators.push(session),
                    GroupRole::Slave => slaves.push(session),
                }
            }
        }
        if coordinators.is_empty() && slaves.is_empty() {
            return;
        }

        let all: Vec<PlaybackSession> = coordinators.iter().chain(&slaves).cloned().collect();
        let seen = self.household_for_stop(&all).await;
        let any_slaves = !slaves.is_empty();
        let split = self.split_slaves(&seen, slaves);
        let cast_rooms = self.room_uuids(&seen, &all);

        log::debug!(
            "[GroupSync] stop: {} coordinators, {} slaves leaving, {} staying, {} regrouped",
            coordinators.len(),
            split.leave.len(),
            split.stay.len(),
            split.regrouped.len()
        );

        // Both blocks end with leave_sync_session so the arbiter clears sync_ips
        // and restores GroupRenderingControl subscriptions for each speaker.
        // Without this, sync_ips retains stale entries indefinitely (no GENA
        // expiry), causing TopologyMonitor to permanently skip GRC subscriptions.

        // Block 1 (parallel across slaves): leave_group → leave_sync_session
        let stuck = self.leave_slaves(&split).await;

        // Block 2 (parallel across coordinators, AFTER block 1):
        // stop → switch_to_queue → leave_sync_session
        {
            let futures: Vec<_> = coordinators
                .iter()
                .map(|session| async move {
                    let ip = &session.speaker_ip;
                    if let Err(e) = self.sonos.stop(ip).await {
                        log::warn!("[GroupSync] Failed to stop {}: {}", ip, e);
                    }

                    if let Some(uuid) = self.sonos_state.get_coordinator_uuid_by_ip(ip) {
                        if let Err(e) = self.sonos.switch_to_queue(ip, &uuid).await {
                            log::warn!("[GroupSync] Failed to switch {} to queue: {}", ip, e);
                        }
                    }

                    self.leave_sync_session(ip).await;
                })
                .collect();
            futures::future::join_all(futures).await;
        }

        // Block 3: put the rooms back.
        let mut leaving: Vec<Leaving> = split
            .leave
            .iter()
            .filter(|s| !stuck.contains(&s.speaker_ip))
            .filter_map(|s| self.leaving(&seen, s))
            .collect();
        for session in &coordinators {
            let ip = session.speaker_ip.as_str();
            let follows = |s: &PlaybackSession| s.coordinator_ip.as_deref() == Some(ip);
            if split
                .leave
                .iter()
                .any(|s| follows(s) && stuck.contains(&s.speaker_ip))
            {
                log::warn!("[GroupSync] A room still follows {ip}; not putting {ip} back");
                continue;
            }
            let keeps_partners = split.stay.iter().any(follows);
            if self.coordinator_goes_back(&seen, session, &cast_rooms, keeps_partners) {
                leaving.extend(self.leaving(&seen, session));
            }
        }
        let gone: HashSet<&str> = leaving.iter().map(|l| l.uuid.as_str()).collect();
        let others: HashSet<String> = cast_rooms
            .iter()
            .filter(|uuid| !gone.contains(uuid.as_str()))
            .cloned()
            .collect();
        let restored = self.put_back(&seen, &leaving, &others).await;

        if any_slaves || restored > 0 {
            self.schedule_topology_refresh();
        }
    }

    /// Makes the slaves in `split.leave` leave the cast's group, in
    /// parallel, and releases every slave's sync session. Returns the IPs of
    /// the slaves that could not leave: they still follow their coordinator.
    async fn leave_slaves(&self, split: &SlaveSplit) -> HashSet<String> {
        let leaving = split.leave.iter().map(|s| (s, true));
        let others = split
            .stay
            .iter()
            .chain(&split.regrouped)
            .map(|s| (s, false));
        let futures: Vec<_> = leaving
            .chain(others)
            .map(|(session, leave)| async move {
                let ip = &session.speaker_ip;
                let mut stuck = None;
                if leave {
                    if let Err(e) = self.sonos.leave_group(ip).await {
                        log::warn!("[GroupSync] Failed to unjoin slave {}: {}", ip, e);
                        stuck = Some(ip.clone());
                    }
                }
                self.leave_sync_session(ip).await;
                stuck
            })
            .collect();
        futures::future::join_all(futures)
            .await
            .into_iter()
            .flatten()
            .collect()
    }

    /// Tears down a speaker from a stream: leaves the sync session, removes
    /// its session, and emits a `PlaybackStopped` event.
    pub(crate) async fn teardown_speaker(
        &self,
        stream_id: &str,
        speaker_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) {
        self.leave_sync_session(speaker_ip).await;
        self.end_session(stream_id, speaker_ip, reason);
    }

    /// Removes a speaker's session and emits a `PlaybackStopped` event; its
    /// sync session is left to the caller.
    fn end_session(&self, stream_id: &str, speaker_ip: &str, reason: Option<SpeakerRemovalReason>) {
        self.sessions.remove(stream_id, speaker_ip);
        self.emit_event(StreamEvent::PlaybackStopped {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
            reason,
            timestamp: now_millis(),
        });
    }

    /// Hands each running cast led by one of `taken` (rooms `stream_id` is
    /// about to take) on to a room it keeps, so it plays on there; the caller
    /// holds the regroup lock.
    ///
    /// A cast's other rooms follow its coordinator with `x-rincon`. Taking
    /// the coordinator as it stands (stopping it, or making it leave its
    /// group) stops them with it or leaves Sonos to promote one of them to
    /// play the stream unseen, which the companion then reads as a source
    /// change, ending the cast; which of those happened came down to timing.
    /// The cast is handed on as Remove hands it on instead: one of its other
    /// rooms takes the stream, the rest re-join it, and the taken room ends
    /// its session there as [`SpeakerRemovalReason::SpeakerTakenOver`],
    /// stopped and standing alone, ready for the new cast. A cast every one
    /// of whose rooms is taken is left to the taking.
    pub(crate) async fn hand_on_taken(&self, stream_id: &str, taken: &[String]) {
        for ip in taken {
            let Some((key, session)) = self.sessions.find_other_stream(ip, stream_id) else {
                continue;
            };
            if session.role != GroupRole::Coordinator {
                continue;
            }
            let other = key.stream_id;
            let keeps_one = self
                .sessions
                .get_slaves_for_coordinator(&other, ip)
                .iter()
                .any(|(slave, _)| !taken.contains(&slave.speaker_ip));
            if !keeps_one {
                continue;
            }
            log::info!(
                "[GroupSync] {ip} leads stream {other} and is taken by {stream_id}; handing {other} on"
            );
            let _releasing = self
                .sessions
                .release(self.sessions.get_ips_for_stream(&other));
            let seen = self.household_for_stop(&self.stream_sessions(&other)).await;
            let reason = Some(SpeakerRemovalReason::SpeakerTakenOver);
            if let Err(e) = self
                .promote_slave_to_coordinator(&seen, &other, ip, reason, Promotion::Taken(taken))
                .await
            {
                log::warn!("[GroupSync] Could not hand {other} on ({e}); stopping it");
                self.stop_coordinator_and_slaves(&seen, &other, ip, reason, None)
                    .await;
            }
            self.schedule_topology_refresh();
        }
    }

    /// Stops a specific speaker for a stream, choosing the appropriate strategy
    /// based on the speaker's role, and puts its room back where it was.
    ///
    /// - **Slave**: unjoins just this speaker; coordinator and other slaves continue.
    /// - **Coordinator with slaves**: attempts to promote a slave to coordinator;
    ///   falls back to full teardown if promotion fails.
    /// - **Coordinator without slaves**: tears down the coordinator.
    ///
    /// Runs under the regroup lock, with the grouping read fresh. Triggers a
    /// topology refresh when sync-group membership changes.
    ///
    /// # Returns
    /// List of speaker IPs that were stopped. Empty if the session was not found
    /// or the stop command failed.
    pub async fn stop_speaker_for_stream(
        &self,
        stream_id: &str,
        speaker_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> Vec<String> {
        let _regroup = self.lock_regroup().await;
        let session = match self.sessions.get(stream_id, speaker_ip) {
            Some(s) => s,
            None => return Vec::new(),
        };
        // Every room of the cast may be switched to its queue, out of the
        // group or into another below, before its session is removed or
        // rewritten: none of their NOTIFYs is a source change meanwhile.
        let _releasing = self
            .sessions
            .release(self.sessions.get_ips_for_stream(stream_id));
        let seen = self
            .household_for_stop(&self.stream_sessions(stream_id))
            .await;

        let is_sync =
            session.role == GroupRole::Slave || self.sessions.has_slaves_for_stream(stream_id);

        let stopped = match session.role {
            GroupRole::Slave => {
                self.stop_slave_speaker(&seen, stream_id, speaker_ip, reason)
                    .await
            }
            GroupRole::Coordinator => {
                let has_slaves = !self
                    .sessions
                    .get_slaves_for_coordinator(stream_id, speaker_ip)
                    .is_empty();

                if has_slaves {
                    match self
                        .promote_slave_to_coordinator(
                            &seen,
                            stream_id,
                            speaker_ip,
                            reason,
                            Promotion::Removed,
                        )
                        .await
                    {
                        Ok(stopped) => stopped,
                        Err(e) => {
                            log::warn!(
                                "[GroupSync] Promotion failed ({}), falling back to teardown",
                                e
                            );
                            self.stop_coordinator_and_slaves(
                                &seen,
                                stream_id,
                                speaker_ip,
                                reason,
                                Some(session),
                            )
                            .await
                        }
                    }
                } else {
                    self.stop_coordinator_and_slaves(&seen, stream_id, speaker_ip, reason, None)
                        .await
                }
            }
        };

        if is_sync && !stopped.is_empty() {
            self.schedule_topology_refresh();
        }

        stopped
    }

    /// Stops a slave speaker by unjoining it from the group, then puts its
    /// room back where it was.
    ///
    /// Only affects this speaker - the coordinator and other slaves continue
    /// playing. A room someone else has regrouped since gets no leave and no
    /// restore: its session simply ends.
    ///
    /// # Returns
    /// List containing the stopped speaker IP on success, empty on failure.
    async fn stop_slave_speaker(
        &self,
        seen: &Household,
        stream_id: &str,
        speaker_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> Vec<String> {
        log::info!(
            "[GroupSync] Stopping slave speaker {} from stream {}",
            speaker_ip,
            stream_id
        );

        let Some(session) = self.sessions.get(stream_id, speaker_ip) else {
            return Vec::new();
        };
        let cast_rooms = self.room_uuids(seen, &self.stream_sessions(stream_id));
        let ours = seen.still_follows(speaker_ip, session.coordinator_uuid.as_deref());

        if ours {
            if let Err(e) = self.sonos.leave_group(speaker_ip).await {
                log::warn!("[GroupSync] Failed to unjoin slave {}: {}", speaker_ip, e);
                self.emit_event(StreamEvent::PlaybackStopFailed {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    error: e.to_string(),
                    reason,
                    timestamp: now_millis(),
                });
                return Vec::new();
            }
        } else {
            log::info!(
                "[GroupSync] {} was regrouped by someone else; ending its session only",
                speaker_ip
            );
        }

        self.teardown_speaker(stream_id, speaker_ip, reason).await;

        if ours {
            if let Some(leaving) = self.leaving(seen, &session) {
                let others: HashSet<String> = cast_rooms
                    .into_iter()
                    .filter(|uuid| *uuid != leaving.uuid)
                    .collect();
                self.put_back(seen, &[leaving], &others).await;
            }
        }

        let remaining_slaves = self.sessions.has_slaves_for_stream(stream_id);
        if !remaining_slaves {
            if let Some(coord_ip) = self.sessions.find_coordinator_ip_for_stream(stream_id) {
                self.leave_sync_session(&coord_ip).await;
            }
        }

        self.cleanup_stream_if_no_sessions(stream_id);

        vec![speaker_ip.to_string()]
    }

    /// Stops a coordinator speaker and all its associated slaves, then puts
    /// their rooms back.
    ///
    /// Cascade operation:
    /// 1. Unjoin each slave (rooms that were grouped with the coordinator
    ///    before the cast stay with it; rooms regrouped since are not touched)
    /// 2. Stop the coordinator
    /// 3. Put back the rooms that left a group for the cast; the coordinator
    ///    only once no slave that had to leave still follows it
    ///
    /// `old_coordinator` is the coordinator's session when a failed
    /// promotion has already ended it, so it can still be put back.
    ///
    /// # Returns
    /// List of stopped speaker IPs.
    async fn stop_coordinator_and_slaves(
        &self,
        seen: &Household,
        stream_id: &str,
        coordinator_ip: &str,
        reason: Option<SpeakerRemovalReason>,
        old_coordinator: Option<PlaybackSession>,
    ) -> Vec<String> {
        log::info!(
            "[GroupSync] Stopping coordinator {} and its slaves from stream {}",
            coordinator_ip,
            stream_id
        );

        let in_store = self.sessions.get(stream_id, coordinator_ip);
        let has_session = in_store.is_some();
        let coordinator = in_store.or(old_coordinator);
        let mut stream_sessions = self.stream_sessions(stream_id);
        if let (false, Some(session)) = (has_session, &coordinator) {
            stream_sessions.push(session.clone());
        }
        let cast_rooms = self.room_uuids(seen, &stream_sessions);
        let slaves: Vec<PlaybackSession> = self
            .sessions
            .get_slaves_for_coordinator(stream_id, coordinator_ip)
            .into_iter()
            .map(|(_, session)| session)
            .collect();
        let split = self.split_slaves(seen, slaves);

        let stuck = self.leave_slaves(&split).await;
        let mut stopped_ips = Vec::new();
        for session in split
            .leave
            .iter()
            .chain(&split.stay)
            .chain(&split.regrouped)
        {
            self.end_session(stream_id, &session.speaker_ip, reason);
            stopped_ips.push(session.speaker_ip.clone());
        }
        let mut leaving: Vec<Leaving> = split
            .leave
            .iter()
            .filter(|s| !stuck.contains(&s.speaker_ip))
            .filter_map(|s| self.leaving(seen, s))
            .collect();

        let coordinator_uuid = coordinator
            .as_ref()
            .and_then(|s| s.coordinator_uuid.clone())
            .or_else(|| self.sonos_state.get_coordinator_uuid_by_ip(coordinator_ip));

        let stopped = match self.sonos.stop(coordinator_ip).await {
            Ok(()) => {
                if let Some(uuid) = coordinator_uuid {
                    if let Err(e) = self.sonos.switch_to_queue(coordinator_ip, &uuid).await {
                        log::warn!(
                            "[GroupSync] Failed to switch coordinator {} to queue: {}",
                            coordinator_ip,
                            e
                        );
                    }
                }

                if has_session {
                    self.teardown_speaker(stream_id, coordinator_ip, reason)
                        .await;
                }
                if let Some(session) = &coordinator {
                    if !stuck.is_empty() {
                        log::warn!(
                            "[GroupSync] A room still follows {coordinator_ip}; not putting it back"
                        );
                    } else if self.coordinator_goes_back(
                        seen,
                        session,
                        &cast_rooms,
                        !split.stay.is_empty(),
                    ) {
                        leaving.extend(self.leaving(seen, session));
                    }
                }
                stopped_ips.push(coordinator_ip.to_string());
                true
            }
            Err(e) => {
                log::warn!(
                    "[GroupSync] Failed to stop coordinator {}: {}",
                    coordinator_ip,
                    e
                );
                self.emit_event(StreamEvent::PlaybackStopFailed {
                    stream_id: stream_id.to_string(),
                    speaker_ip: coordinator_ip.to_string(),
                    error: e.to_string(),
                    reason,
                    timestamp: now_millis(),
                });
                false
            }
        };

        let gone: HashSet<&str> = leaving.iter().map(|l| l.uuid.as_str()).collect();
        let others: HashSet<String> = cast_rooms
            .iter()
            .filter(|uuid| !gone.contains(uuid.as_str()))
            .cloned()
            .collect();
        self.put_back(seen, &leaving, &others).await;

        if stopped {
            self.cleanup_stream_if_no_sessions(stream_id);
        }
        stopped_ips
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Coordinator promotion
    // ─────────────────────────────────────────────────────────────────────────────

    /// Promotes a slave to coordinator when the current coordinator is removed.
    ///
    /// Instead of tearing down the entire group, picks a slave to become the
    /// new coordinator: it leaves the group and is given the stream, the
    /// remaining slaves leave and rejoin it, and then the old coordinator is
    /// put back where it was before the cast.
    ///
    /// With [`Promotion::Taken`] the old coordinator is going to another
    /// cast: it is not switched to its queue or put back, and no room that
    /// cast takes too is picked.
    ///
    /// # Returns
    /// List of stopped speaker IPs (only the old coordinator).
    /// On failure, returns `Err` so the caller can fall back to full teardown.
    async fn promote_slave_to_coordinator(
        &self,
        seen: &Household,
        stream_id: &str,
        coordinator_ip: &str,
        reason: Option<SpeakerRemovalReason>,
        promotion: Promotion<'_>,
    ) -> Result<Vec<String>, String> {
        // 1. Gather info from coordinator session
        let coord_session = self
            .sessions
            .get(stream_id, coordinator_ip)
            .ok_or("Coordinator session not found")?;

        let stream_url = coord_session.stream_url.clone();
        let codec = coord_session.codec;
        let coordinator_uuid = coord_session.coordinator_uuid.clone();
        let cast_rooms = self.room_uuids(seen, &self.stream_sessions(stream_id));
        let taken = match promotion {
            Promotion::Removed => None,
            Promotion::Taken(rooms) => Some(rooms),
        };
        // Decided before anything moves: whether the old coordinator still
        // leads a group of cast rooms only. One going to another cast stays.
        let goes_back =
            taken.is_none() && self.coordinator_goes_back(seen, &coord_session, &cast_rooms, false);

        // 2. Gather slave sessions
        let slave_sessions = self
            .sessions
            .get_slaves_for_coordinator(stream_id, coordinator_ip);

        // 3. Pick the first slave to promote that is not being taken too.
        // Every room re-forms around it, so none of them stays in a group it
        // was in before the cast.
        let Some(chosen) = slave_sessions
            .iter()
            .position(|(key, _)| !taken.is_some_and(|rooms| rooms.contains(&key.speaker_ip)))
        else {
            return Err("No slaves found to promote".to_string());
        };
        let promoted_ip = slave_sessions[chosen].0.speaker_ip.clone();
        let promoted_old_group = moved(slave_sessions[chosen].1.old_group.clone());
        let promoted_uuid = self
            .sonos_state
            .get_member_uuid_by_ip(&promoted_ip)
            .ok_or_else(|| format!("No UUID for promoted slave {}", promoted_ip))?;

        // 4. Get stream state for audio_format, metadata, artwork_url
        let stream_state = self
            .stream_registry
            .get_stream(stream_id)
            .ok_or("Stream state not found")?;
        let audio_format = stream_state.audio_format;
        let metadata = stream_state.metadata.read().clone();
        let artwork_url = self.network.url_builder().artwork_url();

        log::info!(
            "[GroupSync] Promoting slave {} (uuid={}) to coordinator, replacing {} (stream={})",
            promoted_ip,
            promoted_uuid,
            coordinator_ip,
            stream_id
        );

        // 5. Stop old coordinator
        if let Err(e) = self.sonos.stop(coordinator_ip).await {
            log::warn!(
                "[GroupSync] Failed to stop old coordinator {}: {}",
                coordinator_ip,
                e
            );
            // Continue - the speaker may already be stopped
        }

        // One going to another cast is given that cast's stream next.
        if let (None, Some(uuid)) = (taken, &coordinator_uuid) {
            if let Err(e) = self.sonos.switch_to_queue(coordinator_ip, uuid).await {
                log::warn!(
                    "[GroupSync] Failed to switch old coordinator {} to queue: {}",
                    coordinator_ip,
                    e
                );
            }
        }

        self.teardown_speaker(stream_id, coordinator_ip, reason)
            .await;

        // 6. Promote the chosen slave.
        //
        // Under the speaker's start lock: another client may be starting its
        // own stream on this very speaker right now, and that start removes our
        // slave session, stops the speaker and inserts its own. Without the
        // lock the SOAP calls below would interleave with that start and the
        // insert would displace the other client's session with no event, so
        // the speaker would play this stream while the store said otherwise.
        // Holding the lock also serialises with promote's own callers: nothing
        // that reaches here holds a speaker lock (it is entered from the stop
        // path), so this can never nest. The guard also admits the promoted
        // speaker as a reader of the stream: it fetches the URL the moment
        // `play_uri` lands, before the coordinator session below exists, and
        // its old slave session may already be gone by then.
        let promoted_start = self
            .sessions
            .lock_speaker_start(stream_id, &promoted_ip)
            .await;
        if self.sessions.get(stream_id, &promoted_ip).is_none() {
            return Err(format!(
                "Slave {} was taken by another stream while waiting to promote it",
                promoted_ip
            ));
        }

        if let Err(e) = self.sonos.leave_group(&promoted_ip).await {
            log::warn!(
                "[GroupSync] Failed to unjoin promoted slave {}: {}",
                promoted_ip,
                e
            );
            // Continue - may already be detached if coordinator stopped
        }

        self.sonos
            .play_uri(
                &promoted_ip,
                &stream_url,
                codec,
                &audio_format,
                Some(&metadata),
                &artwork_url,
            )
            .await
            .map_err(|e| {
                format!(
                    "Failed to start stream on promoted slave {}: {}",
                    promoted_ip, e
                )
            })?;

        // Update promoted slave's session to coordinator role
        self.sessions.insert(PlaybackSession {
            stream_id: stream_id.to_string(),
            speaker_ip: promoted_ip.clone(),
            stream_url: stream_url.clone(),
            codec,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some(promoted_uuid.clone()),
            old_group: promoted_old_group,
        });

        drop(promoted_start);

        log::info!(
            "[GroupSync] Promoted {} to coordinator successfully",
            promoted_ip
        );

        // 7. Re-point remaining slaves to new coordinator. Those the other
        // cast takes too stay with the old coordinator, which it takes with
        // them: they move once, with it.
        let remaining_slaves: Vec<(PlaybackSessionKey, PlaybackSession)> = slave_sessions
            .into_iter()
            .filter(|(key, _)| key.speaker_ip != promoted_ip)
            .filter(|(key, _)| !taken.is_some_and(|rooms| rooms.contains(&key.speaker_ip)))
            .collect();

        let repoint_futures: Vec<_> = remaining_slaves
            .iter()
            // No `move` — promoted_ip/promoted_uuid are owned Strings that outlive join_all,
            // so borrowing avoids cloning them into each future.
            .map(|(slave_key, slave_session)| async {
                // Same race as the promotion above, per slave. Each future
                // locks only its own speaker, so they still run concurrently.
                let _start = self
                    .sessions
                    .lock_speaker_start(stream_id, &slave_key.speaker_ip)
                    .await;
                if self
                    .sessions
                    .get(stream_id, &slave_key.speaker_ip)
                    .is_none()
                {
                    log::info!(
                        "[GroupSync] Slave {} was taken by another stream; not re-pointing it",
                        slave_key.speaker_ip
                    );
                    return Repoint::Done;
                }

                log::debug!(
                    "[GroupSync] Re-pointing slave {} to new coordinator {}",
                    slave_key.speaker_ip,
                    promoted_ip
                );

                if let Err(e) = self.sonos.leave_group(&slave_key.speaker_ip).await {
                    log::warn!(
                        "[GroupSync] Failed to unjoin slave {} during re-point: {}",
                        slave_key.speaker_ip,
                        e
                    );
                    return Repoint::StillFollows;
                }

                if let Err(e) = self
                    .sonos
                    .join_group(&slave_key.speaker_ip, &promoted_uuid)
                    .await
                {
                    log::warn!(
                        "[GroupSync] Failed to re-point slave {} to new coordinator {}: {}",
                        slave_key.speaker_ip,
                        promoted_ip,
                        e
                    );
                    return Repoint::Stranded(slave_session.clone());
                }

                // Update session to point to new coordinator
                let rincon_uri = format!("x-rincon:{}", promoted_uuid);
                self.sessions.insert(PlaybackSession {
                    stream_id: stream_id.to_string(),
                    speaker_ip: slave_key.speaker_ip.clone(),
                    stream_url: rincon_uri,
                    codec,
                    role: GroupRole::Slave,
                    coordinator_ip: Some(promoted_ip.clone()),
                    coordinator_uuid: Some(promoted_uuid.clone()),
                    old_group: moved(slave_session.old_group.clone()),
                });
                Repoint::Done
            })
            .collect();

        let repoints = futures::future::join_all(repoint_futures).await;

        // A room that left but could not join the new coordinator stands
        // alone: its session ends, and it goes back to its old group.
        let mut leaving: Vec<Leaving> = Vec::new();
        for repoint in &repoints {
            if let Repoint::Stranded(session) = repoint {
                self.teardown_speaker(
                    stream_id,
                    &session.speaker_ip,
                    Some(SpeakerRemovalReason::PlaybackStopped),
                )
                .await;
                leaving.extend(self.leaving(seen, session));
            }
        }

        // 8. Put the old coordinator back where it was before the cast, once
        // no room that failed to leave it still follows it.
        let still_followed = repoints.iter().any(|r| matches!(r, Repoint::StillFollows));
        if still_followed {
            log::warn!("[GroupSync] A room still follows {coordinator_ip}; not putting it back");
        } else if goes_back {
            leaving.extend(self.leaving(seen, &coord_session));
        }
        if !leaving.is_empty() {
            let gone: HashSet<&str> = leaving.iter().map(|l| l.uuid.as_str()).collect();
            let others: HashSet<String> = self
                .room_uuids(seen, &self.stream_sessions(stream_id))
                .into_iter()
                .filter(|uuid| !gone.contains(uuid.as_str()))
                .collect();
            self.put_back(seen, &leaving, &others).await;
        }

        // 9. Cleanup stream if no sessions remain (edge case)
        self.cleanup_stream_if_no_sessions(stream_id);

        Ok(vec![coordinator_ip.to_string()])
    }
}

/// Why a cast's coordinator is handed on (see
/// [`SyncGroupManager::promote_slave_to_coordinator`]).
#[derive(Clone, Copy)]
enum Promotion<'a> {
    /// It was removed from the cast, and goes back where it was.
    Removed,
    /// Another cast takes it, along with these rooms (by IP).
    Taken(&'a [String]),
}

/// What re-pointing one slave to a promoted coordinator did.
enum Repoint {
    /// It follows the new coordinator, or another stream took it first.
    Done,
    /// It could not leave, so it still follows the old coordinator.
    StillFollows,
    /// It left but could not join the new coordinator: it stands alone.
    Stranded(PlaybackSession),
}

/// `old` with `kept` cleared: the room has moved into a group it was not in.
fn moved(old: Option<OldGroup>) -> Option<OldGroup> {
    old.map(|group| OldGroup {
        kept: false,
        ..group
    })
}

/// A cast group's slaves, split for a stop (see
/// [`SyncGroupManager::split_slaves`]).
#[derive(Default)]
struct SlaveSplit {
    leave: Vec<PlaybackSession>,
    stay: Vec<PlaybackSession>,
    regrouped: Vec<PlaybackSession>,
}

/// The household's grouping as one stop or restore read it.
struct Household {
    groups: Vec<ZoneGroup>,
}

impl Household {
    /// The player UUID of the speaker at `ip`.
    fn uuid_of(&self, ip: &str) -> Option<String> {
        self.groups
            .iter()
            .flat_map(|g| &g.members)
            .find(|m| m.ip == ip)
            .map(|m| m.uuid.clone())
    }

    /// Whether the speaker at `ip` still follows `coordinator_uuid`. A
    /// speaker missing from the grouping counts as following, as before.
    fn still_follows(&self, ip: &str, coordinator_uuid: Option<&str>) -> bool {
        match self
            .groups
            .iter()
            .find(|g| g.members.iter().any(|m| m.ip == ip))
        {
            Some(group) => Some(group.coordinator_uuid.as_str()) == coordinator_uuid,
            None => true,
        }
    }

    /// Whether `uuid` leads a group whose rooms are all in `rooms`.
    fn leads_only(&self, uuid: &str, rooms: &HashSet<String>) -> bool {
        let Some(group) = self.groups.iter().find(|g| g.coordinator_uuid == uuid) else {
            return false;
        };
        super::start_volume::rooms(std::slice::from_ref(group))
            .iter()
            .all(|room| rooms.contains(&room.uuid))
    }
}
