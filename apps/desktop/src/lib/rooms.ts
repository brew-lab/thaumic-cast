/**
 * The Speakers view's rooms: one card per room, worked out from the household's groups, the
 * casts and the transport states, in the order the view shows them.
 */
import { roomsOf, type Room, type ZoneGroup } from '@thaumic-cast/protocol';
import { speakerBadge, type SpeakerBadge } from './speaker-badge';

/** One room as its card shows it. */
export interface RoomCardData {
  /** The room. */
  room: Room;
  /** Its speaker's model, from the household ("Sonos One"), if known. */
  model?: string;
  /** Whether one of our casts plays in it. */
  casting: boolean;
  /** Its Badge, or null when there is no state to show. */
  badge: SpeakerBadge | null;
}

/**
 * The rooms, one card each, casting rooms first and then by name. A room casts when its speaker, or
 * its group's coordinator, plays one of our streams; its Badge reads the room's own transport
 * state, or its group coordinator's when the room has none of its own (a member follows its
 * coordinator).
 * @param groups - The household's Sonos groups
 * @param casting - The IPs of the speakers playing one of our streams
 * @param transportStates - Each speaker's transport state, by IP
 * @returns The cards' data, in order
 */
export function roomCards(
  groups: readonly ZoneGroup[],
  casting: ReadonlySet<string>,
  transportStates: Readonly<Record<string, string>>,
): RoomCardData[] {
  const models = new Map(groups.flatMap((g) => g.members).map((m) => [m.uuid, m.model] as const));
  return roomsOf(groups)
    .map((room) => {
      // A cast plays on the group's coordinator, so a member room casts when its coordinator does.
      const isCasting = casting.has(room.ip) || casting.has(room.coordinatorIp);
      const state = transportStates[room.ip] ?? transportStates[room.coordinatorIp];
      return {
        room,
        model: models.get(room.id) || undefined,
        casting: isCasting,
        badge: speakerBadge(state, isCasting),
      };
    })
    .sort((a, b) => Number(b.casting) - Number(a.casting));
}

/** A speaker's reserve, as the speaker-health report gives it. */
export interface ReserveReading {
  /** The reserve, in ms. */
  reserveMs?: number;
  /** The level under which the reserve counts as low, in ms. */
  floorMs?: number;
  /** The reserve the speaker settled at on this connection, in ms. */
  targetMs?: number;
}

/** What the reserve Meter draws. */
export interface ReserveMeter {
  /** The reading, in ms (never under 0). */
  value: number;
  /** The top of the scale, in ms. */
  max: number;
  /** The low mark, in ms. */
  low: number;
}

/**
 * The reserve Meter's scale for a reading (DESIGN.md P-diag): the value is the reserve, the
 * low mark the floor, and the top twice the reserve the speaker settled at, or the reading
 * itself when that is higher (so the bar is never past its end).
 * @param reading - The latest speaker-health reading
 * @returns The Meter's numbers, or null with no reserve to show
 */
export function reserveMeter(reading: ReserveReading | undefined): ReserveMeter | null {
  if (reading?.reserveMs === undefined) return null;
  const value = Math.max(0, reading.reserveMs);
  const target = reading.targetMs ?? value;
  return {
    value,
    max: Math.max(2 * target, value, 1),
    low: Math.max(0, reading.floorMs ?? 0),
  };
}
