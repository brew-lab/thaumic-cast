import { beforeEach, describe, expect, it } from 'bun:test';
import { createEmptySonosState, type Room, type SonosStateSnapshot } from '@thaumic-cast/protocol';

import { chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import {
  EMPTY_ROOM_SETS,
  LEGACY_SELECTION_KEY,
  ROOM_SETS_KEY,
  checkSetName,
  choiceIsSet,
  choiceOnOpen,
  loadRoomSets,
  migrateSelection,
  parseRoomSets,
  recordLastCast,
  saveRoomSet,
  setRooms,
  type RoomSets,
} from './room-sets';

/**
 * A room alone in its group.
 * @param name - The room's name
 * @param ip - Its IP
 * @returns The room
 */
function room(name: string, ip: string): Room {
  return {
    id: `RINCON_${name.toUpperCase()}`,
    name,
    ip,
    groupId: `${name}:1`,
    coordinatorId: `RINCON_${name.toUpperCase()}`,
    coordinatorIp: ip,
    isCoordinator: true,
    groupedWith: [],
  };
}

const KITCHEN = room('Kitchen', '192.168.1.10');
const PATIO = room('Patio', '192.168.1.11');
const STUDY = room('Study', '192.168.1.12');
const ROOMS = [KITCHEN, PATIO, STUDY];
const ref = (r: Room) => ({ id: r.id, name: r.name });

beforeEach(() => {
  resetChromeStub();
});

describe('parseRoomSets', () => {
  it('should have nothing for a missing or unknown shape', () => {
    expect(parseRoomSets(undefined)).toBeNull();
    expect(parseRoomSets({ version: 2, lastCast: [] })).toBeNull();
  });

  it('should drop a damaged room or set and keep the rest', () => {
    const parsed = parseRoomSets({
      version: 1,
      lastCast: [ref(KITCHEN), { id: 7 }],
      saved: [
        { id: 's1', name: 'Downstairs', rooms: [ref(KITCHEN), 'bad', ref(PATIO)] },
        { id: 's2', name: '', rooms: [] },
        null,
      ],
    });
    expect(parsed).toEqual({
      version: 1,
      lastCast: [ref(KITCHEN)],
      saved: [{ id: 's1', name: 'Downstairs', rooms: [ref(KITCHEN), ref(PATIO)] }],
    });
  });
});

describe('migrateSelection', () => {
  it('should map each old IP to its room, dropping unknown IPs and repeats', () => {
    expect(
      migrateSelection(['192.168.1.12', '10.0.0.9', '192.168.1.10', '192.168.1.12'], ROOMS),
    ).toEqual([ref(STUDY), ref(KITCHEN)]);
  });
});

describe('loadRoomSets', () => {
  it('should move the old selection into Last cast once, and remove it', async () => {
    chromeStorageData.local[LEGACY_SELECTION_KEY] = { selectedIps: ['192.168.1.11'] };

    const sets = await loadRoomSets(ROOMS);

    expect(sets.lastCast).toEqual([ref(PATIO)]);
    expect(chromeStorageData.local[ROOM_SETS_KEY]).toEqual(sets);
    expect(chromeStorageData.local[LEGACY_SELECTION_KEY]).toBeUndefined();
  });

  it('should not migrate before rooms are known', async () => {
    chromeStorageData.local[LEGACY_SELECTION_KEY] = { selectedIps: ['192.168.1.11'] };

    expect(await loadRoomSets([])).toEqual(EMPTY_ROOM_SETS);
    expect(chromeStorageData.local[LEGACY_SELECTION_KEY]).toBeDefined();
    expect(chromeStorageData.local[ROOM_SETS_KEY]).toBeUndefined();
  });

  it('should keep stored sets and never migrate over them', async () => {
    const stored: RoomSets = { version: 1, lastCast: [ref(KITCHEN)], saved: [] };
    chromeStorageData.local[ROOM_SETS_KEY] = stored;
    chromeStorageData.local[LEGACY_SELECTION_KEY] = { selectedIps: ['192.168.1.11'] };

    expect(await loadRoomSets(ROOMS)).toEqual(stored);
  });

  it('should start empty with no old selection', async () => {
    expect(await loadRoomSets(ROOMS)).toEqual(EMPTY_ROOM_SETS);
  });
});

describe('recordLastCast and saveRoomSet', () => {
  it('should record Last cast and keep the saved sets', async () => {
    await saveRoomSet(' Downstairs ', [ref(KITCHEN), ref(PATIO)]);
    await recordLastCast([ref(STUDY)]);

    const sets = parseRoomSets(chromeStorageData.local[ROOM_SETS_KEY]);
    expect(sets?.lastCast).toEqual([ref(STUDY)]);
    expect(sets?.saved.map((s) => s.name)).toEqual(['Downstairs']);
  });

  it('should refuse a set with no name', async () => {
    expect(await saveRoomSet('   ', [ref(KITCHEN)])).toEqual({ error: 'set_name_required' });
    expect(checkSetName(' Up ')).toEqual({ name: 'Up' });
    expect(chromeStorageData.local[ROOM_SETS_KEY]).toBeUndefined();
  });

  it('should not record an empty cast', async () => {
    await recordLastCast([]);
    expect(chromeStorageData.local[ROOM_SETS_KEY]).toBeUndefined();
  });
});

describe('setRooms and choiceIsSet', () => {
  const garden = { id: 'RINCON_GARDEN', name: 'Garden' };

  it('should name the rooms of a set that are missing', () => {
    expect(setRooms([garden, ref(STUDY)], ROOMS)).toEqual({ present: [STUDY], missing: [garden] });
  });

  it('should read pressed when the choice is the set’s present rooms, in any order', () => {
    const set = [ref(PATIO), ref(KITCHEN), garden];
    expect(choiceIsSet([KITCHEN.id, PATIO.id], set, ROOMS)).toBe(true);
    expect(choiceIsSet([KITCHEN.id], set, ROOMS)).toBe(false);
    expect(choiceIsSet([KITCHEN.id, PATIO.id, STUDY.id], set, ROOMS)).toBe(false);
    expect(choiceIsSet([], [garden], ROOMS)).toBe(false);
  });
});

describe('choiceOnOpen', () => {
  const idle: SonosStateSnapshot = createEmptySonosState();

  it('should choose Last cast’s present rooms', () => {
    const sets = { ...EMPTY_ROOM_SETS, lastCast: [ref(STUDY), { id: 'X', name: 'Gone' }] };
    expect(choiceOnOpen(sets, ROOMS, idle, [])).toEqual([STUDY.id]);
  });

  it('should choose the first room nobody else casts to, with no Last cast', () => {
    const busy: SonosStateSnapshot = {
      ...idle,
      sessions: [{ streamId: 'x', speakerIp: KITCHEN.ip, streamUrl: '', redacted: true }],
    };
    expect(choiceOnOpen(EMPTY_ROOM_SETS, ROOMS, busy, [])).toEqual([PATIO.id]);
  });

  it('should choose nothing with no rooms', () => {
    expect(choiceOnOpen(EMPTY_ROOM_SETS, [], idle, [])).toEqual([]);
  });
});
