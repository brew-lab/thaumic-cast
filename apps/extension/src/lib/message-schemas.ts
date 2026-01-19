/**
 * Message Validation Schemas
 *
 * Zod schemas for all extension messages. This is the SINGLE SOURCE OF TRUTH.
 * All message types are derived from these schemas using z.infer<>.
 */

import { z } from 'zod';
import {
  MediaActionSchema,
  EncoderConfigSchema,
  PlaybackStateSchema,
  SonosStateSnapshotSchema,
  BroadcastEventSchema,
  StreamMetadataSchema,
  TabMediaStateSchema,
  ActiveCastSchema,
  TransportStateSchema,
  PlaybackResultSchema,
  LatencyBroadcastEvent,
} from '@thaumic-cast/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Primitive Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** IPv4 address pattern */
const IPv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Valid speaker IP address (IPv4 format) */
export const SpeakerIpSchema = z.string().regex(IPv4Pattern, 'Invalid IPv4 address');

/** Valid tab ID (positive integer) */
export const TabIdSchema = z.number().int().positive();

/** Volume level (0-100) */
export const VolumeSchema = z.number().int().min(0).max(100);

// ─────────────────────────────────────────────────────────────────────────────
// Raw Media State (content script → background)
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

// ─────────────────────────────────────────────────────────────────────────────
// Cast Message Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const StartCastMessageSchema = z.object({
  type: z.literal('START_CAST'),
  payload: z.object({
    /** Target speaker IP addresses (multi-group support). */
    speakerIps: z.array(SpeakerIpSchema).min(1, 'At least one speaker required'),
    /**
     * Encoder configuration. If omitted, background will auto-select
     * based on device capabilities and past session history.
     */
    encoderConfig: EncoderConfigSchema.optional(),
  }),
});
export type StartCastMessage = z.infer<typeof StartCastMessageSchema>;

export const StopCastMessageSchema = z.object({
  type: z.literal('STOP_CAST'),
  payload: z
    .object({
      tabId: TabIdSchema.optional(),
    })
    .optional(),
});
export type StopCastMessage = z.infer<typeof StopCastMessageSchema>;

export const RemoveSpeakerMessageSchema = z.object({
  type: z.literal('REMOVE_SPEAKER'),
  payload: z.object({
    tabId: TabIdSchema,
    speakerIp: SpeakerIpSchema,
  }),
});
export type RemoveSpeakerMessage = z.infer<typeof RemoveSpeakerMessageSchema>;

export const StartCaptureMessageSchema = z.object({
  type: z.literal('START_CAPTURE'),
  payload: z.object({
    tabId: TabIdSchema,
    mediaStreamId: z.string(),
    encoderConfig: EncoderConfigSchema,
    baseUrl: z.string().url(),
    /** Play audio at very low volume to prevent Chrome throttling */
    keepTabAudible: z.boolean().optional(),
  }),
});
export type StartCaptureMessage = z.infer<typeof StartCaptureMessageSchema>;

export const StopCaptureMessageSchema = z.object({
  type: z.literal('STOP_CAPTURE'),
  payload: z.object({
    tabId: TabIdSchema,
  }),
});
export type StopCaptureMessage = z.infer<typeof StopCaptureMessageSchema>;

export const StartPlaybackMessageSchema = z.object({
  type: z.literal('START_PLAYBACK'),
  payload: z.object({
    tabId: TabIdSchema,
    /** Target speaker IP addresses (multi-group support). */
    speakerIps: z.array(SpeakerIpSchema),
    /** Optional initial metadata to display on Sonos. */
    metadata: StreamMetadataSchema.optional(),
  }),
});
export type StartPlaybackMessage = z.infer<typeof StartPlaybackMessageSchema>;

export const StartPlaybackResponseSchema = z.object({
  /** Overall success (at least one speaker started). */
  success: z.boolean(),
  /** Per-speaker playback results. */
  results: z.array(PlaybackResultSchema),
  /** Overall error (if all speakers failed). */
  error: z.string().optional(),
});
export type StartPlaybackResponse = z.infer<typeof StartPlaybackResponseSchema>;

export const OffscreenMetadataMessageSchema = z.object({
  type: z.literal('OFFSCREEN_METADATA_UPDATE'),
  payload: z.object({
    tabId: TabIdSchema,
    metadata: StreamMetadataSchema,
  }),
});
export type OffscreenMetadataMessage = z.infer<typeof OffscreenMetadataMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Tab Metadata Messages (content → background)
// ─────────────────────────────────────────────────────────────────────────────

export const TabMetadataUpdateMessageSchema = z.object({
  type: z.literal('TAB_METADATA_UPDATE'),
  payload: RawMediaStateSchema.nullable(),
});
export type TabMetadataUpdateMessage = z.infer<typeof TabMetadataUpdateMessageSchema>;

export const RequestMetadataMessageSchema = z.object({
  type: z.literal('REQUEST_METADATA'),
});
export type RequestMetadataMessage = z.infer<typeof RequestMetadataMessageSchema>;

export const TabOgImageMessageSchema = z.object({
  type: z.literal('TAB_OG_IMAGE'),
  payload: z.object({
    ogImage: z.string(),
  }),
});
export type TabOgImageMessage = z.infer<typeof TabOgImageMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Connection Status Messages (popup → background)
// ─────────────────────────────────────────────────────────────────────────────

export const GetCurrentTabStateMessageSchema = z.object({
  type: z.literal('GET_CURRENT_TAB_STATE'),
});
export type GetCurrentTabStateMessage = z.infer<typeof GetCurrentTabStateMessageSchema>;

export const CurrentTabStateResponseSchema = z.object({
  state: TabMediaStateSchema.nullable(),
  isCasting: z.boolean(),
});
export type CurrentTabStateResponse = z.infer<typeof CurrentTabStateResponseSchema>;

export const GetActiveCastsMessageSchema = z.object({
  type: z.literal('GET_ACTIVE_CASTS'),
});
export type GetActiveCastsMessage = z.infer<typeof GetActiveCastsMessageSchema>;

export const ActiveCastsResponseSchema = z.object({
  casts: z.array(ActiveCastSchema),
});
export type ActiveCastsResponse = z.infer<typeof ActiveCastsResponseSchema>;

export const EnsureConnectionMessageSchema = z.object({
  type: z.literal('ENSURE_CONNECTION'),
});
export type EnsureConnectionMessage = z.infer<typeof EnsureConnectionMessageSchema>;

export const EnsureConnectionResponseSchema = z.object({
  /** Whether connection is now established */
  connected: z.boolean(),
  /** Desktop app URL if discovered */
  desktopAppUrl: z.string().nullable(),
  /** Maximum concurrent streams allowed */
  maxStreams: z.number().nullable(),
  /** Error message if connection failed */
  error: z.string().nullable(),
});
export type EnsureConnectionResponse = z.infer<typeof EnsureConnectionResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Popup Notification Messages (background → popup)
// ─────────────────────────────────────────────────────────────────────────────

export const TabStateChangedMessageSchema = z.object({
  type: z.literal('TAB_STATE_CHANGED'),
  tabId: TabIdSchema,
  state: TabMediaStateSchema,
});
export type TabStateChangedMessage = z.infer<typeof TabStateChangedMessageSchema>;

export const ActiveCastsChangedMessageSchema = z.object({
  type: z.literal('ACTIVE_CASTS_CHANGED'),
  casts: z.array(ActiveCastSchema),
});
export type ActiveCastsChangedMessage = z.infer<typeof ActiveCastsChangedMessageSchema>;

export const ExtensionResponseSchema = z.object({
  success: z.boolean(),
  streamId: z.string().optional(),
  error: z.string().optional(),
  isActive: z.boolean().optional(),
});
export type ExtensionResponse = z.infer<typeof ExtensionResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Control Messages (background ↔ offscreen)
// ─────────────────────────────────────────────────────────────────────────────

export const WsConnectMessageSchema = z.object({
  type: z.literal('WS_CONNECT'),
  url: z.string().url(),
  maxStreams: z.number().int().positive().optional(),
});
export type WsConnectMessage = z.infer<typeof WsConnectMessageSchema>;

export const WsDisconnectMessageSchema = z.object({
  type: z.literal('WS_DISCONNECT'),
});
export type WsDisconnectMessage = z.infer<typeof WsDisconnectMessageSchema>;

export const WsReconnectMessageSchema = z.object({
  type: z.literal('WS_RECONNECT'),
  url: z.string().url().optional(),
});
export type WsReconnectMessage = z.infer<typeof WsReconnectMessageSchema>;

export const GetWsStatusMessageSchema = z.object({
  type: z.literal('GET_WS_STATUS'),
});
export type GetWsStatusMessage = z.infer<typeof GetWsStatusMessageSchema>;

export const WsStatusResponseSchema = z.object({
  connected: z.boolean(),
  url: z.string().optional(),
  reconnectAttempts: z.number().optional(),
  state: SonosStateSnapshotSchema.optional(),
});
export type WsStatusResponse = z.infer<typeof WsStatusResponseSchema>;

export const SyncSonosStateMessageSchema = z.object({
  type: z.literal('SYNC_SONOS_STATE'),
  state: SonosStateSnapshotSchema,
});
export type SyncSonosStateMessage = z.infer<typeof SyncSonosStateMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Status Messages (offscreen → background)
// ─────────────────────────────────────────────────────────────────────────────

export const WsConnectedMessageSchema = z.object({
  type: z.literal('WS_CONNECTED'),
  state: SonosStateSnapshotSchema,
});
export type WsConnectedMessage = z.infer<typeof WsConnectedMessageSchema>;

export const WsDisconnectedMessageSchema = z.object({
  type: z.literal('WS_DISCONNECTED'),
});
export type WsDisconnectedMessage = z.infer<typeof WsDisconnectedMessageSchema>;

export const WsPermanentlyDisconnectedMessageSchema = z.object({
  type: z.literal('WS_PERMANENTLY_DISCONNECTED'),
});
export type WsPermanentlyDisconnectedMessage = z.infer<
  typeof WsPermanentlyDisconnectedMessageSchema
>;

export const SonosEventMessageSchema = z.object({
  type: z.literal('SONOS_EVENT'),
  payload: BroadcastEventSchema,
});
export type SonosEventMessage = z.infer<typeof SonosEventMessageSchema>;

export const OffscreenReadyMessageSchema = z.object({
  type: z.literal('OFFSCREEN_READY'),
});
export type OffscreenReadyMessage = z.infer<typeof OffscreenReadyMessageSchema>;

export const SessionDisconnectedMessageSchema = z.object({
  type: z.literal('SESSION_DISCONNECTED'),
  tabId: TabIdSchema,
});
export type SessionDisconnectedMessage = z.infer<typeof SessionDisconnectedMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// State Update Messages (background → popup)
// ─────────────────────────────────────────────────────────────────────────────

export const GetSonosStateMessageSchema = z.object({
  type: z.literal('GET_SONOS_STATE'),
});
export type GetSonosStateMessage = z.infer<typeof GetSonosStateMessageSchema>;

export const SonosStateResponseSchema = z.object({
  state: SonosStateSnapshotSchema.nullable(),
});
export type SonosStateResponse = z.infer<typeof SonosStateResponseSchema>;

export const WsStateChangedMessageSchema = z.object({
  type: z.literal('WS_STATE_CHANGED'),
  state: SonosStateSnapshotSchema,
});
export type WsStateChangedMessage = z.infer<typeof WsStateChangedMessageSchema>;

export const VolumeUpdateMessageSchema = z.object({
  type: z.literal('VOLUME_UPDATE'),
  speakerIp: SpeakerIpSchema,
  volume: VolumeSchema,
});
export type VolumeUpdateMessage = z.infer<typeof VolumeUpdateMessageSchema>;

export const MuteUpdateMessageSchema = z.object({
  type: z.literal('MUTE_UPDATE'),
  speakerIp: SpeakerIpSchema,
  muted: z.boolean(),
});
export type MuteUpdateMessage = z.infer<typeof MuteUpdateMessageSchema>;

export const TransportStateUpdateMessageSchema = z.object({
  type: z.literal('TRANSPORT_STATE_UPDATE'),
  speakerIp: SpeakerIpSchema,
  state: TransportStateSchema,
});
export type TransportStateUpdateMessage = z.infer<typeof TransportStateUpdateMessageSchema>;

/**
 * Reasons for removing a speaker from an active cast session.
 * - `source_changed`: User switched Sonos to another source (Spotify, AirPlay, etc.)
 * - `playback_stopped`: Playback stopped on the speaker (system/network issue)
 * - `speaker_stopped`: Speaker stopped unexpectedly (e.g., stream killed due to underflow)
 * - `user_removed`: User explicitly removed the speaker via UI
 */
export const SpeakerRemovalReasonSchema = z.enum([
  'source_changed',
  'playback_stopped',
  'speaker_stopped',
  'user_removed',
]);
export type SpeakerRemovalReason = z.infer<typeof SpeakerRemovalReasonSchema>;

/**
 * Reasons for auto-stopping an entire cast session.
 * Includes all speaker removal reasons plus stream-level events.
 * - `stream_ended`: The stream ended on the server side
 * - `user_removed`: User removed the last speaker via UI
 */
export const CastAutoStopReasonSchema = z.enum([
  'source_changed',
  'playback_stopped',
  'speaker_stopped',
  'stream_ended',
  'user_removed',
]);
export type CastAutoStopReason = z.infer<typeof CastAutoStopReasonSchema>;

export const CastAutoStoppedMessageSchema = z.object({
  type: z.literal('CAST_AUTO_STOPPED'),
  tabId: TabIdSchema,
  speakerIp: SpeakerIpSchema,
  reason: CastAutoStopReasonSchema,
});
export type CastAutoStoppedMessage = z.infer<typeof CastAutoStoppedMessageSchema>;

export const SpeakerRemovedMessageSchema = z.object({
  type: z.literal('SPEAKER_REMOVED'),
  tabId: TabIdSchema,
  speakerIp: SpeakerIpSchema,
  reason: SpeakerRemovalReasonSchema,
});
export type SpeakerRemovedMessage = z.infer<typeof SpeakerRemovedMessageSchema>;

export const SpeakerStopFailedMessageSchema = z.object({
  type: z.literal('SPEAKER_STOP_FAILED'),
  tabId: TabIdSchema,
  speakerIp: SpeakerIpSchema,
  error: z.string(),
});
export type SpeakerStopFailedMessage = z.infer<typeof SpeakerStopFailedMessageSchema>;

export const WsConnectionLostMessageSchema = z.object({
  type: z.literal('WS_CONNECTION_LOST'),
  reason: z.string(),
});
export type WsConnectionLostMessage = z.infer<typeof WsConnectionLostMessageSchema>;

export const NetworkHealthStatusSchema = z.enum(['ok', 'degraded']);
export type NetworkHealthStatus = z.infer<typeof NetworkHealthStatusSchema>;

export const NetworkEventMessageSchema = z.object({
  type: z.literal('NETWORK_EVENT'),
  payload: z.object({
    type: z.literal('healthChanged'),
    health: NetworkHealthStatusSchema,
    reason: z.string().optional(),
    timestamp: z.number(),
  }),
});
export type NetworkEventMessage = z.infer<typeof NetworkEventMessageSchema>;

export const NetworkHealthChangedMessageSchema = z.object({
  type: z.literal('NETWORK_HEALTH_CHANGED'),
  health: NetworkHealthStatusSchema,
  reason: z.string().nullable(),
});
export type NetworkHealthChangedMessage = z.infer<typeof NetworkHealthChangedMessageSchema>;

export const LatencyUpdateMessageSchema = z.object({
  type: z.literal('LATENCY_UPDATE'),
  streamId: z.string(),
  speakerIp: SpeakerIpSchema,
  epochId: z.number().int().nonnegative(),
  latencyMs: z.number(),
  jitterMs: z.number(),
  confidence: z.number().min(0).max(1),
});
export type LatencyUpdateMessage = z.infer<typeof LatencyUpdateMessageSchema>;

export const LatencyStaleMessageSchema = z.object({
  type: z.literal('LATENCY_STALE'),
  streamId: z.string(),
  speakerIp: SpeakerIpSchema,
  epochId: z.number().int().nonnegative(),
});
export type LatencyStaleMessage = z.infer<typeof LatencyStaleMessageSchema>;

/**
 * Latency event forwarded to content script (background → content).
 * We use the LatencyBroadcastEvent type from protocol directly since
 * it's a complex union type.
 */
export const LatencyEventMessageSchema = z.object({
  type: z.literal('LATENCY_EVENT'),
  payload: z.custom<LatencyBroadcastEvent>(),
});
export type LatencyEventMessage = z.infer<typeof LatencyEventMessageSchema>;

export const TopologyEventMessageSchema = z.object({
  type: z.literal('TOPOLOGY_EVENT'),
  payload: z.object({
    type: z.literal('groupsDiscovered'),
    groups: SonosStateSnapshotSchema.shape.groups,
    timestamp: z.number(),
  }),
});
export type TopologyEventMessage = z.infer<typeof TopologyEventMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Control Commands (popup → background → offscreen → desktop)
// ─────────────────────────────────────────────────────────────────────────────

export const SetVolumeMessageSchema = z.object({
  type: z.literal('SET_VOLUME'),
  speakerIp: SpeakerIpSchema,
  volume: VolumeSchema,
});
export type SetVolumeMessage = z.infer<typeof SetVolumeMessageSchema>;

export const SetMuteMessageSchema = z.object({
  type: z.literal('SET_MUTE'),
  speakerIp: SpeakerIpSchema,
  muted: z.boolean(),
});
export type SetMuteMessage = z.infer<typeof SetMuteMessageSchema>;

export const StopPlaybackSpeakerMessageSchema = z.object({
  type: z.literal('STOP_PLAYBACK_SPEAKER'),
  streamId: z.string(),
  speakerIp: SpeakerIpSchema,
});
export type StopPlaybackSpeakerMessage = z.infer<typeof StopPlaybackSpeakerMessageSchema>;

export const ControlMediaMessageSchema = z.object({
  type: z.literal('CONTROL_MEDIA'),
  payload: z.object({
    tabId: TabIdSchema,
    action: MediaActionSchema,
  }),
});
export type ControlMediaMessage = z.infer<typeof ControlMediaMessageSchema>;

/**
 * Control media message sent to content script (background → content).
 * Note: Different shape from ControlMediaMessage - no payload wrapper.
 */
export const ContentControlMediaMessageSchema = z.object({
  type: z.literal('CONTROL_MEDIA'),
  action: MediaActionSchema,
});
export type ContentControlMediaMessage = z.infer<typeof ContentControlMediaMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Codec Detection Messages (background → offscreen)
// ─────────────────────────────────────────────────────────────────────────────

export const DetectCodecsMessageSchema = z.object({
  type: z.literal('DETECT_CODECS'),
});
export type DetectCodecsMessage = z.infer<typeof DetectCodecsMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Messages (popup → background → content)
// ─────────────────────────────────────────────────────────────────────────────

export const SetVideoSyncEnabledMessageSchema = z.object({
  type: z.literal('SET_VIDEO_SYNC_ENABLED'),
  payload: z.object({
    tabId: TabIdSchema,
    enabled: z.boolean(),
  }),
});
export type SetVideoSyncEnabledMessage = z.infer<typeof SetVideoSyncEnabledMessageSchema>;

export const SetVideoSyncTrimMessageSchema = z.object({
  type: z.literal('SET_VIDEO_SYNC_TRIM'),
  payload: z.object({
    tabId: TabIdSchema,
    trimMs: z.number().int(),
  }),
});
export type SetVideoSyncTrimMessage = z.infer<typeof SetVideoSyncTrimMessageSchema>;

export const TriggerResyncMessageSchema = z.object({
  type: z.literal('TRIGGER_RESYNC'),
  payload: z.object({
    tabId: TabIdSchema,
  }),
});
export type TriggerResyncMessage = z.infer<typeof TriggerResyncMessageSchema>;

export const GetVideoSyncStateMessageSchema = z.object({
  type: z.literal('GET_VIDEO_SYNC_STATE'),
  payload: z.object({
    tabId: TabIdSchema,
  }),
});
export type GetVideoSyncStateMessage = z.infer<typeof GetVideoSyncStateMessageSchema>;

export const VideoSyncStateSchema = z.enum(['off', 'acquiring', 'locked', 'stale']);
export type VideoSyncState = z.infer<typeof VideoSyncStateSchema>;

export const VideoSyncStateChangedMessageSchema = z.object({
  type: z.literal('VIDEO_SYNC_STATE_CHANGED'),
  enabled: z.boolean(),
  trimMs: z.number().int(),
  state: VideoSyncStateSchema,
  lockedLatencyMs: z.number().optional(),
});
export type VideoSyncStateChangedMessage = z.infer<typeof VideoSyncStateChangedMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Simple Query Messages (no payload)
// ─────────────────────────────────────────────────────────────────────────────

export const GetCastStatusMessageSchema = z.object({
  type: z.literal('GET_CAST_STATUS'),
});
export type GetCastStatusMessage = z.infer<typeof GetCastStatusMessageSchema>;

export const GetConnectionStatusMessageSchema = z.object({
  type: z.literal('GET_CONNECTION_STATUS'),
});
export type GetConnectionStatusMessage = z.infer<typeof GetConnectionStatusMessageSchema>;
