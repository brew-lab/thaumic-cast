/**
 * Cast Session Handlers
 *
 * Handles starting, stopping, and querying cast sessions.
 *
 * Responsibilities:
 * - Orchestrate cast session lifecycle
 * - Coordinate discovery, capture, and playback
 * - Handle session registration
 *
 * Non-responsibilities:
 * - Offscreen document management (handled by offscreen-manager.ts)
 * - Codec detection (handled by codec-support.ts)
 * - Session storage (handled by session-manager.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import type { StreamMetadata } from '@thaumic-cast/protocol';
import { countRemoteStreams, roomsOf } from '@thaumic-cast/protocol';
import type {
  StartCastMessage,
  StopCastMessage,
  RemoveSpeakerMessage,
  AddRoomsMessage,
  AddRoomsResponse,
  ExtensionResponse,
} from '../../lib/messages';
import { KeyedError, errorParamsOf } from '../../lib/keyed-error';
import { captureDeniedError } from '../../lib/capture-denied';
import { getSourceFromUrl } from '../../lib/url-utils';
import { getActiveTab, getActiveTabId } from '../../lib/tab-utils';
import { loadExtensionSettings } from '../../lib/settings';
import { buildStartVolume } from '../../lib/start-level';
import { planCast } from '../../lib/cast-plan';
import { recordLastCast, refOf } from '../../lib/room-sets';
import { getCachedCodecSupport } from '../../lib/codec-cache';
import { describeEncoderConfig } from '../../lib/presets';
import { resolveAudio } from '../../lib/audio-resolver';
import { companionCapability } from '../../lib/capture-capability';
import { getCachedState, updateCache } from '../metadata-cache';
import {
  registerSession,
  addToSession,
  hasSession,
  getSession,
  getSessionCount,
  getAllSessions,
  hasTabCaptureSessions,
  hasBrowserCaptureSessions,
} from '../session-manager';
import { getSpeakerGroups, getSonosState } from '../sonos-state';
import { recordJoinFailed } from '../away-log';
import { getConnectionState, clearConnectionState } from '../connection-state';
import { stopCastForTab } from '../sonos-event-handlers';
import { ensureOffscreen } from '../offscreen-manager';
import { offscreenBroker } from '../offscreen-broker';
import { detectBrowserExecutable } from '../../lib/browser-detect';
import { detectAndCacheCodecSupport } from '../codec-support';
import { discoverAndCache, connectWebSocket } from './connection';

const log = createLogger('Background');

/**
 * The metadata a speaker shows when it starts playing a tab's cast.
 * @param tabId - The cast's tab
 * @returns The title, artist and source known for the tab, if any
 */
function metadataFor(tabId: number): StreamMetadata | undefined {
  const cachedState = getCachedState(tabId);
  if (cachedState?.metadata) {
    return {
      title: cachedState.metadata.title,
      artist: cachedState.metadata.artist,
      source: cachedState.source,
    };
  }
  return cachedState?.source ? { source: cachedState.source } : undefined;
}

/**
 * Logic for starting a new cast session.
 *
 * @param msg - The start cast message.
 * @returns Response indicating success or failure.
 */
export async function handleStartCast(msg: StartCastMessage): Promise<ExtensionResponse> {
  let disabledAutoDiscard = false;
  /**
   * True once a capture request has been sent to the offscreen document. From
   * then on the offscreen may hold a session for this tab, so any failure before
   * registerSession() must stop it or nothing in the popup can ever stop it.
   */
  let captureRequested = false;
  let tab: chrome.tabs.Tab | null | undefined;

  try {
    // The chosen rooms play through their Sonos groups' coordinators, planned
    // from this worker's own Sonos state so the popup's line and what is sent
    // agree (lib/cast-plan.ts).
    const { roomIds, startLevels } = msg.payload;
    const plan = planCast(roomIds, roomsOf(getSonosState().groups));
    const speakerIps = plan.targets;
    if (!speakerIps.length) throw new Error('error_no_speakers_selected');

    tab = await getActiveTab();
    if (!tab?.id) throw new Error('error_no_active_tab');
    const tabId = tab.id;

    // 1. Discover Desktop App and its limits (do this early to fail fast)
    const app = await discoverAndCache();
    if (!app) {
      clearConnectionState();
      throw new Error('error_desktop_not_found');
    }

    // 2. Check session limits. The companion's cap is global, not per-client,
    //    so other clients' streams occupy slots too - counting only our own map
    //    lets two browsers each think the last slot is theirs and fails the
    //    second one after tab capture has already started. The companion sends
    //    other clients' sessions redacted, which is enough to count them;
    //    countRemoteStreams drops the ones whose speakers have since stopped so
    //    a connect-time snapshot can't block a cast the companion would accept.
    const ownSpeakerIps = getAllSessions().flatMap((session) => session.speakerIps);
    if (getSessionCount() + countRemoteStreams(getSonosState(), ownSpeakerIps) >= app.maxStreams) {
      throw new KeyedError('error_max_sessions', { max: app.maxStreams });
    }

    // 3. Create offscreen document (needed for audio capture)
    await ensureOffscreen();

    // 4. Select encoder config based on extension settings
    const settings = await loadExtensionSettings();
    let codecSupport = await getCachedCodecSupport();

    // Ensure codec support is cached (should rarely need re-detection after startup)
    if (!codecSupport || codecSupport.availableCodecs.length === 0) {
      log.info('Codec support not cached, detecting now...');
      codecSupport = await detectAndCacheCodecSupport();
    }

    // Codec detection should always succeed (PCM is always supported)
    if (!codecSupport) {
      throw new Error('error_codec_detection_failed');
    }

    // Resolve the config this cast sends, through the resolver the options
    // page renders from. PCM is always supported, so this will always succeed.
    // What discovery just learned about the companion answers for it here,
    // whether or not the control connection is up yet.
    const { appType, browserCapture } = getConnectionState();
    const { config: encoderConfig, captureRefused } = resolveAudio(
      settings,
      codecSupport,
      companionCapability({ connected: true, appType, browserCapture }),
    );
    if (captureRefused) {
      // Not stopped here: what the companion said at discovery may be out of
      // date, and its own refusal is the one that counts.
      log.warn('Browser-wide capture is on, and the companion reported it cannot capture');
    }
    log.info(
      `Encoder config (${settings.audioMode} mode, ${settings.captureMode} capture): ` +
        describeEncoderConfig(encoderConfig),
    );

    // 5. Prevent mixing capture modes (tab + browser capture cannot coexist)
    if (settings.captureMode === 'browser' && hasTabCaptureSessions()) {
      throw new Error('error_stop_tab_capture_first');
    }
    if (settings.captureMode === 'tab' && hasBrowserCaptureSessions()) {
      throw new Error('error_stop_browser_capture_first');
    }

    // 6. Branch on capture mode
    let captureResponse: ExtensionResponse;
    let captureMode: 'tab' | 'browser';

    if (settings.captureMode === 'browser') {
      // ─── Browser-wide capture path (WASAPI) ─────────────────────────────
      captureMode = 'browser';

      if (!getConnectionState().connected) {
        await connectWebSocket(app.url);
      }

      captureRequested = true;
      // Name our own browser so the companion captures this process tree and
      // not whichever supported browser happens to have started first.
      const response = await offscreenBroker.startBrowserCapture(
        tabId,
        app.url,
        encoderConfig,
        detectBrowserExecutable(),
      );
      if (!response) throw new Error('error_offscreen_unavailable');
      captureResponse = response;
    } else {
      // ─── Tab capture path (default) ──────────────────────────────────────
      captureMode = 'tab';

      const mediaStreamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (id) {
            resolve(id);
            return;
          }
          // Chrome's reason is only readable inside this callback, and reading
          // it also stops Chrome logging an unchecked lastError.
          const reason = chrome.runtime.lastError?.message;
          log.warn(`Tab capture refused for tab ${tabId}: ${reason ?? 'no reason given'}`);
          reject(captureDeniedError(reason));
        });
      });

      await chrome.tabs.update(tabId, { autoDiscardable: false });
      disabledAutoDiscard = true;

      if (!getConnectionState().connected) {
        await connectWebSocket(app.url);
      }

      captureRequested = true;
      const response = await offscreenBroker.startCapture(
        tabId,
        mediaStreamId,
        encoderConfig,
        app.url,
        { keepTabAudible: settings.keepTabAudible },
      );
      if (!response) throw new Error('error_offscreen_unavailable');
      captureResponse = response;
    }

    // ─── Shared post-capture flow (playback, session registration) ─────────

    if (captureResponse.success && captureResponse.streamId) {
      const initialMetadata = metadataFor(tabId);

      // Each room starts no louder than the limit, or at the level set by
      // hand in the popup. The companion applies it before anything plays.
      const playbackResponse = await offscreenBroker.startPlayback(
        tabId,
        speakerIps,
        initialMetadata,
        settings.syncSpeakers,
        settings.videoSyncEnabled,
        buildStartVolume(
          settings,
          plan.rooms.map((room) => room.id),
          startLevels,
        ),
      );
      if (!playbackResponse) throw new Error('error_offscreen_unavailable');

      const successfulResults = playbackResponse.results.filter((r) => r.success);
      if (successfulResults.length === 0) {
        // The catch block below stops the offscreen session
        log.error('All playback attempts failed, cleaning up capture');
        // A session that stopped itself says why, with the values its message
        // prints (a PCM rate stop); anything else is the general failure.
        if (playbackResponse.error && playbackResponse.errorParams) {
          throw new KeyedError(playbackResponse.error, playbackResponse.errorParams);
        }
        throw new Error('error_playback_failed');
      }

      for (const failed of playbackResponse.results.filter((r) => !r.success)) {
        log.warn(`Playback failed on ${failed.speakerIp}: ${failed.error}`);
      }

      const speakerGroups = getSpeakerGroups();
      const sortedResults = speakerGroups.sortByGroupName(successfulResults, (r) => r.speakerIp);
      const successfulIps = sortedResults.map((r) => r.speakerIp);
      const successfulNames = sortedResults.map((r) => speakerGroups.getGroupName(r.speakerIp));

      const source = getSourceFromUrl(tab.url);
      if (!getCachedState(tabId)) {
        updateCache(tabId, { title: tab.title, favIconUrl: tab.favIconUrl, source }, null);
      }

      // The chosen rooms whose target began playing.
      const castRooms = plan.rooms.filter((room) => successfulIps.includes(plan.targetOf[room.id]));
      registerSession(
        tabId,
        captureResponse.streamId,
        successfulIps,
        successfulNames,
        encoderConfig,
        settings.syncSpeakers,
        captureMode,
        settings.videoSyncEnabled,
        {
          ids: castRooms.map((room) => room.id),
          targets: Object.fromEntries(castRooms.map((room) => [room.id, plan.targetOf[room.id]])),
        },
      );
      await recordLastCast(castRooms.map(refOf));

      return { success: true };
    } else {
      if (disabledAutoDiscard) {
        chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
      }
      return captureResponse;
    }
  } catch (err) {
    // Re-enable auto-discard if we disabled it but failed before registering session
    if (disabledAutoDiscard && tab?.id) {
      chrome.tabs.update(tab.id, { autoDiscardable: true }).catch(() => {});
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Cast failed: ${message}`);

    // Stop any session the offscreen may have started (including when our
    // request timed out but the offscreen finished anyway), so an orphaned
    // stream never keeps playing with no registered session to stop it.
    if (captureRequested && tab?.id) {
      try {
        await offscreenBroker.stopSession(tab.id);
      } catch (cleanupErr) {
        log.warn(`Failed to stop offscreen session after cast failure: ${String(cleanupErr)}`);
      }
    }

    return { success: false, error: message, errorParams: errorParamsOf(err) };
  }
}

/**
 * Logic for stopping the active cast session.
 *
 * @param msg - The stop cast message.
 * @returns Response indicating success or failure.
 */
export async function handleStopCast(msg: StopCastMessage): Promise<ExtensionResponse> {
  try {
    // Prefer explicitly provided tabId if available
    let tabId = msg.payload?.tabId;

    if (!tabId) {
      tabId = (await getActiveTabId()) ?? undefined;
    }

    if (tabId && hasSession(tabId)) {
      await stopCastForTab(tabId);
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Stop cast failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Returns the cast status for the current tab.
 *
 * @returns Response with cast status.
 */
export async function handleGetStatus(): Promise<ExtensionResponse> {
  try {
    const tabId = await getActiveTabId();
    const isActive = !!(tabId && hasSession(tabId));
    return { success: true, isActive };
  } catch {
    return { success: false, isActive: false };
  }
}

/**
 * Removes a single speaker from an active cast session.
 * Sends the command to desktop - event flow handles session cleanup.
 *
 * @param msg - The remove speaker message.
 * @returns Response indicating success or failure.
 */
export async function handleRemoveSpeaker(msg: RemoveSpeakerMessage): Promise<ExtensionResponse> {
  const { tabId, speakerIp } = msg.payload;
  const session = getSession(tabId);

  if (!session) {
    return { success: false, error: 'No active session' };
  }

  if (!session.speakerIps.includes(speakerIp)) {
    return { success: false, error: 'Speaker not in session' };
  }

  try {
    // Pass 'user_removed' reason - server will propagate it in the PlaybackStopped event
    const success = await offscreenBroker.stopPlaybackSpeaker(
      session.streamId,
      speakerIp,
      'user_removed',
    );
    if (!success) {
      return { success: false, error: 'Failed to send command' };
    }
    return { success: true };
  } catch {
    return { success: false, error: 'Failed to send command' };
  }
}

/**
 * Adds rooms to a running cast.
 *
 * Until a room can join the cast's Sonos group (the regrouping work), each
 * new target plays the cast's stream on its own, as a cast to several rooms
 * does with "Play speakers as one group" off, and starts at its start level.
 * A room whose Sonos group already plays the cast is added at once. This is
 * the place to swap independent playback for a join.
 *
 * @param msg - The add rooms message
 * @returns How each room went
 */
export async function handleAddRooms(msg: AddRoomsMessage): Promise<AddRoomsResponse> {
  const { tabId, roomIds, startLevels } = msg.payload;
  const session = getSession(tabId);
  if (!session) return { success: false, error: 'No active session', rooms: [] };

  const plan = planCast(roomIds, roomsOf(getSonosState().groups));
  if (plan.rooms.length === 0) {
    return { success: false, error: 'error_no_speakers_selected', rooms: [] };
  }
  const newTargets = plan.targets.filter((ip) => !session.speakerIps.includes(ip));
  const results = new Map<string, { success: boolean; error?: string }>();

  if (newTargets.length > 0) {
    try {
      const settings = await loadExtensionSettings();
      const starting = plan.rooms.filter((room) => newTargets.includes(plan.targetOf[room.id]));
      const response = await offscreenBroker.startPlayback(
        tabId,
        newTargets,
        metadataFor(tabId),
        false,
        session.videoSync,
        buildStartVolume(
          settings,
          starting.map((room) => room.id),
          startLevels,
        ),
      );
      for (const result of response?.results ?? []) {
        results.set(result.speakerIp, { success: result.success, error: result.error });
      }
      if (!response) log.warn('Adding rooms: the offscreen document did not answer');
      else if (response.error) log.warn(`Adding rooms failed: ${response.error}`);
    } catch (err) {
      log.warn(`Adding rooms failed: ${String(err)}`);
    }
  }

  const joined = (targetIp: string): boolean =>
    session.speakerIps.includes(targetIp) || results.get(targetIp)?.success === true;
  const added = plan.rooms.filter((room) => joined(plan.targetOf[room.id]));
  const addedTargets = newTargets.filter((ip) => results.get(ip)?.success === true);
  const speakerGroups = getSpeakerGroups();
  addToSession(
    tabId,
    addedTargets,
    addedTargets.map((ip) => speakerGroups.getGroupName(ip)),
    {
      ids: added.map((room) => room.id),
      targets: Object.fromEntries(added.map((room) => [room.id, plan.targetOf[room.id]])),
    },
  );

  // A popup that shut while the rooms were joining hears of a failure in its away line.
  for (const room of plan.rooms) {
    if (!joined(plan.targetOf[room.id])) await recordJoinFailed(tabId, room.name);
  }

  return {
    success: added.length > 0,
    rooms: plan.rooms.map((room) => {
      const target = plan.targetOf[room.id];
      return joined(target)
        ? { roomId: room.id, joined: true }
        : {
            roomId: room.id,
            joined: false,
            error: results.get(target)?.error ?? 'error_playback_failed',
          };
    }),
  };
}
