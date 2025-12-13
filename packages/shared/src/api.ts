// API request/response types shared between server and extension

export type QualityPreset = 'ultra-low' | 'low' | 'medium' | 'high';

export type AudioCodec = 'he-aac' | 'aac-lc' | 'mp3';

export type StreamStatus = 'starting' | 'active' | 'stopped' | 'error';

export type SonosMode = 'cloud' | 'local';

// GET /api/me
export interface MeResponse {
  user: {
    id: string;
    email: string;
    name?: string;
  } | null;
  sonosLinked: boolean;
}

// GET /api/sonos/groups
export interface SonosGroup {
  id: string;
  name: string;
}

export interface SonosGroupsResponse {
  householdId: string;
  groups: SonosGroup[];
}

// Stream metadata for Sonos display
export interface StreamMetadata {
  title?: string; // Song title or tab title
  artist?: string; // Artist name
  album?: string; // Album name
  artwork?: string; // Album art URL
}

// POST /api/streams
export interface CreateStreamRequest {
  groupId: string;
  quality: QualityPreset;
  metadata?: StreamMetadata;
  codec?: AudioCodec;
}

export interface CreateStreamResponse {
  streamId: string;
  ingestUrl: string;
  playbackUrl: string;
}

// GET /api/sonos/status
export interface SonosStatusResponse {
  linked: boolean;
  householdId?: string;
}

// Error response
export interface ApiError {
  error: string;
  message: string;
}

// Local mode types
export interface LocalSpeaker {
  uuid: string;
  ip: string;
  zoneName: string;
  model: string;
}

export interface LocalGroup {
  id: string;
  name: string;
  coordinatorUuid: string;
  coordinatorIp: string;
  members: LocalSpeaker[];
}

export interface LocalDiscoveryResponse {
  speakers: Array<{ uuid: string; ip: string }>;
}

export interface LocalGroupsResponse {
  groups: LocalGroup[];
}

// Error codes for structured error handling
export enum ErrorCode {
  // Network errors
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  NETWORK_UNREACHABLE = 'NETWORK_UNREACHABLE',
  CONNECTION_REFUSED = 'CONNECTION_REFUSED',

  // Sonos errors
  SPEAKER_NOT_FOUND = 'SPEAKER_NOT_FOUND',
  SPEAKER_UNREACHABLE = 'SPEAKER_UNREACHABLE',
  DISCOVERY_FAILED = 'DISCOVERY_FAILED',
  PLAYBACK_FAILED = 'PLAYBACK_FAILED',
  INVALID_STREAM_URL = 'INVALID_STREAM_URL',

  // Validation errors
  INVALID_IP_ADDRESS = 'INVALID_IP_ADDRESS',
  INVALID_URL = 'INVALID_URL',

  // Auth errors
  UNAUTHORIZED = 'UNAUTHORIZED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',

  // Generic
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

// Enhanced error response with code
export interface ApiErrorResponse {
  error: string;
  message: string;
  code?: ErrorCode;
  details?: Record<string, unknown>;
}

// Validation utilities

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
