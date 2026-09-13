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
 *
 * One companion serves several clients at once, so a snapshot lists other
 * clients' sessions alongside your own. Theirs arrive redacted: `streamId` is
 * an opaque placeholder and `streamUrl` is empty, leaving `speakerIp` as the
 * only meaningful field. All three stay required so redacted entries still
 * validate on clients that predate the flag.
 */
export const PlaybackSessionSchema = z.object({
  streamId: z.string(),
  speakerIp: z.string(),
  streamUrl: z.string(),
  /**
   * True when the companion redacted this session because another client owns
   * it. Absent on your own sessions, and on companions predating redaction.
   */
  redacted: z.boolean().optional(),
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
  // Added after the initial protocol shipped; older companions omit it.
  // Default to an empty map so their payloads still validate and the
  // version-mismatch warning path can run.
  groupVolumeFixed: z.record(z.string(), z.boolean()).default({}),
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
    groupVolumeFixed: {},
    transportStates: {},
  };
}

/**
 * Initial state message sent by desktop on WebSocket connect.
 *
 * Carries Sonos state plus the same companion version metadata exchanged in
 * the streaming HANDSHAKE_ACK. The control connection runs on every connect
 * — even when the user never starts a stream — so this is what lets the
 * extension surface the out-of-date warning before the first cast.
 *
 * The version fields use `.catch(undefined)` for the same reason as the
 * handshake ACK: a future companion may report values an older extension
 * doesn't recognise (e.g. an `appType: "cli"`), and we don't want a single
 * unrecognised field to drop the whole payload.
 */
export const InitialStatePayloadSchema = z.object({
  groups: z.array(ZoneGroupSchema),
  transportStates: z.record(z.string(), TransportStateSchema),
  groupVolumes: z.record(z.string(), z.number()),
  groupMutes: z.record(z.string(), z.boolean()),
  // Added after the initial protocol shipped; older companions omit it.
  // Default to an empty map so their payloads still validate and the
  // version-mismatch warning path can run.
  groupVolumeFixed: z.record(z.string(), z.boolean()).default({}),
  sessions: z.array(PlaybackSessionSchema).optional(),
  /** Wire-protocol semver — absent on companions predating 0.4.0. */
  protocolVersion: z.string().optional().catch(undefined),
  /** Companion app semver — absent on companions predating 0.4.0. */
  appVersion: z.string().optional().catch(undefined),
  /**
   * Which companion the extension is talking to — absent on pre-0.4.0
   * companions, and degraded to `undefined` for any future variant
   * this extension doesn't recognise (e.g. `"cli"`).
   */
  appType: z.enum(['desktop', 'server']).optional().catch(undefined),
});
export type InitialStatePayload = z.infer<typeof InitialStatePayloadSchema>;

/**
 * Speaker availability status for UI display.
 *
 * - `available`: idle, or playing something we have no session for
 * - `in_use`: playing from a source outside Thaumic Cast (Spotify, AirPlay, …)
 * - `casting`: this client is casting to it
 * - `remote_cast`: another client of the same companion is casting to it
 *
 * None of these block selection: speakers are shared devices, and taking one
 * over is allowed. The status exists so users don't collide by accident.
 */
export type SpeakerAvailability = 'available' | 'in_use' | 'casting' | 'remote_cast';

/**
 * User-friendly labels for speaker availability status.
 */
export const SPEAKER_AVAILABILITY_LABELS: Record<SpeakerAvailability, string> = {
  available: 'Available',
  in_use: 'In Use',
  casting: 'Casting',
  remote_cast: 'Casting Elsewhere',
} as const;

/**
 * Checks whether a playback session belongs to another client of the companion.
 *
 * The companion redacts other clients' sessions, so a redacted `streamId` is an
 * opaque placeholder: it is stable enough to compare between snapshots, but the
 * companion's audio endpoints reject it. Never use it for anything else.
 * @param session - A session from a state snapshot
 * @returns True if another client owns the session
 */
export function isRemoteSession(session: PlaybackSession): boolean {
  return session.redacted === true;
}

/**
 * Checks whether another client's session is still believed to be running.
 *
 * The session list only arrives with the connect-time snapshot, so a remote
 * session outlives the stream it describes. Transport state, by contrast, is
 * broadcast to every client, so a speaker reading `Stopped` retires the session
 * that named it. Both the picker and the slot count go through here, so one
 * snapshot can never call a speaker free while its stream still holds a slot.
 * @param session - A session from a state snapshot
 * @param state - The snapshot the session came from
 * @returns True if another client owns the session and its speaker hasn't stopped
 */
function isLiveRemoteSession(session: PlaybackSession, state: SonosStateSnapshot): boolean {
  return isRemoteSession(session) && state.transportStates[session.speakerIp] !== 'Stopped';
}

/**
 * Counts the distinct streams other clients are still running on the companion.
 *
 * The companion's concurrent-stream limit is global, not per-client, so this is
 * what a client has to add to its own session count before deciding a slot is
 * free. Streams whose speakers have since stopped are left out, so a stale
 * snapshot can't block a cast the companion would accept.
 * @param state - The current Sonos state snapshot
 * @returns The number of distinct live streams owned by other clients
 */
export function countRemoteStreams(state: SonosStateSnapshot): number {
  const streamIds = new Set<string>();
  for (const session of state.sessions ?? []) {
    if (isLiveRemoteSession(session, state)) streamIds.add(session.streamId);
  }
  return streamIds.size;
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
 * Determines speaker availability from transport state, this client's casts and
 * the sessions the companion reports for its other clients.
 * @param speakerIp - The speaker IP address
 * @param state - The current Sonos state snapshot
 * @param castingSpeakerIps - Array of speaker IPs with active Thaumic Cast sessions on this client
 * @returns The speaker's availability status
 */
export function getSpeakerAvailability(
  speakerIp: string,
  state: SonosStateSnapshot,
  castingSpeakerIps: string[],
): SpeakerAvailability {
  // This client's own cast wins - we know about it first-hand
  if (castingSpeakerIps.includes(speakerIp)) return 'casting';

  const transport = state.transportStates[speakerIp];

  // Another client of the same companion holds this speaker. Sessions whose
  // speaker has since stopped are already excluded, so this self-heals between
  // connects.
  const heldByOtherClient = state.sessions?.some(
    (session) => session.speakerIp === speakerIp && isLiveRemoteSession(session, state),
  );
  if (heldByOtherClient) return 'remote_cast';

  // Check if playing from another source
  if (transport === 'Playing') return 'in_use';

  // Otherwise available (stopped, paused, or unknown state)
  return 'available';
}
