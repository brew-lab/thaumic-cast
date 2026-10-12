import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { roomAvailability, roomByIp, roomLevel, roomsOf } from './rooms.js';
import { createEmptySonosState, ZoneGroupSchema, type SonosStateSnapshot } from './sonos.js';

interface Fixture {
  groups: unknown[];
  rooms: {
    id: string;
    name: string;
    ip: string;
    coordinatorId: string;
    coordinatorIp: string;
    groupedWith: string[];
  }[];
}

// core parses the same file, so both sides fold rooms the same way.
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../fixtures/rooms.json'), 'utf8'),
) as Fixture;
const groups = fixture.groups.map((group) => ZoneGroupSchema.parse(group));
const rooms = roomsOf(groups);
const room = (name: string) => rooms.find((r) => r.name === name)!;

/**
 * A state with the given maps.
 * @param partial - The fields to set
 * @returns The state
 */
function state(partial: Partial<SonosStateSnapshot>): SonosStateSnapshot {
  return { ...createEmptySonosState(), groups, ...partial };
}

describe('roomsOf', () => {
  it('should fold the shared fixture into the rooms it lists, sorted by name', () => {
    expect(
      rooms.map(({ id, name, ip, coordinatorId, coordinatorIp, groupedWith }) => ({
        id,
        name,
        ip,
        coordinatorId,
        coordinatorIp,
        groupedWith,
      })),
    ).toEqual(fixture.rooms);
  });

  it('should fold a home theatre and a stereo pair into one room each', () => {
    expect(rooms.filter((r) => r.name === 'Living Room')).toHaveLength(1);
    expect(room('Living Room').id).toBe('RINCON_LIVING01400');
    expect(rooms.filter((r) => r.name === 'Study')).toHaveLength(1);
  });

  it('should fold an older companion pair by name, onto the coordinator', () => {
    expect(rooms.filter((r) => r.name === 'Bedroom')).toHaveLength(1);
    expect(room('Bedroom').ip).toBe('192.168.1.41');
  });

  it('should say which rooms are grouped, and who coordinates', () => {
    expect(room('Patio')).toMatchObject({
      groupedWith: ['Kitchen'],
      coordinatorIp: '192.168.1.10',
      isCoordinator: false,
    });
    expect(room('Kitchen').isCoordinator).toBe(true);
  });

  it('should keep two rooms with the same name in different groups', () => {
    const twins = roomsOf([
      {
        id: 'A:1',
        name: 'Den',
        coordinatorUuid: 'A',
        coordinatorIp: '10.0.0.1',
        members: [{ uuid: 'A', ip: '10.0.0.1', zoneName: 'Den' }],
      },
      {
        id: 'B:1',
        name: 'Den',
        coordinatorUuid: 'B',
        coordinatorIp: '10.0.0.2',
        members: [{ uuid: 'B', ip: '10.0.0.2', zoneName: 'Den' }],
      },
    ]);
    expect(twins.map((r) => r.id)).toEqual(['A', 'B']);
  });

  it('should have no rooms with no groups', () => {
    expect(roomsOf([])).toEqual([]);
  });
});

describe('roomLevel', () => {
  it('should read a room alone in its group from the group level', () => {
    const s = state({
      groupVolumes: { '192.168.1.30': 72 },
      groupMutes: { '192.168.1.30': true },
      groupVolumeFixed: { '192.168.1.30': false },
    });
    expect(roomLevel(room('Study'), s)).toEqual({ now: 72, muted: true, fixed: false });
  });

  it('should not know a coordinator inside a bigger group, as its entry is the group level', () => {
    const s = state({ groupVolumes: { '192.168.1.10': 40 } });
    expect(roomLevel(room('Kitchen'), s).now).toBeUndefined();
  });

  it('should read a grouped member only when it has its own level', () => {
    expect(roomLevel(room('Patio'), state({})).now).toBeUndefined();
    expect(roomLevel(room('Patio'), state({ groupVolumes: { '192.168.1.11': 25 } })).now).toBe(25);
  });

  it('should say a fixed output is fixed', () => {
    const s = state({ groupVolumeFixed: { '192.168.1.41': true } });
    expect(roomLevel(room('Bedroom'), s).fixed).toBe(true);
  });

  it("should read a regrouped cast's coordinator by its own level", () => {
    // In a cast played as one group, the companion follows each room's own level.
    const s = state({ groupVolumes: { '192.168.1.10': 40, '192.168.1.11': 25 } });
    expect(roomLevel(room('Kitchen'), s, true).now).toBe(40);
    expect(roomLevel(room('Patio'), s, true).now).toBe(25);
  });
});

describe('roomAvailability', () => {
  it('should ask the coordinator, which is what a cast reaches', () => {
    const s = state({ transportStates: { '192.168.1.10': 'Playing' } });
    expect(roomAvailability(room('Patio'), s, [])).toBe('in_use');
    expect(roomAvailability(room('Patio'), s, ['192.168.1.10'])).toBe('casting');
    expect(roomAvailability(room('Study'), s, [])).toBe('available');
  });
});

describe('roomByIp', () => {
  it('should find the room whose primary has the IP', () => {
    expect(roomByIp(rooms, '192.168.1.11')?.name).toBe('Patio');
    expect(roomByIp(rooms, '192.168.1.21')).toBeUndefined();
  });
});
