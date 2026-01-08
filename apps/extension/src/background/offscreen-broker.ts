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
  StreamMetadata,
  SupportedCodecsResult,
} from '@thaumic-cast/protocol';
import type { ExtensionResponse, StartPlaybackResponse, WsStatusResponse } from '../lib/messages';
import { sendToOffscreen } from './offscreen-manager';
import { noop } from '../lib/noop';

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
   * @returns The capture response with stream ID on success
   */
  async startCapture(
    tabId: number,
    mediaStreamId: string,
    encoderConfig: EncoderConfig,
    baseUrl: string,
  ): Promise<ExtensionResponse | undefined> {
    return sendToOffscreen<ExtensionResponse>({
      type: 'START_CAPTURE',
      payload: { tabId, mediaStreamId, encoderConfig, baseUrl },
    });
  }

  /**
   * Stops audio capture for a tab.
   * @param tabId - The tab ID to stop capturing
   */
  async stopCapture(tabId: number): Promise<void> {
    await sendToOffscreen({ type: 'STOP_CAPTURE', payload: { tabId } });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Playback Control
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Starts playback on Sonos speakers.
   * @param tabId - The tab ID being streamed
   * @param speakerIps - Target speaker IP addresses
   * @param metadata - Optional initial metadata to display
   * @returns The playback response with per-speaker results
   */
  async startPlayback(
    tabId: number,
    speakerIps: string[],
    metadata?: StreamMetadata,
  ): Promise<StartPlaybackResponse | undefined> {
    return sendToOffscreen<StartPlaybackResponse>({
      type: 'START_PLAYBACK',
      payload: { tabId, speakerIps, metadata },
    });
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
   * @returns Success response
   */
  async setVolume(speakerIp: string, volume: number): Promise<{ success: boolean } | undefined> {
    return sendToOffscreen<{ success: boolean }>({ type: 'SET_VOLUME', speakerIp, volume });
  }

  /**
   * Sets mute state for a speaker.
   * @param speakerIp - The speaker IP address
   * @param muted - The mute state
   * @returns Success response
   */
  async setMute(speakerIp: string, muted: boolean): Promise<{ success: boolean } | undefined> {
    return sendToOffscreen<{ success: boolean }>({ type: 'SET_MUTE', speakerIp, muted });
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
