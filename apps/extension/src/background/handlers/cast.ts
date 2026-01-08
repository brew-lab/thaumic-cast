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
import type { EncoderConfig, StreamMetadata } from '@thaumic-cast/protocol';
import type {
  StartCastMessage,
  StopCastMessage,
  ExtensionResponse,
  StartPlaybackResponse,
} from '../../lib/messages';
import { getSourceFromUrl } from '../../lib/url-utils';
import { loadExtensionSettings } from '../../lib/settings';
import { getCachedCodecSupport } from '../../lib/codec-cache';
import { selectEncoderConfig, describeConfig } from '../../lib/device-config';
import { resolveAudioMode, describeEncoderConfig } from '../../lib/presets';
import { getCachedState, updateCache } from '../metadata-cache';
import { registerSession, hasSession, getSessionCount } from '../session-manager';
import { getSonosState as getStoredSonosState } from '../sonos-state';
import { getConnectionState, clearConnectionState } from '../connection-state';
import { stopCastForTab } from '../sonos-event-handlers';
import { ensureOffscreen } from '../offscreen-manager';
import { detectAndCacheCodecSupport } from '../codec-support';
import { discoverAndCache, connectWebSocket } from './connection';

const log = createLogger('Background');

/**
 * Logic for starting a new cast session.
 *
 * @param msg - The start cast message.
 * @param sendResponse - Callback to send results back to the caller.
 */
export async function handleStartCast(
  msg: StartCastMessage,
  sendResponse: (res: ExtensionResponse) => void,
): Promise<void> {
  let finished = false;
  const safeSendResponse = (res: ExtensionResponse) => {
    if (!finished) {
      sendResponse(res);
      finished = true;
    }
  };

  try {
    const { speakerIps } = msg.payload;
    if (!speakerIps.length) throw new Error('error_no_speakers_selected');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('error_no_active_tab');

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
    let encoderConfig: EncoderConfig;

    // Load extension settings and cached codec support
    const settings = await loadExtensionSettings();
    let codecSupport = await getCachedCodecSupport();

    // If codec support not cached, try to detect now (should rarely happen after startup fix)
    if (!codecSupport || codecSupport.availableCodecs.length === 0) {
      log.info('Codec support not cached, detecting now...');
      codecSupport = await detectAndCacheCodecSupport();
    }

    if (codecSupport && codecSupport.availableCodecs.length > 0) {
      // Use preset resolution with codec detection
      try {
        encoderConfig = resolveAudioMode(
          settings.audioMode,
          codecSupport,
          settings.customAudioSettings,
        );
        log.info(
          `Encoder config (${settings.audioMode} mode): ${describeEncoderConfig(encoderConfig)}`,
        );
      } catch (err) {
        // Preset resolution failed, fall back to device-config
        log.warn('Preset resolution failed, falling back to device config:', err);
        encoderConfig = await selectEncoderConfig();
        log.info(`Encoder config (fallback): ${describeConfig(encoderConfig)}`);
      }
    } else {
      // Codec detection failed entirely, fall back to device-config
      log.warn('Codec detection failed, using device config fallback');
      encoderConfig = await selectEncoderConfig();
      log.info(`Encoder config (fallback): ${describeConfig(encoderConfig)}`);
    }

    // 5. Capture Tab
    const mediaStreamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => {
        if (id) resolve(id);
        else reject(new Error('error_capture_denied'));
      });
    });

    // 6. Connect control WebSocket if not already connected
    if (!getConnectionState().connected) {
      await connectWebSocket(app.url);
    }

    // 7. Start Offscreen Session
    const response: ExtensionResponse = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      payload: {
        tabId: tab.id,
        mediaStreamId,
        encoderConfig,
        baseUrl: app.url,
      },
    });

    if (response.success && response.streamId) {
      // Get cached state to build initial metadata for Sonos display
      const cachedState = getCachedState(tab.id);

      // Construct StreamMetadata with source for proper Sonos album display
      const initialMetadata: StreamMetadata | undefined = cachedState?.metadata
        ? {
            ...cachedState.metadata,
            source: cachedState.source,
          }
        : cachedState?.source
          ? { source: cachedState.source }
          : undefined;

      // 8. Start playback via WebSocket (waits for STREAM_READY internally)
      // Include initial metadata so Sonos displays correct info immediately
      const playbackResponse: StartPlaybackResponse = await chrome.runtime.sendMessage({
        type: 'START_PLAYBACK',
        payload: { tabId: tab.id, speakerIps, metadata: initialMetadata },
      });

      // Filter successful results for session registration
      const successfulResults = playbackResponse.results.filter((r) => r.success);

      if (successfulResults.length === 0) {
        // All speakers failed - clean up the capture
        log.error('All playback attempts failed, cleaning up capture');
        await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId: tab.id } });
        throw new Error('error_playback_failed');
      }

      // Log partial failures
      const failedResults = playbackResponse.results.filter((r) => !r.success);
      if (failedResults.length > 0) {
        for (const failed of failedResults) {
          log.warn(`Playback failed on ${failed.speakerIp}: ${failed.error}`);
        }
      }

      // Build arrays of successful speakers
      const sonosState = getStoredSonosState();
      const successfulIps = successfulResults.map((r) => r.speakerIp);
      const successfulNames = successfulResults.map((r) => {
        const group = sonosState.groups.find((g) => g.coordinatorIp === r.speakerIp);
        return group?.name ?? r.speakerIp;
      });

      // Derive source from tab URL for cache
      const source = getSourceFromUrl(tab.url);

      // Ensure cache has tab info for ActiveCast display (even without MediaSession metadata)
      if (!getCachedState(tab.id)) {
        updateCache(tab.id, { title: tab.title, favIconUrl: tab.favIconUrl, source }, null);
      }

      // Register the session with successful speakers only
      registerSession(tab.id, response.streamId, successfulIps, successfulNames, encoderConfig);

      safeSendResponse({ success: true });
    } else {
      // Offscreen capture failed - no cleanup needed
      safeSendResponse(response);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Cast failed: ${message}`);
    safeSendResponse({ success: false, error: message });
  }
}

/**
 * Logic for stopping the active cast session.
 *
 * @param msg - The stop cast message.
 * @param sendResponse - Callback to send results back to the caller.
 */
export async function handleStopCast(
  msg: StopCastMessage,
  sendResponse: (res: ExtensionResponse) => void,
): Promise<void> {
  try {
    // Prefer explicitly provided tabId if available
    let tabId = msg.payload?.tabId;

    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }

    if (tabId && hasSession(tabId)) {
      await stopCastForTab(tabId);
    }
    sendResponse({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Stop cast failed: ${message}`);
    sendResponse({ success: false, error: message });
  }
}

/**
 * Returns the cast status for the current tab.
 *
 * @param sendResponse - Callback to send status back to the caller.
 */
export async function handleGetStatus(
  sendResponse: (res: ExtensionResponse) => void,
): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isActive = !!(tab?.id && hasSession(tab.id));
    sendResponse({ success: true, isActive });
  } catch {
    sendResponse({ success: false, isActive: false });
  }
}
