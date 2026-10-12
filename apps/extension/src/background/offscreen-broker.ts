/**
 * Offscreen Message Broker
 *
 * Type-safe API for communicating with the offscreen document.
 * Encapsulates message construction and provides explicit method signatures.
 *
 * Benefits:
 * - Type-safe parameters and return types
 * - Encapsulated message construction
 * - Centralized error handling
 * - Auditable: all offscreen communication in one place
 */

import type {
  EncoderConfig,
  SonosStateSnapshot,
  SpeakerRemovalReason,
  StreamMetadata,
  SupportedCodecsResult,
} from '@thaumic-cast/protocol';
import type {
  ExtensionResponse,
  PlaybackRequest,
  StartPlaybackResponse,
  WsStatusResponse,
} from '../lib/messages';
import { sendToOffscreen, OFFSCREEN_LONG_OPERATION_TIMEOUT_MS } from './offscreen-manager';
import { noop } from '../lib/noop';
import { playbackTimeoutMs } from '../lib/message-schemas';

/**
 * Response from codec detection request.
 */
interface DetectCodecsResponse {
  success: boolean;
  result?: SupportedCodecsResult;
  error?: string;
}

/**
 * Type-safe broker for offscreen document communication.
 * Provides explicit methods instead of raw message passing.
 */
class OffscreenBroker {
  // ─────────────────────────────────────────────────────────────────────────────
  // Audio Capture
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Starts audio capture for a tab.
   * @param tabId - The tab ID to capture
   * @param mediaStreamId - The media stream ID from chrome.tabCapture
   * @param encoderConfig - The encoder configuration to use
   * @param baseUrl - The desktop app base URL for streaming
   * @param options - Additional capture options
   * @param options.keepTabAudible - Play audio at low volume to prevent Chrome throttling
   * @returns The capture response with stream ID on success
   */
  async startCapture(
    tabId: number,
    mediaStreamId: string,
    encoderConfig: EncoderConfig,
    baseUrl: string,
    options?: { keepTabAudible?: boolean },
  ): Promise<ExtensionResponse | undefined> {
    return sendToOffscreen<ExtensionResponse>(
      {
        type: 'START_CAPTURE',
        payload: {
          tabId,
          mediaStreamId,
          encoderConfig,
          baseUrl,
          keepTabAudible: options?.keepTabAudible,
        },
      },
      OFFSCREEN_LONG_OPERATION_TIMEOUT_MS,
    );
  }

  /**
   * Stops the capture session for a tab (works for both tab and browser capture).
   * @param tabId - The tab ID to stop
   */
  async stopSession(tabId: number): Promise<void> {
    await sendToOffscreen({ type: 'STOP_SESSION', payload: { tabId } });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Browser-wide Capture (WASAPI)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Starts browser-wide WASAPI capture via the desktop app.
   * @param tabId - The originating tab ID (for session association)
   * @param baseUrl - The desktop app base URL
   * @param encoderConfig - The encoder configuration (sample rate, channels, etc.)
   * @param browserName - Optional browser exe name for PID lookup
   * @returns The capture response with stream ID on success
   */
  async startBrowserCapture(
    tabId: number,
    baseUrl: string,
    encoderConfig: EncoderConfig,
    browserName?: string,
  ): Promise<ExtensionResponse | undefined> {
    return sendToOffscreen<ExtensionResponse>(
      {
        type: 'START_BROWSER_CAPTURE',
        payload: { tabId, baseUrl, encoderConfig, browserName },
      },
      OFFSCREEN_LONG_OPERATION_TIMEOUT_MS,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Playback Control
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Starts playback of a tab's stream on speakers.
   * @param tabId - The cast's tab
   * @param request - The speakers (and rooms), the metadata, video sync, and the start levels
   *   (only for a new cast or added rooms, never a resume)
   * @returns The playback response with per-speaker results
   */
  async startPlayback(
    tabId: number,
    request: PlaybackRequest,
  ): Promise<StartPlaybackResponse | undefined> {
    // The offscreen document times the call out itself; this only outlasts it.
    return sendToOffscreen<StartPlaybackResponse>(
      { type: 'START_PLAYBACK', payload: { tabId, ...request } },
      Math.max(OFFSCREEN_LONG_OPERATION_TIMEOUT_MS, playbackTimeoutMs(request) + 5_000),
    );
  }

  /**
   * Stops playback on a single speaker (partial removal from multi-group cast).
   * @param streamId - The stream ID
   * @param speakerIp - The speaker IP to stop
   * @param reason - Optional reason for stopping (propagated to server events)
   * @returns Whether the command was sent successfully
   */
  async stopPlaybackSpeaker(
    streamId: string,
    speakerIp: string,
    reason?: SpeakerRemovalReason,
  ): Promise<boolean> {
    const response = await sendToOffscreen<{ success: boolean }>({
      type: 'STOP_PLAYBACK_SPEAKER',
      streamId,
      speakerIp,
      reason,
    });
    return response?.success ?? false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WebSocket Connection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Connects the WebSocket to the desktop app.
   * @param url - The WebSocket URL to connect to
   */
  async connectWebSocket(url: string): Promise<void> {
    await sendToOffscreen({ type: 'WS_CONNECT', url });
  }

  /**
   * Disconnects the WebSocket.
   */
  async disconnectWebSocket(): Promise<void> {
    await sendToOffscreen({ type: 'WS_DISCONNECT' });
  }

  /**
   * Triggers WebSocket reconnection.
   * @param url - Optional URL to reconnect to (uses cached URL if not provided)
   */
  async reconnectWebSocket(url?: string): Promise<void> {
    await sendToOffscreen({ type: 'WS_RECONNECT', url });
  }

  /**
   * Gets the current WebSocket status.
   * @returns The WebSocket status including connection state and cached Sonos state
   */
  async getWebSocketStatus(): Promise<WsStatusResponse | undefined> {
    return sendToOffscreen<WsStatusResponse>({ type: 'GET_WS_STATUS' });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sonos Control
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sets volume for a speaker.
   * @param speakerIp - The speaker IP address
   * @param volume - The volume level (0-100)
   * @param group - When true, sets volume for the entire sync group
   * @returns Success response
   */
  async setVolume(
    speakerIp: string,
    volume: number,
    group?: boolean,
  ): Promise<{ success: boolean } | undefined> {
    return sendToOffscreen<{ success: boolean }>({ type: 'SET_VOLUME', speakerIp, volume, group });
  }

  /**
   * Sets mute state for a speaker.
   * @param speakerIp - The speaker IP address
   * @param muted - The mute state
   * @param group - When true, sets mute for the entire sync group
   * @returns Success response
   */
  async setMute(
    speakerIp: string,
    muted: boolean,
    group?: boolean,
  ): Promise<{ success: boolean } | undefined> {
    return sendToOffscreen<{ success: boolean }>({ type: 'SET_MUTE', speakerIp, muted, group });
  }

  /**
   * Syncs Sonos state to offscreen document.
   * Fire-and-forget: errors are silently ignored.
   * @param state - The Sonos state snapshot to sync
   */
  syncSonosState(state: SonosStateSnapshot): void {
    sendToOffscreen({ type: 'SYNC_SONOS_STATE', state }).catch(noop);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Updates metadata for a streaming tab.
   * Fire-and-forget: errors are silently ignored.
   * @param tabId - The tab ID
   * @param metadata - The metadata to send
   */
  updateMetadata(tabId: number, metadata: StreamMetadata): void {
    sendToOffscreen({
      type: 'OFFSCREEN_METADATA_UPDATE',
      payload: { tabId, metadata },
    }).catch(noop);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Codec Detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Detects supported audio codecs via the offscreen document.
   * AudioEncoder is only available in window contexts.
   * @returns The codec detection response
   */
  async detectCodecs(): Promise<DetectCodecsResponse | undefined> {
    return sendToOffscreen<DetectCodecsResponse>({ type: 'DETECT_CODECS' });
  }
}

/** Singleton instance of the offscreen broker */
export const offscreenBroker = new OffscreenBroker();
