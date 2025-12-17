// Re-exported from @thaumic-cast/protocol (OpenAPI-generated types)

// Re-export all generated types from protocol
export type {
  QualityPreset,
  AudioCodec,
  StreamStatus,
  SonosMode,
  StreamMetadata,
  Speaker,
  LocalSpeaker,
  LocalGroup,
  SonosGroup,
  GroupStatus,
  SonosStateSnapshot,
  CreateStreamRequest,
  CreateStreamResponse,
  MeResponse,
  SonosStatusResponse,
  SonosGroupsResponse,
  LocalDiscoveryResponse,
  LocalGroupsResponse,
  ApiError,
  ApiErrorResponse,
  ErrorCode,
  // WebSocket protocol types
  WsAction,
  WsCommand,
  WsResponse,
  WsConnectedEvent,
} from '@thaumic-cast/protocol';

// Validation utilities (not generated - hand-written)

/**
 * Validates an IPv4 address format
 */
export function isValidIPv4(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;

  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && part === num.toString();
  });
}

/**
 * Validates a URL format (must include protocol)
 */
export function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;

  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Default API timeout in milliseconds
 */
export const API_TIMEOUT_MS = 10000;

/**
 * Port range the desktop app binds to for HTTP server
 * Keep in sync with desktop/src-tauri/src/network.rs HTTP_PORT_RANGE
 */
export const DESKTOP_PORT_RANGE = { start: 49400, end: 49410 } as const;
