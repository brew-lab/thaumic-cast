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
import {
  WsConnectMessageSchema,
  WsReconnectMessageSchema,
  SyncSonosStateMessageSchema,
  SetVolumeMessageSchema,
  SetMuteMessageSchema,
  StopPlaybackSpeakerMessageSchema,
  StartCaptureMessageSchema,
  StopCaptureMessageSchema,
  StartPlaybackMessageSchema,
  OffscreenMetadataMessageSchema,
  type StartPlaybackResponse,
} from '../lib/message-schemas';
import {
  connectControlWebSocket,
  disconnectControlWebSocket,
  sendControlCommand,
  getWsStatus,
  getControlConnection,
  setCachedSonosState,
} from './control-connection';
import { StreamSession, activeSessions, MAX_OFFSCREEN_SESSIONS } from './stream-session';
import { noop } from '../lib/noop';

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
      try {
        const validated = WsConnectMessageSchema.parse(msg);
        connectControlWebSocket(validated.url);
        sendResponse({ success: true });
      } catch (err) {
        log.error('WS_CONNECT validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === 'WS_DISCONNECT') {
      disconnectControlWebSocket();
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'WS_RECONNECT') {
      try {
        const validated = WsReconnectMessageSchema.parse(msg);
        const controlConnection = getControlConnection();
        if (validated.url) {
          disconnectControlWebSocket();
          connectControlWebSocket(validated.url);
        } else if (controlConnection) {
          controlConnection.reconnectAttempts = 0;
          if (controlConnection.reconnectTimer) {
            clearTimeout(controlConnection.reconnectTimer);
            controlConnection.reconnectTimer = null;
          }
          connectControlWebSocket(controlConnection.url);
        }
        sendResponse({ success: true });
      } catch (err) {
        log.error('WS_RECONNECT validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === 'GET_WS_STATUS') {
      sendResponse(getWsStatus());
      return true;
    }

    if (msg.type === 'SYNC_SONOS_STATE') {
      try {
        const validated = SyncSonosStateMessageSchema.parse(msg);
        setCachedSonosState(validated.state);
        sendResponse({ success: true });
      } catch (err) {
        log.error('SYNC_SONOS_STATE validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === 'SET_VOLUME') {
      try {
        const validated = SetVolumeMessageSchema.parse(msg);
        // Desktop expects: { type: "SET_VOLUME", payload: { ip, volume } }
        const success = sendControlCommand({
          type: 'SET_VOLUME',
          payload: { ip: validated.speakerIp, volume: validated.volume },
        });
        sendResponse({ success });
      } catch (err) {
        log.error('SET_VOLUME validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === 'SET_MUTE') {
      try {
        const validated = SetMuteMessageSchema.parse(msg);
        // Desktop expects: { type: "SET_MUTE", payload: { ip, mute } }
        const success = sendControlCommand({
          type: 'SET_MUTE',
          payload: { ip: validated.speakerIp, mute: validated.muted },
        });
        sendResponse({ success });
      } catch (err) {
        log.error('SET_MUTE validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === 'STOP_PLAYBACK_SPEAKER') {
      try {
        const validated = StopPlaybackSpeakerMessageSchema.parse(msg);
        const success = sendControlCommand({
          type: 'STOP_PLAYBACK_SPEAKER',
          payload: {
            streamId: validated.streamId,
            ip: validated.speakerIp,
            reason: validated.reason,
          },
        });
        sendResponse({ success });
      } catch (err) {
        log.error('STOP_PLAYBACK_SPEAKER validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
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
      try {
        const validated = StartCaptureMessageSchema.parse(msg);
        const { tabId, mediaStreamId, encoderConfig, baseUrl, keepTabAudible } = validated.payload;

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
            // Callback when worker WebSocket disconnects unexpectedly
            const onDisconnected = () => {
              activeSessions.delete(tabId);
              // Notify background that session was lost
              chrome.runtime.sendMessage({ type: 'SESSION_DISCONNECTED', tabId }).catch(noop);
            };

            const session = new StreamSession(stream, encoderConfig, baseUrl, onDisconnected, {
              keepTabAudible,
            });
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
      } catch (err) {
        log.error('START_CAPTURE validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === 'STOP_CAPTURE') {
      try {
        const validated = StopCaptureMessageSchema.parse(msg);
        const session = activeSessions.get(validated.payload.tabId);
        if (session) {
          session.stop();
          activeSessions.delete(validated.payload.tabId);
        }
        sendResponse({ success: true });
      } catch (err) {
        log.error('STOP_CAPTURE validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === 'START_PLAYBACK') {
      try {
        const validated = StartPlaybackMessageSchema.parse(msg);
        const { tabId, speakerIps, metadata } = validated.payload;
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
      } catch (err) {
        log.error('START_PLAYBACK validation failed:', err);
        const response: StartPlaybackResponse = {
          success: false,
          results: [],
          error: String(err),
        };
        sendResponse(response);
      }
      return true;
    }

    if (msg.type === 'OFFSCREEN_METADATA_UPDATE') {
      try {
        const validated = OffscreenMetadataMessageSchema.parse(msg);
        const session = activeSessions.get(validated.payload.tabId);
        if (session) {
          session.updateMetadata(validated.payload.metadata);
        }
        sendResponse({ success: true });
      } catch (err) {
        log.error('OFFSCREEN_METADATA_UPDATE validation failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    return false;
  });
}
