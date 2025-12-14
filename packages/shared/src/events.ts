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
 * Union type for all Sonos events sent via WebSocket
 */
export type SonosEvent =
  | TransportStateEvent
  | VolumeChangeEvent
  | MuteChangeEvent
  | ZoneChangeEvent;

/**
 * Type guard to check if data is a SonosEvent
 */
export function isSonosEvent(data: unknown): data is SonosEvent {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.type === 'string' &&
    ['transportState', 'volume', 'mute', 'zoneChange'].includes(obj.type)
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
export type GenaService = 'AVTransport' | 'RenderingControl' | 'ZoneGroupTopology';

/**
 * Service endpoints for GENA subscriptions
 */
export const GENA_SERVICE_ENDPOINTS: Record<GenaService, string> = {
  AVTransport: '/MediaRenderer/AVTransport/Event',
  RenderingControl: '/MediaRenderer/RenderingControl/Event',
  ZoneGroupTopology: '/ZoneGroupTopology/Event',
};
