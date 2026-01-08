/**
 * Message Handlers Module
 *
 * Central message dispatcher for offscreen document.
 *
 * Responsibilities:
 * - Route messages to appropriate handlers
 * - Coordinate control connection and stream sessions
 * - Handle codec detection
 *
 * Non-responsibilities:
 * - WebSocket management (handled by control-connection.ts)
 * - Audio streaming (handled by stream-session.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import { detectSupportedCodecs } from '@thaumic-cast/protocol';
import type { OffscreenInboundMessage } from '../lib/messages';
import type {
  StartCaptureMessage,
  StopCaptureMessage,
  StartPlaybackMessage,
  StartPlaybackResponse,
  OffscreenMetadataMessage,
  WsConnectMessage,
  SyncSonosStateMessage,
} from '../lib/messages';
import {
  connectControlWebSocket,
  disconnectControlWebSocket,
  sendControlCommand,
  getWsStatus,
  getControlConnection,
  setCachedSonosState,
} from './control-connection';
import { StreamSession, activeSessions, MAX_OFFSCREEN_SESSIONS } from './stream-session';

const log = createLogger('Offscreen');

/**
 * Chrome-specific constraints for tab audio capture.
 * Standard MediaStreamConstraints doesn't include these Chrome-specific properties.
 */
interface ChromeTabCaptureConstraints {
  audio: {
    mandatory: {
      chromeMediaSource: 'tab';
      chromeMediaSourceId: string;
    };
  };
  video: false;
}

/**
 * Sets up the global message listener for offscreen document control.
 */
export function setupMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((msg: OffscreenInboundMessage, _sender, sendResponse) => {
    // ─────────────────────────────────────────────────────────────────────────
    // WebSocket Control Messages
    // ─────────────────────────────────────────────────────────────────────────

    if (msg.type === 'WS_CONNECT') {
      const { url } = msg as WsConnectMessage;
      connectControlWebSocket(url);
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'WS_DISCONNECT') {
      disconnectControlWebSocket();
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'WS_RECONNECT') {
      const { url } = msg as { url?: string };
      const controlConnection = getControlConnection();
      if (url) {
        disconnectControlWebSocket();
        connectControlWebSocket(url);
      } else if (controlConnection) {
        controlConnection.reconnectAttempts = 0;
        if (controlConnection.reconnectTimer) {
          clearTimeout(controlConnection.reconnectTimer);
          controlConnection.reconnectTimer = null;
        }
        connectControlWebSocket(controlConnection.url);
      }
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'GET_WS_STATUS') {
      sendResponse(getWsStatus());
      return true;
    }

    if (msg.type === 'SYNC_SONOS_STATE') {
      const { state } = msg as SyncSonosStateMessage;
      setCachedSonosState(state);
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'SET_VOLUME') {
      const { speakerIp, volume } = msg as { speakerIp: string; volume: number };
      // Desktop expects: { type: "SET_VOLUME", payload: { ip, volume } }
      const success = sendControlCommand({
        type: 'SET_VOLUME',
        payload: { ip: speakerIp, volume },
      });
      sendResponse({ success });
      return true;
    }

    if (msg.type === 'SET_MUTE') {
      const { speakerIp, muted } = msg as { speakerIp: string; muted: boolean };
      // Desktop expects: { type: "SET_MUTE", payload: { ip, mute } }
      const success = sendControlCommand({
        type: 'SET_MUTE',
        payload: { ip: speakerIp, mute: muted },
      });
      sendResponse({ success });
      return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Codec Detection (AudioEncoder only available in window contexts)
    // ─────────────────────────────────────────────────────────────────────────

    if (msg.type === 'DETECT_CODECS') {
      detectSupportedCodecs()
        .then((result) => {
          log.info(
            `Codec detection complete: ${result.availableCodecs.length} codecs (default: ${result.defaultCodec})`,
          );
          sendResponse({ success: true, result });
        })
        .catch((err) => {
          log.error('Codec detection failed:', err);
          sendResponse({ success: false, error: String(err) });
        });
      return true; // Will respond asynchronously
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Audio Capture Messages
    // ─────────────────────────────────────────────────────────────────────────

    if (msg.type === 'START_CAPTURE') {
      const { tabId, mediaStreamId, encoderConfig, baseUrl } =
        msg.payload as StartCaptureMessage['payload'];

      // Prevent duplicate sessions for the same tab
      const existing = activeSessions.get(tabId);
      if (existing) {
        log.info(`Stopping existing session for tab ${tabId} before restart`);
        existing.stop();
        activeSessions.delete(tabId);
      }

      // Enforce global offscreen limit
      if (activeSessions.size >= MAX_OFFSCREEN_SESSIONS) {
        sendResponse({ success: false, error: 'error_max_sessions' });
        return true;
      }

      const constraints: ChromeTabCaptureConstraints = {
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: mediaStreamId,
          },
        },
        video: false,
      };

      // Chrome's getUserMedia accepts these non-standard constraints for tab capture
      navigator.mediaDevices
        .getUserMedia(constraints as MediaStreamConstraints)
        .then(async (stream) => {
          const session = new StreamSession(stream, encoderConfig, baseUrl);
          try {
            await session.init();
            activeSessions.set(tabId, session);
            sendResponse({ success: true, streamId: session.streamId });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendResponse({ success: false, error: message });
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Capture failed: ${message}`);
          sendResponse({ success: false, error: message });
        });
      return true;
    }

    if (msg.type === 'STOP_CAPTURE') {
      const tabId = (msg as StopCaptureMessage).payload.tabId;
      const session = activeSessions.get(tabId);
      if (session) {
        session.stop();
        activeSessions.delete(tabId);
      }
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'START_PLAYBACK') {
      const { tabId, speakerIps, metadata } = (msg as StartPlaybackMessage).payload;
      const session = activeSessions.get(tabId);

      if (!session) {
        const response: StartPlaybackResponse = {
          success: false,
          results: [],
          error: `No active session for tab ${tabId}`,
        };
        sendResponse(response);
        return true;
      }

      // Wait for stream to be ready, then start playback with initial metadata
      session
        .waitForReady()
        .then(() => session.startPlayback(speakerIps, metadata))
        .then((results) => {
          // Consider success if at least one speaker started
          const anySuccess = results.some((r) => r.success);
          const response: StartPlaybackResponse = {
            success: anySuccess,
            results,
          };
          sendResponse(response);
        })
        .catch((err) => {
          const response: StartPlaybackResponse = {
            success: false,
            results: [],
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(response);
        });
      return true;
    }

    if (msg.type === 'OFFSCREEN_METADATA_UPDATE') {
      const { tabId, metadata } = (msg as OffscreenMetadataMessage).payload;
      const session = activeSessions.get(tabId);
      if (session) {
        session.updateMetadata(metadata);
      }
      sendResponse({ success: true });
      return true;
    }

    return false;
  });
}
