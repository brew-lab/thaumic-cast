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
import type {
  StartCastMessage,
  StopCastMessage,
  RemoveSpeakerMessage,
  ExtensionResponse,
} from '../../lib/messages';
import { getSourceFromUrl } from '../../lib/url-utils';
import { getActiveTab, getActiveTabId } from '../../lib/tab-utils';
import { loadExtensionSettings } from '../../lib/settings';
import { getCachedCodecSupport } from '../../lib/codec-cache';
import { resolveAudioMode, describeEncoderConfig } from '../../lib/presets';
import { getCachedState, updateCache } from '../metadata-cache';
import { registerSession, hasSession, getSession, getSessionCount } from '../session-manager';
import { getSpeakerGroups } from '../sonos-state';
import { getConnectionState, clearConnectionState } from '../connection-state';
import { stopCastForTab } from '../sonos-event-handlers';
import { ensureOffscreen } from '../offscreen-manager';
import { offscreenBroker } from '../offscreen-broker';
import { detectAndCacheCodecSupport } from '../codec-support';
import { discoverAndCache, connectWebSocket } from './connection';

const log = createLogger('Background');

/**
 * Logic for starting a new cast session.
 *
 * @param msg - The start cast message.
 * @returns Response indicating success or failure.
 */
export async function handleStartCast(msg: StartCastMessage): Promise<ExtensionResponse> {
  let disabledAutoDiscard = false;
  let tab: chrome.tabs.Tab | null | undefined;

  try {
    const { speakerIps } = msg.payload;
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

    // 2. Check session limits
    if (getSessionCount() >= app.maxStreams) {
      throw new Error('error_max_sessions');
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

    // Resolve encoder config from audio mode settings
    // PCM is always supported, so this will always succeed
    const encoderConfig = resolveAudioMode(
      settings.audioMode,
      codecSupport,
      settings.customAudioSettings,
    );
    log.info(
      `Encoder config (${settings.audioMode} mode): ${describeEncoderConfig(encoderConfig)}`,
    );

    // 5. Capture Tab
    const mediaStreamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (id) resolve(id);
        else reject(new Error('error_capture_denied'));
      });
    });

    // Prevent Chrome from discarding the captured tab (Memory Saver exemption)
    // This helps maintain stream quality when the tab is backgrounded
    await chrome.tabs.update(tabId, { autoDiscardable: false });
    disabledAutoDiscard = true;

    // 6. Connect control WebSocket if not already connected
    if (!getConnectionState().connected) {
      await connectWebSocket(app.url);
    }

    // 7. Start Offscreen Session
    const response = await offscreenBroker.startCapture(
      tab.id,
      mediaStreamId,
      encoderConfig,
      app.url,
      { keepTabAudible: settings.keepTabAudible },
    );
    if (!response) throw new Error('error_offscreen_unavailable');

    if (response.success && response.streamId) {
      // Get cached state to build initial metadata for Sonos display
      const cachedState = getCachedState(tab.id);

      // Construct StreamMetadata with source for proper Sonos album display
      const initialMetadata: StreamMetadata | undefined = cachedState?.metadata
        ? {
            title: cachedState.metadata.title,
            artist: cachedState.metadata.artist,
            source: cachedState.source,
          }
        : cachedState?.source
          ? { source: cachedState.source }
          : undefined;

      // 8. Start playback via WebSocket (waits for STREAM_READY internally)
      // Include initial metadata so Sonos displays correct info immediately
      const playbackResponse = await offscreenBroker.startPlayback(
        tab.id,
        speakerIps,
        initialMetadata,
        settings.syncSpeakers,
        settings.videoSyncEnabled,
      );
      if (!playbackResponse) throw new Error('error_offscreen_unavailable');

      // Filter successful results for session registration
      const successfulResults = playbackResponse.results.filter((r) => r.success);

      if (successfulResults.length === 0) {
        // All speakers failed - clean up the capture
        log.error('All playback attempts failed, cleaning up capture');
        await offscreenBroker.stopCapture(tab.id);
        throw new Error('error_playback_failed');
      }

      // Log partial failures
      const failedResults = playbackResponse.results.filter((r) => !r.success);
      if (failedResults.length > 0) {
        for (const failed of failedResults) {
          log.warn(`Playback failed on ${failed.speakerIp}: ${failed.error}`);
        }
      }

      // Build arrays of successful speakers using domain model (sorted by name for consistent UI)
      const speakerGroups = getSpeakerGroups();
      const sortedResults = speakerGroups.sortByGroupName(successfulResults, (r) => r.speakerIp);
      const successfulIps = sortedResults.map((r) => r.speakerIp);
      const successfulNames = sortedResults.map((r) => speakerGroups.getGroupName(r.speakerIp));

      // Derive source from tab URL for cache
      const source = getSourceFromUrl(tab.url);

      // Ensure cache has tab info for ActiveCast display (even without MediaSession metadata)
      if (!getCachedState(tab.id)) {
        updateCache(tab.id, { title: tab.title, favIconUrl: tab.favIconUrl, source }, null);
      }

      // Register the session with successful speakers only
      registerSession(
        tab.id,
        response.streamId,
        successfulIps,
        successfulNames,
        encoderConfig,
        settings.syncSpeakers,
      );

      return { success: true };
    } else {
      // Offscreen capture failed - re-enable auto-discard since we won't register a session
      chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
      return response;
    }
  } catch (err) {
    // Re-enable auto-discard if we disabled it but failed before registering session
    if (disabledAutoDiscard && tab?.id) {
      chrome.tabs.update(tab.id, { autoDiscardable: true }).catch(() => {});
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Cast failed: ${message}`);
    return { success: false, error: message };
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
