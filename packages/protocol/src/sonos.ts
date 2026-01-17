import { z } from 'zod';

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
 * Initial state message sent by desktop on WebSocket connect.
 * Includes Sonos state.
 */
export const InitialStatePayloadSchema = z.object({
  groups: z.array(ZoneGroupSchema),
  transportStates: z.record(z.string(), TransportStateSchema),
  groupVolumes: z.record(z.string(), z.number()),
  groupMutes: z.record(z.string(), z.boolean()),
  sessions: z.array(PlaybackSessionSchema).optional(),
});
export type InitialStatePayload = z.infer<typeof InitialStatePayloadSchema>;

/**
 * Speaker availability status for UI display.
 * Indicates whether a speaker is available, in use by another source, or casting from Thaumic Cast.
 */
export type SpeakerAvailability = 'available' | 'in_use' | 'casting';

/**
 * User-friendly labels for speaker availability status.
 */
export const SPEAKER_AVAILABILITY_LABELS: Record<SpeakerAvailability, string> = {
  available: 'Available',
  in_use: 'In Use',
  casting: 'Casting',
} as const;

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
 * Determines speaker availability considering both transport state and active casts.
 * @param speakerIp - The speaker IP address
 * @param state - The current Sonos state snapshot
 * @param castingSpeakerIps - Array of speaker IPs with active Thaumic Cast sessions
 * @returns The speaker's availability status
 */
export function getSpeakerAvailability(
  speakerIp: string,
  state: SonosStateSnapshot,
  castingSpeakerIps: string[],
): SpeakerAvailability {
  // Check if this speaker has an active Thaumic Cast session
  if (castingSpeakerIps.includes(speakerIp)) return 'casting';

  // Check if playing from another source
  const transport = state.transportStates[speakerIp];
  if (transport === 'Playing') return 'in_use';

  // Otherwise available (stopped, paused, or unknown state)
  return 'available';
}
