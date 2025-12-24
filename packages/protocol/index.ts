import { z } from 'zod';

/**
 * Supported audio codecs for streaming.
 *
 * - `he-aac`: High-Efficiency AAC (mp4a.40.5) - best for low bitrates (64-96 kbps)
 * - `aac-lc`: AAC Low Complexity (mp4a.40.2) - balanced quality (128-192 kbps)
 * - `mp3`: MPEG Layer 3 - universal compatibility fallback
 * - `wav`: Raw PCM - zero latency, high bandwidth
 */
export const AudioCodecSchema = z.enum(['he-aac', 'aac-lc', 'mp3', 'wav']);
export type AudioCodec = z.infer<typeof AudioCodecSchema>;

/**
 * Supported bitrates in kbps.
 * Not all bitrates are valid for all codecs - use `getValidBitrates()` to filter.
 */
export const BitrateSchema = z.union([
  z.literal(64),
  z.literal(96),
  z.literal(128),
  z.literal(192),
  z.literal(320),
]);
export type Bitrate = z.infer<typeof BitrateSchema>;

/** All valid bitrate values as a readonly array. */
export const ALL_BITRATES = [64, 96, 128, 192, 320] as const;

/**
 * Complete encoder configuration passed from UI to offscreen.
 */
export const EncoderConfigSchema = z.object({
  codec: AudioCodecSchema,
  bitrate: BitrateSchema,
  sampleRate: z.union([z.literal(44100), z.literal(48000)]).default(48000),
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
});
export type EncoderConfig = z.infer<typeof EncoderConfigSchema>;

/**
 * Metadata about a codec for UI display and validation.
 */
export interface CodecMetadata {
  label: string;
  description: string;
  validBitrates: readonly Bitrate[];
  defaultBitrate: Bitrate;
  webCodecsId: string | null;
}

/**
 * Metadata about each codec for UI display and validation.
 */
export const CODEC_METADATA: Record<AudioCodec, CodecMetadata> = {
  'he-aac': {
    label: 'HE-AAC',
    description: 'High efficiency, best for low bandwidth',
    validBitrates: [64, 96] as const,
    defaultBitrate: 64,
    webCodecsId: 'mp4a.40.5',
  },
  'aac-lc': {
    label: 'AAC-LC',
    description: 'Balanced quality and efficiency',
    validBitrates: [128, 192] as const,
    defaultBitrate: 192,
    webCodecsId: 'mp4a.40.2',
  },
  mp3: {
    label: 'MP3',
    description: 'Universal compatibility',
    validBitrates: [128, 192, 320] as const,
    defaultBitrate: 192,
    webCodecsId: null,
  },
  wav: {
    label: 'WAV (Lossless)',
    description: 'Zero latency, highest bandwidth',
    validBitrates: [] as const,
    defaultBitrate: 192 as Bitrate,
    webCodecsId: null,
  },
} as const;

/**
 * Returns valid bitrates for a given codec.
 * @param codec - The audio codec to get bitrates for
 * @returns Array of valid bitrates for the codec
 */
export function getValidBitrates(codec: AudioCodec): readonly Bitrate[] {
  return CODEC_METADATA[codec].validBitrates;
}

/**
 * Returns the default bitrate for a codec.
 * @param codec - The audio codec
 * @returns The default bitrate for the codec
 */
export function getDefaultBitrate(codec: AudioCodec): Bitrate {
  return CODEC_METADATA[codec].defaultBitrate;
}

/**
 * Validates that a bitrate is valid for a codec.
 * @param codec - The audio codec
 * @param bitrate - The bitrate to validate
 * @returns True if the bitrate is valid for the codec
 */
export function isValidBitrateForCodec(codec: AudioCodec, bitrate: Bitrate): boolean {
  if (codec === 'wav') return true;
  return CODEC_METADATA[codec].validBitrates.includes(bitrate);
}

/**
 * Creates a validated encoder config, applying defaults and constraints.
 * @param codec - The audio codec to use
 * @param bitrate - Optional bitrate (uses default if invalid)
 * @returns A validated encoder configuration
 */
export function createEncoderConfig(codec: AudioCodec, bitrate?: Bitrate): EncoderConfig {
  const effectiveBitrate =
    bitrate && isValidBitrateForCodec(codec, bitrate) ? bitrate : getDefaultBitrate(codec);

  return {
    codec,
    bitrate: effectiveBitrate,
    sampleRate: 48000,
    channels: 2,
  };
}

/**
 * Legacy audio format schema for backward compatibility.
 * @deprecated Use AudioCodecSchema instead
 */
export const AudioFormatSchema = z.enum(['wav', 'aac', 'mp3', 'flac']);
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

/**
 * High-level quality presets for the user interface.
 */
export const QualityPresetSchema = z.enum(['instant', 'balanced', 'efficient']);
export type QualityPreset = z.infer<typeof QualityPresetSchema>;

/**
 * Track-level metadata for display on Sonos devices.
 */
export const StreamMetadataSchema = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  artwork: z.string().optional(),
});
export type StreamMetadata = z.infer<typeof StreamMetadataSchema>;

/**
 * Configuration parameters for initializing an audio stream session.
 */
export const StreamConfigSchema = z.object({
  streamId: z.string().uuid(),
  tabId: z.number().int().positive(),
  groupId: z.string(),
  encoderConfig: EncoderConfigSchema,
});
export type StreamConfig = z.infer<typeof StreamConfigSchema>;

/**
 * Current runtime status of an active cast session.
 */
export const CastStatusSchema = z.object({
  isActive: z.boolean(),
  streamId: z.string().uuid().optional(),
  tabId: z.number().int().positive().optional(),
  groupId: z.string().optional(),
  groupName: z.string().optional(),
  coordinatorIp: z.string().optional(),
  encoderConfig: EncoderConfigSchema.optional(),
  startedAt: z.number().int().positive().optional(),
});
export type CastStatus = z.infer<typeof CastStatusSchema>;

/**
 * WebSocket Message Payloads
 */
export const WsHandshakePayloadSchema = z.object({
  encoderConfig: EncoderConfigSchema,
});
export type WsHandshakePayload = z.infer<typeof WsHandshakePayloadSchema>;

export const WsHandshakeAckPayloadSchema = z.object({
  streamId: z.string(),
});
export type WsHandshakeAckPayload = z.infer<typeof WsHandshakeAckPayloadSchema>;

export const WsErrorPayloadSchema = z.object({
  message: z.string(),
});
export type WsErrorPayload = z.infer<typeof WsErrorPayloadSchema>;

/**
 * WebSocket Message Types
 */
export const WsMessageTypeSchema = z.enum([
  'HANDSHAKE',
  'HANDSHAKE_ACK',
  'HEARTBEAT',
  'HEARTBEAT_ACK',
  'STOP_STREAM',
  'METADATA_UPDATE',
  'ERROR',
]);
export type WsMessageType = z.infer<typeof WsMessageTypeSchema>;

/**
 * Individual WebSocket message schemas for discriminated union.
 */
export const WsHandshakeMessageSchema = z.object({
  type: z.literal('HANDSHAKE'),
  payload: WsHandshakePayloadSchema,
});
export type WsHandshakeMessage = z.infer<typeof WsHandshakeMessageSchema>;

export const WsHandshakeAckMessageSchema = z.object({
  type: z.literal('HANDSHAKE_ACK'),
  payload: WsHandshakeAckPayloadSchema,
});
export type WsHandshakeAckMessage = z.infer<typeof WsHandshakeAckMessageSchema>;

export const WsHeartbeatMessageSchema = z.object({
  type: z.literal('HEARTBEAT'),
});
export type WsHeartbeatMessage = z.infer<typeof WsHeartbeatMessageSchema>;

export const WsHeartbeatAckMessageSchema = z.object({
  type: z.literal('HEARTBEAT_ACK'),
});
export type WsHeartbeatAckMessage = z.infer<typeof WsHeartbeatAckMessageSchema>;

export const WsStopStreamMessageSchema = z.object({
  type: z.literal('STOP_STREAM'),
});
export type WsStopStreamMessage = z.infer<typeof WsStopStreamMessageSchema>;

export const WsMetadataUpdateMessageSchema = z.object({
  type: z.literal('METADATA_UPDATE'),
  payload: StreamMetadataSchema,
});
export type WsMetadataUpdateMessage = z.infer<typeof WsMetadataUpdateMessageSchema>;

export const WsErrorMessageSchema = z.object({
  type: z.literal('ERROR'),
  payload: WsErrorPayloadSchema,
});
export type WsErrorMessage = z.infer<typeof WsErrorMessageSchema>;

/**
 * Discriminated union for all WebSocket messages with typed payloads.
 */
export const WsMessageSchema = z.discriminatedUnion('type', [
  WsHandshakeMessageSchema,
  WsHandshakeAckMessageSchema,
  WsHeartbeatMessageSchema,
  WsHeartbeatAckMessageSchema,
  WsStopStreamMessageSchema,
  WsMetadataUpdateMessageSchema,
  WsErrorMessageSchema,
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;

/**
 * Sonos Transport States.
 * These match the UPnP AVTransport states from Sonos.
 */
export const TransportStateSchema = z.enum([
  'Playing',
  'PAUSED_PLAYBACK',
  'Stopped',
  'Transitioning',
]);
export type TransportState = z.infer<typeof TransportStateSchema>;

/**
 * User-friendly transport state labels for UI display.
 */
export const TRANSPORT_STATE_LABELS: Record<TransportState, string> = {
  Playing: 'Playing',
  PAUSED_PLAYBACK: 'Paused',
  Stopped: 'Stopped',
  Transitioning: 'Loading',
} as const;

/**
 * Lucide icon names for each transport state.
 */
export const TRANSPORT_STATE_ICONS: Record<TransportState, string> = {
  Playing: 'play',
  PAUSED_PLAYBACK: 'pause',
  Stopped: 'square',
  Transitioning: 'loader',
} as const;

/**
 * A member of a Sonos zone group.
 */
export const ZoneGroupMemberSchema = z.object({
  uuid: z.string(),
  ip: z.string(),
  zoneName: z.string(),
  model: z.string().optional(),
});
export type ZoneGroupMember = z.infer<typeof ZoneGroupMemberSchema>;

/**
 * A Sonos zone group (one or more speakers playing in sync).
 */
export const ZoneGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  coordinatorUuid: z.string(),
  coordinatorIp: z.string(),
  members: z.array(ZoneGroupMemberSchema),
});
export type ZoneGroup = z.infer<typeof ZoneGroupSchema>;

/**
 * Active playback session linking a stream to a speaker.
 */
export const PlaybackSessionSchema = z.object({
  streamId: z.string(),
  speakerIp: z.string(),
  streamUrl: z.string(),
});
export type PlaybackSession = z.infer<typeof PlaybackSessionSchema>;

/**
 * Complete Sonos state snapshot sent on WebSocket connect.
 */
export const SonosStateSnapshotSchema = z.object({
  groups: z.array(ZoneGroupSchema),
  transportStates: z.record(z.string(), TransportStateSchema),
  groupVolumes: z.record(z.string(), z.number()),
  groupMutes: z.record(z.string(), z.boolean()),
  sessions: z.array(PlaybackSessionSchema).optional(),
});
export type SonosStateSnapshot = z.infer<typeof SonosStateSnapshotSchema>;

/**
 * Creates an empty Sonos state snapshot.
 * Used for initialization before receiving state from desktop.
 * @returns An empty SonosStateSnapshot
 */
export function createEmptySonosState(): SonosStateSnapshot {
  return {
    groups: [],
    groupVolumes: {},
    groupMutes: {},
    transportStates: {},
  };
}

/**
 * Parses and validates a Sonos event from a raw payload.
 * @param data - The raw event data to parse
 * @returns A validated SonosEvent or null if invalid
 */
export function parseSonosEvent(data: unknown): SonosEvent | null {
  const result = SonosEventSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Gets a human-readable status string for a speaker.
 * Used in the speaker dropdown to show current state.
 * @param speakerIp - The speaker IP address
 * @param state - The current Sonos state snapshot
 * @returns The status label or undefined if no state available
 */
export function getSpeakerStatus(speakerIp: string, state: SonosStateSnapshot): string | undefined {
  const transport = state.transportStates[speakerIp];
  if (!transport) return undefined;
  return TRANSPORT_STATE_LABELS[transport];
}

/**
 * Checks if a speaker is currently playing.
 * @param speakerIp - The speaker IP address
 * @param state - The current Sonos state snapshot
 * @returns True if the speaker is in Playing state
 */
export function isSpeakerPlaying(speakerIp: string, state: SonosStateSnapshot): boolean {
  return state.transportStates[speakerIp] === 'Playing';
}

/**
 * Initial state message sent by desktop on WebSocket connect.
 */
export const WsInitialStateMessageSchema = z.object({
  type: z.literal('INITIAL_STATE'),
  payload: SonosStateSnapshotSchema,
});
export type WsInitialStateMessage = z.infer<typeof WsInitialStateMessageSchema>;

/**
 * Sonos event types broadcast by desktop app.
 */
export const SonosEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transportState'),
    speakerIp: z.string(),
    state: TransportStateSchema,
    currentUri: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('groupVolume'),
    speakerIp: z.string(),
    volume: z.number(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('groupMute'),
    speakerIp: z.string(),
    muted: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('sourceChanged'),
    speakerIp: z.string(),
    currentUri: z.string(),
    expectedUri: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('zoneGroupsUpdated'),
    groups: z.array(ZoneGroupSchema),
    timestamp: z.number(),
  }),
]);
export type SonosEvent = z.infer<typeof SonosEventSchema>;

/**
 * Stream event types broadcast by desktop app.
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('created'),
    streamId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('ended'),
    streamId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStarted'),
    streamId: z.string(),
    speakerIp: z.string(),
    streamUrl: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStopped'),
    speakerIp: z.string(),
    timestamp: z.number(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * Broadcast event wrapper from desktop app.
 * Uses passthrough to allow the nested event fields.
 */
export const BroadcastEventSchema = z.union([
  z.object({ category: z.literal('sonos') }).passthrough(),
  z.object({ category: z.literal('stream') }).passthrough(),
]);

/**
 * Typed broadcast event (use type guards to narrow).
 */
export interface SonosBroadcastEvent {
  category: 'sonos';
  type: SonosEvent['type'];
  [key: string]: unknown;
}

export interface StreamBroadcastEvent {
  category: 'stream';
  type: StreamEvent['type'];
  [key: string]: unknown;
}

export type BroadcastEvent = SonosBroadcastEvent | StreamBroadcastEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Media Metadata Types (for tab-level metadata display)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Media metadata captured from the Web MediaSession API.
 * This is the canonical shape used for displaying track info.
 * Title is required; other fields are optional.
 */
export const MediaMetadataSchema = z.object({
  /** Track title (required) */
  title: z.string().min(1),
  /** Artist name */
  artist: z.string().optional(),
  /** Album name */
  album: z.string().optional(),
  /** Artwork URL (largest available) */
  artwork: z.string().url().optional(),
});
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

/**
 * Validates and parses raw metadata into MediaMetadata.
 * Returns null if title is missing or invalid.
 * @param data - Raw metadata object to parse
 * @returns Validated MediaMetadata or null if invalid
 */
export function parseMediaMetadata(data: unknown): MediaMetadata | null {
  const result = MediaMetadataSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Complete media state for a browser tab.
 * Combines metadata with tab identification for display.
 */
export const TabMediaStateSchema = z.object({
  /** Chrome tab ID */
  tabId: z.number().int().positive(),
  /** Tab title (fallback when no metadata) */
  tabTitle: z.string(),
  /** Tab favicon URL */
  tabFavicon: z.string().optional(),
  /** Media metadata if available */
  metadata: MediaMetadataSchema.nullable(),
  /** Timestamp when this state was last updated */
  updatedAt: z.number(),
});
export type TabMediaState = z.infer<typeof TabMediaStateSchema>;

/**
 * Creates a TabMediaState with defaults.
 * @param tab - Tab information from Chrome API
 * @param tab.id
 * @param tab.title
 * @param tab.favIconUrl
 * @param metadata - Optional media metadata
 * @returns A new TabMediaState object
 */
export function createTabMediaState(
  tab: { id: number; title?: string; favIconUrl?: string },
  metadata: MediaMetadata | null = null,
): TabMediaState {
  return {
    tabId: tab.id,
    tabTitle: tab.title || 'Unknown Tab',
    tabFavicon: tab.favIconUrl,
    metadata,
    updatedAt: Date.now(),
  };
}

/**
 * An active cast session with its current state.
 * Used for displaying in the popup's active casts list.
 */
export const ActiveCastSchema = z.object({
  /** Unique stream ID from server */
  streamId: z.string(),
  /** Tab ID being captured */
  tabId: z.number().int().positive(),
  /** Current media state (includes metadata) */
  mediaState: TabMediaStateSchema,
  /** Target speaker IP address */
  speakerIp: z.string(),
  /** Speaker/group display name */
  speakerName: z.string().optional(),
  /** Encoder configuration used for this cast */
  encoderConfig: EncoderConfigSchema,
  /** Timestamp when cast started */
  startedAt: z.number(),
});
export type ActiveCast = z.infer<typeof ActiveCastSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Display Helpers (DRY - single source of truth for display logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the display title from media state.
 * Prefers metadata title, falls back to tab title.
 * @param state - The tab media state
 * @returns The title to display
 */
export function getDisplayTitle(state: TabMediaState): string {
  return state.metadata?.title || state.tabTitle;
}

/**
 * Gets the display image from media state.
 * Prefers artwork, falls back to favicon.
 * @param state - The tab media state
 * @returns The image URL to display, or undefined if none available
 */
export function getDisplayImage(state: TabMediaState): string | undefined {
  return state.metadata?.artwork || state.tabFavicon;
}

/**
 * Gets the display subtitle from media state.
 * Returns artist/album string or undefined if no artist.
 * @param state - The tab media state
 * @returns The subtitle to display, or undefined if no artist
 */
export function getDisplaySubtitle(state: TabMediaState): string | undefined {
  const { metadata } = state;
  if (!metadata?.artist) return undefined;
  return metadata.album ? `${metadata.artist} • ${metadata.album}` : metadata.artist;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Control Commands (extension → desktop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Control commands sent from extension to desktop app via WebSocket.
 * Must match the Rust `WsIncoming` enum format (SCREAMING_SNAKE_CASE type tag).
 */
export type WsControlCommand =
  | { type: 'SET_VOLUME'; payload: { ip: string; volume: number } }
  | { type: 'SET_MUTE'; payload: { ip: string; mute: boolean } }
  | { type: 'GET_VOLUME'; payload: { ip: string } }
  | { type: 'GET_MUTE'; payload: { ip: string } };
