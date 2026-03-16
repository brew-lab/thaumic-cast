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
import {
  registerSession,
  hasSession,
  getSession,
  getSessionCount,
  hasTabCaptureSessions,
  hasBrowserCaptureSessions,
} from '../session-manager';
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

    // 5. Prevent mixing capture modes (tab + browser capture cannot coexist)
    if (settings.captureMode === 'browser' && hasTabCaptureSessions()) {
      throw new Error('error_stop_tab_capture_first');
    }
    if (settings.captureMode === 'tab' && hasBrowserCaptureSessions()) {
      throw new Error('error_stop_browser_capture_first');
    }

    // 6. Branch on capture mode
    let captureResponse: { success: boolean; streamId?: string; error?: string };
    let captureMode: 'tab' | 'browser';
    const cleanupCapture = (id: number): Promise<void> =>
      offscreenBroker.stopSession(id).then(() => {});

    if (settings.captureMode === 'browser') {
      // ─── Browser-wide capture path (WASAPI) ─────────────────────────────
      captureMode = 'browser';

      if (!getConnectionState().connected) {
        await connectWebSocket(app.url);
      }

      const response = await offscreenBroker.startBrowserCapture(tabId, app.url, encoderConfig);
      if (!response) throw new Error('error_offscreen_unavailable');
      captureResponse = response;
    } else {
      // ─── Tab capture path (default) ──────────────────────────────────────
      captureMode = 'tab';

      const mediaStreamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (id) resolve(id);
          else reject(new Error('error_capture_denied'));
        });
      });

      await chrome.tabs.update(tabId, { autoDiscardable: false });
      disabledAutoDiscard = true;

      if (!getConnectionState().connected) {
        await connectWebSocket(app.url);
      }

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
      const cachedState = getCachedState(tabId);
      const initialMetadata: StreamMetadata | undefined = cachedState?.metadata
        ? {
            title: cachedState.metadata.title,
            artist: cachedState.metadata.artist,
            source: cachedState.source,
          }
        : cachedState?.source
          ? { source: cachedState.source }
          : undefined;

      const playbackResponse = await offscreenBroker.startPlayback(
        tabId,
        speakerIps,
        initialMetadata,
        settings.syncSpeakers,
        settings.videoSyncEnabled,
      );
      if (!playbackResponse) throw new Error('error_offscreen_unavailable');

      const successfulResults = playbackResponse.results.filter((r) => r.success);
      if (successfulResults.length === 0) {
        log.error('All playback attempts failed, cleaning up capture');
        await cleanupCapture(tabId);
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

      registerSession(
        tabId,
        captureResponse.streamId,
        successfulIps,
        successfulNames,
        encoderConfig,
        settings.syncSpeakers,
        captureMode,
      );

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
