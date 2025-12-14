// Sonos event types for bidirectional state sync (GENA/webhooks → extension)

/**
 * UPnP AVTransport transport states
 * @see https://sonos.svrooij.io/services/av-transport
 */
export type TransportState = 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING';

/**
 * Transport state change event from Sonos speaker
 */
export interface TransportStateEvent {
  type: 'transportState';
  state: TransportState;
  speakerIp: string;
  timestamp: number;
}

/**
 * Volume change event from Sonos speaker
 * Note: Mute state is sent as a separate MuteChangeEvent
 */
export interface VolumeChangeEvent {
  type: 'volume';
  volume: number;
  speakerIp: string;
  timestamp: number;
}

/**
 * Mute state change event from Sonos speaker
 */
export interface MuteChangeEvent {
  type: 'mute';
  mute: boolean;
  speakerIp: string;
  timestamp: number;
}

/**
 * Zone group topology change event
 * Fired when speakers are grouped/ungrouped
 */
export interface ZoneChangeEvent {
  type: 'zoneChange';
  timestamp: number;
}

/**
 * Source changed event - fired when Sonos switches to a different audio source
 * Used to detect when user switches away from our stream (e.g., opens Spotify)
 */
export interface SourceChangedEvent {
  type: 'sourceChanged';
  currentUri: string;
  expectedUri: string | null;
  speakerIp: string;
  timestamp: number;
}

/**
 * Group volume change event from GroupRenderingControl
 * This is the combined volume for all speakers in a group
 */
export interface GroupVolumeChangeEvent {
  type: 'groupVolume';
  volume: number;
  speakerIp: string;
  timestamp: number;
}

/**
 * Group mute state change event from GroupRenderingControl
 */
export interface GroupMuteChangeEvent {
  type: 'groupMute';
  mute: boolean;
  speakerIp: string;
  timestamp: number;
}

/**
 * Union type for all Sonos events sent via WebSocket
 */
export type SonosEvent =
  | TransportStateEvent
  | VolumeChangeEvent
  | MuteChangeEvent
  | ZoneChangeEvent
  | SourceChangedEvent
  | GroupVolumeChangeEvent
  | GroupMuteChangeEvent;

/**
 * Type guard to check if data is a SonosEvent
 */
export function isSonosEvent(data: unknown): data is SonosEvent {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.type === 'string' &&
    [
      'transportState',
      'volume',
      'mute',
      'zoneChange',
      'sourceChanged',
      'groupVolume',
      'groupMute',
    ].includes(obj.type)
  );
}

/**
 * Parse a JSON string into a SonosEvent if valid
 */
export function parseSonosEvent(json: string): SonosEvent | null {
  try {
    const parsed = JSON.parse(json);
    if (isSonosEvent(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GENA subscription info stored per speaker/service
 */
export interface GenaSubscription {
  sid: string; // Subscription ID from SUBSCRIBE response
  speakerIp: string;
  service: GenaService;
  expiresAt: number; // Unix timestamp
  callbackPath: string;
}

/**
 * Sonos UPnP services we subscribe to
 */
export type GenaService =
  | 'AVTransport'
  | 'RenderingControl'
  | 'ZoneGroupTopology'
  | 'GroupRenderingControl';

/**
 * Service endpoints for GENA subscriptions
 */
export const GENA_SERVICE_ENDPOINTS: Record<GenaService, string> = {
  AVTransport: '/MediaRenderer/AVTransport/Event',
  RenderingControl: '/MediaRenderer/RenderingControl/Event',
  ZoneGroupTopology: '/ZoneGroupTopology/Event',
  GroupRenderingControl: '/MediaRenderer/GroupRenderingControl/Event',
};
