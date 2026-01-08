/**
 * Message Validation Schemas
 *
 * Zod schemas for runtime validation of extension messages.
 * Provides type safety at runtime boundaries, better error messages,
 * and self-documenting contracts.
 */

import { z } from 'zod';
import {
  MediaActionSchema,
  EncoderConfigSchema,
  PlaybackStateSchema,
  SonosStateSnapshotSchema,
  BroadcastEventSchema,
} from '@thaumic-cast/protocol';
import type {
  StartCastMessage,
  StopCastMessage,
  SetVolumeMessage,
  SetMuteMessage,
  ControlMediaMessage,
  SetVideoSyncEnabledMessage,
  SetVideoSyncTrimMessage,
  TriggerResyncMessage,
  GetVideoSyncStateMessage,
  VideoSyncStateChangedMessage,
  TabMetadataUpdateMessage,
  TabOgImageMessage,
  WsConnectedMessage,
  NetworkEventMessage,
  TopologyEventMessage,
  SessionDisconnectedMessage,
} from './messages';

// ─────────────────────────────────────────────────────────────────────────────
// Primitive Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** IPv4 address pattern */
const IPv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Valid speaker IP address (IPv4 format) */
const SpeakerIpSchema = z.string().regex(IPv4Pattern, 'Invalid IPv4 address');

/** Valid tab ID (positive integer) */
const TabIdSchema = z.number().int().positive();

/** Volume level (0-100) */
const VolumeSchema = z.number().int().min(0).max(100);

// ─────────────────────────────────────────────────────────────────────────────
// Cast Message Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const StartCastMessageSchema = z.object({
  type: z.literal('START_CAST'),
  payload: z.object({
    speakerIps: z.array(SpeakerIpSchema).min(1, 'At least one speaker required'),
    encoderConfig: EncoderConfigSchema.optional(),
  }),
}) satisfies z.ZodType<StartCastMessage>;

export const StopCastMessageSchema = z.object({
  type: z.literal('STOP_CAST'),
  payload: z
    .object({
      tabId: TabIdSchema.optional(),
    })
    .optional(),
}) satisfies z.ZodType<StopCastMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Sonos Control Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const SetVolumeMessageSchema = z.object({
  type: z.literal('SET_VOLUME'),
  speakerIp: SpeakerIpSchema,
  volume: VolumeSchema,
}) satisfies z.ZodType<SetVolumeMessage>;

export const SetMuteMessageSchema = z.object({
  type: z.literal('SET_MUTE'),
  speakerIp: SpeakerIpSchema,
  muted: z.boolean(),
}) satisfies z.ZodType<SetMuteMessage>;

export const ControlMediaMessageSchema = z.object({
  type: z.literal('CONTROL_MEDIA'),
  payload: z.object({
    tabId: TabIdSchema,
    action: MediaActionSchema,
  }),
}) satisfies z.ZodType<ControlMediaMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const SetVideoSyncEnabledMessageSchema = z.object({
  type: z.literal('SET_VIDEO_SYNC_ENABLED'),
  payload: z.object({
    tabId: TabIdSchema,
    enabled: z.boolean(),
  }),
}) satisfies z.ZodType<SetVideoSyncEnabledMessage>;

export const SetVideoSyncTrimMessageSchema = z.object({
  type: z.literal('SET_VIDEO_SYNC_TRIM'),
  payload: z.object({
    tabId: TabIdSchema,
    trimMs: z.number().int(),
  }),
}) satisfies z.ZodType<SetVideoSyncTrimMessage>;

export const TriggerResyncMessageSchema = z.object({
  type: z.literal('TRIGGER_RESYNC'),
  payload: z.object({
    tabId: TabIdSchema,
  }),
}) satisfies z.ZodType<TriggerResyncMessage>;

export const GetVideoSyncStateMessageSchema = z.object({
  type: z.literal('GET_VIDEO_SYNC_STATE'),
  payload: z.object({
    tabId: TabIdSchema,
  }),
}) satisfies z.ZodType<GetVideoSyncStateMessage>;

export const VideoSyncStateChangedMessageSchema = z.object({
  type: z.literal('VIDEO_SYNC_STATE_CHANGED'),
  enabled: z.boolean(),
  trimMs: z.number().int(),
  state: z.enum(['off', 'acquiring', 'locked', 'stale']),
  lockedLatencyMs: z.number().optional(),
}) satisfies z.ZodType<VideoSyncStateChangedMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw media state from content script.
 * Includes supportedActions and playbackState that StreamMetadata doesn't have.
 */
export const RawMediaStateSchema = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  artwork: z.string().optional(),
  supportedActions: z.array(MediaActionSchema).default([]),
  playbackState: PlaybackStateSchema.default('none'),
});
export type RawMediaState = z.infer<typeof RawMediaStateSchema>;

export const TabMetadataUpdateMessageSchema = z.object({
  type: z.literal('TAB_METADATA_UPDATE'),
  payload: RawMediaStateSchema.nullable(),
}) satisfies z.ZodType<TabMetadataUpdateMessage>;

export const TabOgImageMessageSchema = z.object({
  type: z.literal('TAB_OG_IMAGE'),
  payload: z.object({
    ogImage: z.string().url(),
  }),
}) satisfies z.ZodType<TabOgImageMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Connection Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const WsConnectMessageSchema = z.object({
  type: z.literal('WS_CONNECT'),
  url: z.string().url(),
  maxStreams: z.number().int().positive().optional(),
});

export const WsReconnectMessageSchema = z.object({
  type: z.literal('WS_RECONNECT'),
  url: z.string().url().optional(),
});

export const SyncSonosStateMessageSchema = z.object({
  type: z.literal('SYNC_SONOS_STATE'),
  state: SonosStateSnapshotSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Offscreen Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const WsConnectedMessageSchema = z.object({
  type: z.literal('WS_CONNECTED'),
  state: SonosStateSnapshotSchema,
}) satisfies z.ZodType<WsConnectedMessage>;

// Note: BroadcastEventSchema uses passthrough(), so we validate structure only
// The handler casts to BroadcastEvent for full type safety
export const SonosEventMessageSchema = z.object({
  type: z.literal('SONOS_EVENT'),
  payload: BroadcastEventSchema,
});

export const NetworkEventMessageSchema = z.object({
  type: z.literal('NETWORK_EVENT'),
  payload: z.object({
    type: z.literal('healthChanged'),
    health: z.enum(['ok', 'degraded']),
    reason: z.string().optional(),
    timestamp: z.number(),
  }),
}) satisfies z.ZodType<NetworkEventMessage>;

export const TopologyEventMessageSchema = z.object({
  type: z.literal('TOPOLOGY_EVENT'),
  payload: z.object({
    type: z.literal('groupsDiscovered'),
    groups: SonosStateSnapshotSchema.shape.groups,
    timestamp: z.number(),
  }),
}) satisfies z.ZodType<TopologyEventMessage>;

export const SessionDisconnectedMessageSchema = z.object({
  type: z.literal('SESSION_DISCONNECTED'),
  tabId: TabIdSchema,
}) satisfies z.ZodType<SessionDisconnectedMessage>;
