// Sonos event types for bidirectional state sync (GENA/webhooks → extension)
// Re-exported from @thaumic-cast/protocol (OpenAPI-generated types)

// Re-export all generated event types from protocol
export type {
  TransportState,
  TransportStateEvent,
  ZoneChangeEvent,
  SourceChangedEvent,
  GroupVolumeChangeEvent,
  GroupMuteChangeEvent,
  SonosEvent,
  GenaService,
  GenaSubscription,
} from '@thaumic-cast/protocol';

// Import types used in this file (re-exports don't make them available locally)
import type { SonosEvent, GenaService } from '@thaumic-cast/protocol';

// Type guards and utilities (not generated - hand-written)

/**
 * Type guard to check if data is a SonosEvent
 * Validates both the discriminator and required fields for each event type
 */
export function isSonosEvent(data: unknown): data is SonosEvent {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  if (typeof obj.type !== 'string') return false;

  // Validate required fields based on event type
  switch (obj.type) {
    case 'transportState':
      return (
        typeof obj.state === 'string' &&
        typeof obj.speakerIp === 'string' &&
        typeof obj.timestamp === 'number'
      );
    case 'groupVolume':
      return (
        typeof obj.volume === 'number' &&
        typeof obj.speakerIp === 'string' &&
        typeof obj.timestamp === 'number'
      );
    case 'groupMute':
      return (
        typeof obj.mute === 'boolean' &&
        typeof obj.speakerIp === 'string' &&
        typeof obj.timestamp === 'number'
      );
    case 'zoneChange':
      return typeof obj.timestamp === 'number';
    case 'sourceChanged':
      return (
        typeof obj.currentUri === 'string' &&
        typeof obj.speakerIp === 'string' &&
        typeof obj.timestamp === 'number'
      );
    default:
      return false;
  }
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
 * Service endpoints for GENA subscriptions
 */
export const GENA_SERVICE_ENDPOINTS: Record<GenaService, string> = {
  AVTransport: '/MediaRenderer/AVTransport/Event',
  ZoneGroupTopology: '/ZoneGroupTopology/Event',
  GroupRenderingControl: '/MediaRenderer/GroupRenderingControl/Event',
};
