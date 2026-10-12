import { useMemo } from 'preact/hooks';
import type { Room, SonosStateSnapshot } from '@thaumic-cast/protocol';
import { roomsOf } from '@thaumic-cast/protocol';

/**
 * The rooms in the companion's Sonos state, folded from its groups (a home
 * theatre or a stereo pair is one room) and sorted by name. The background
 * derives them the same way, so a cast plan here matches what it sends.
 * @param state - The Sonos state
 * @returns The rooms
 */
export function useRooms(state: SonosStateSnapshot): Room[] {
  return useMemo(() => roomsOf(state.groups), [state.groups]);
}
