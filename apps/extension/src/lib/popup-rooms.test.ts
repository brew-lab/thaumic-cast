import { describe, expect, it } from 'bun:test';
import type { Room } from '@thaumic-cast/protocol';
import { createEmptySonosState } from '@thaumic-cast/protocol';

import {
  addableRooms,
  barReplaceHint,
  canSaveSet,
  castRows,
  inCast,
  masterTargets,
  replaceHint,
  scaleLevels,
  setViews,
  undoLevels,
} from './popup-rooms';
import type { CastPlan } from './cast-plan';
import { EMPTY_ROOM_SETS, type RoomSets } from './room-sets';

/**
 * A room in a Sonos group.
 * @param name - The room's name
 * @param ip - Its IP
 * @param coordinator - The group's coordinator room name and IP; itself when absent
 * @returns The room
 */
function room(name: string, ip: string, coordinator?: [string, string]): Room {
  const [coordinatorName, coordinatorIp] = coordinator ?? [name, ip];
  return {
    id: `RINCON_${name.toUpperCase()}`,
    name,
    ip,
    groupId: `${coordinatorName}:1`,
    coordinatorId: `RINCON_${coordinatorName.toUpperCase()}`,
    coordinatorIp,
    isCoordinator: coordinatorName === name,
    groupedWith: [],
  };
}

const KITCHEN = room('Kitchen', '10.0.0.1');
const PATIO = room('Patio', '10.0.0.2', ['Kitchen', '10.0.0.1']);
const STUDY = room('Study', '10.0.0.4');
const BEDROOM = room('Bedroom', '10.0.0.5');
const ROOMS = [BEDROOM, KITCHEN, PATIO, STUDY];

const ref = (r: Room) => ({ id: r.id, name: r.name });

describe('setViews', () => {
  it('should offer Last cast, the saved sets, then Everywhere from three rooms', () => {
    const sets: RoomSets = {
      version: 1,
      lastCast: [ref(KITCHEN)],
      saved: [{ id: 'evenings', name: 'Evenings', rooms: [ref(KITCHEN), ref(STUDY)] }],
    };
    const views = setViews(sets, ROOMS, [KITCHEN.id]);
    expect(views.map((view) => [view.id, view.pressed])).toEqual([
      ['last', true],
      ['evenings', false],
      ['everywhere', false],
    ]);
    expect(views[1].name).toBe('Evenings');
    expect(setViews(EMPTY_ROOM_SETS, [KITCHEN, STUDY], []).map((view) => view.id)).toEqual([]);
  });

  it('should keep a set with a missing room, naming it, and drop one with none here', () => {
    const gone = { id: 'RINCON_GARDEN', name: 'Garden' };
    const sets: RoomSets = {
      version: 1,
      lastCast: [gone],
      saved: [{ id: 'out', name: 'Outside', rooms: [gone, ref(STUDY)] }],
    };
    const views = setViews(sets, [KITCHEN, STUDY], [STUDY.id]);
    expect(views.map((view) => view.id)).toEqual(['out']);
    expect(views[0].missing).toEqual([gone]);
    expect(views[0].present).toEqual([STUDY]);
    expect(views[0].pressed).toBe(true);
  });

  it('should press Everywhere only when every room is chosen', () => {
    const all = setViews(
      EMPTY_ROOM_SETS,
      ROOMS,
      ROOMS.map((r) => r.id),
    );
    expect(all.find((view) => view.id === 'everywhere')?.pressed).toBe(true);
  });

  it('should press only one set when the choice is several: Everywhere, then saved, then Last cast', () => {
    const pressed = (sets: RoomSets, choice: string[]) =>
      setViews(sets, ROOMS, choice)
        .filter((view) => view.pressed)
        .map((view) => view.id);
    const both = [KITCHEN.id, STUDY.id];
    const all = ROOMS.map((r) => r.id);
    const sets = (lastCast: Room[]): RoomSets => ({
      version: 1,
      lastCast: lastCast.map(ref),
      saved: [
        { id: 'evenings', name: 'Evenings', rooms: [ref(KITCHEN), ref(STUDY)] },
        { id: 'again', name: 'Again', rooms: [ref(STUDY), ref(KITCHEN)] },
        { id: 'house', name: 'House', rooms: ROOMS.map(ref) },
      ],
    });

    expect(pressed(sets([KITCHEN, STUDY]), both)).toEqual(['evenings']);
    expect(pressed(sets(ROOMS), all)).toEqual(['everywhere']);
    expect(pressed(sets([KITCHEN]), [KITCHEN.id])).toEqual(['last']);
  });

  it('should leave out Last cast when a saved set or Everywhere holds exactly its rooms', () => {
    const ids = (lastCast: Room[]) =>
      setViews(
        {
          version: 1,
          lastCast: lastCast.map(ref),
          saved: [{ id: 'evenings', name: 'Evenings', rooms: [ref(STUDY), ref(KITCHEN)] }],
        },
        ROOMS,
        [],
      ).map((view) => view.id);
    expect(ids([KITCHEN, STUDY])).toEqual(['evenings', 'everywhere']);
    expect(ids(ROOMS)).toEqual(['evenings', 'everywhere']);
    expect(ids([KITCHEN])).toEqual(['last', 'evenings', 'everywhere']);
  });
});

describe('canSaveSet', () => {
  it('should offer saving two or more rooms that equal no set', () => {
    const views = setViews(EMPTY_ROOM_SETS, ROOMS, [KITCHEN.id, STUDY.id]);
    expect(canSaveSet([KITCHEN.id, STUDY.id], views)).toBe(true);
    expect(canSaveSet([KITCHEN.id], views)).toBe(false);
    const everywhere = setViews(
      EMPTY_ROOM_SETS,
      ROOMS,
      ROOMS.map((r) => r.id),
    );
    expect(
      canSaveSet(
        ROOMS.map((r) => r.id),
        everywhere,
      ),
    ).toBe(false);
  });
});

describe('replaceHint', () => {
  it('should say a cast on a chosen room ends, before what plays there stops', () => {
    const state = {
      ...createEmptySonosState(),
      transportStates: { [STUDY.ip]: 'Playing' as const },
    };
    expect(replaceHint([STUDY], state, [])).toBe('hint_replace_source');
    expect(replaceHint([STUDY, KITCHEN], state, [KITCHEN.ip])).toBe('hint_replace_cast');
    expect(replaceHint([BEDROOM], state, [])).toBeNull();
  });
});

describe('barReplaceHint', () => {
  const plan = (restarting: Room[]): CastPlan => ({
    rooms: [KITCHEN],
    targets: [KITCHEN.ip],
    targetOf: { [KITCHEN.id]: KITCHEN.ip },
    extraRooms: [],
    leaving: [KITCHEN],
    restarting,
  });

  it('should drop "whatever plays will stop" when the bar says music starts again', () => {
    expect(barReplaceHint(plan([STUDY]), 'hint_replace_source')).toBeNull();
    expect(barReplaceHint(plan([]), 'hint_replace_source')).toBe('hint_replace_source');
  });

  it('should still say a cast on a chosen room ends', () => {
    expect(barReplaceHint(plan([STUDY]), 'hint_replace_cast')).toBe('hint_replace_cast');
    expect(barReplaceHint(plan([STUDY]), null)).toBeNull();
  });
});

describe('castRows', () => {
  it('should give one row per target, naming a Sonos group by its rooms', () => {
    const rows = castRows(
      { speakerIps: [KITCHEN.ip, STUDY.ip, '10.0.0.9'], speakerNames: ['K', 'S', 'Gone'] },
      ROOMS,
    );
    expect(rows).toEqual([
      { ip: KITCHEN.ip, name: 'Kitchen + Patio', roomIds: [KITCHEN.id, PATIO.id] },
      { ip: STUDY.ip, name: 'Study', roomIds: [STUDY.id] },
      { ip: '10.0.0.9', name: 'Gone', roomIds: [] },
    ]);
  });

  it('should keep one row per room on a cast joined into one Sonos group', () => {
    // "Play speakers as one group": Bedroom and Study were cast to, then joined to Bedroom.
    const joinedStudy = room('Study', STUDY.ip, ['Bedroom', BEDROOM.ip]);
    const rows = castRows(
      { speakerIps: [BEDROOM.ip, STUDY.ip], speakerNames: ['Bedroom', 'Study'] },
      [BEDROOM, KITCHEN, PATIO, joinedStudy],
    );
    expect(rows).toEqual([
      { ip: BEDROOM.ip, name: 'Bedroom', roomIds: [BEDROOM.id] },
      { ip: STUDY.ip, name: 'Study', roomIds: [joinedStudy.id] },
    ]);
    expect(rows.reduce((sum, row) => sum + row.roomIds.length, 0)).toBe(2);
  });

  it('should still give a joined group partner that no target names to the coordinator', () => {
    const joinedStudy = room('Study', STUDY.ip, ['Kitchen', KITCHEN.ip]);
    const rows = castRows({ speakerIps: [KITCHEN.ip, STUDY.ip], speakerNames: ['K', 'S'] }, [
      KITCHEN,
      PATIO,
      joinedStudy,
    ]);
    expect(rows.map((row) => row.name)).toEqual(['Kitchen + Patio', 'Study']);
  });
});

describe('castRows for a regrouped cast', () => {
  it('should give a removed room no row while the topology still shows it in the group', () => {
    const study = room('Study', STUDY.ip, ['Kitchen', KITCHEN.ip]);
    const cast = {
      speakerIps: [KITCHEN.ip],
      speakerNames: ['Kitchen'],
      roomIds: [KITCHEN.id],
      syncSpeakers: true,
    };
    expect(castRows(cast, [KITCHEN, study]).map((row) => row.name)).toEqual(['Kitchen']);
  });
});

describe('undoLevels', () => {
  const grouped = (r: Room, partner: Room): Room => ({ ...r, groupedWith: [partner.name] });

  it("should re-add each room of a Sonos group row at its own level, not the group's", () => {
    const kitchen = grouped(KITCHEN, PATIO);
    const patio = grouped(PATIO, KITCHEN);
    const state = {
      ...createEmptySonosState(),
      // The group's volume sits on the coordinator; each room's own level by its IP.
      groupVolumes: { [KITCHEN.ip]: 40, [PATIO.ip]: 70 },
    };
    const row = { ip: KITCHEN.ip, name: 'Kitchen + Patio', roomIds: [kitchen.id, patio.id] };
    // The coordinator's own level is not known inside a bigger group: the limit rule applies.
    expect(undoLevels(row, [kitchen, patio], state)).toEqual({ [patio.id]: 70 });
  });

  it("should re-add a regrouped cast's coordinator at its own level", () => {
    const kitchen = grouped(KITCHEN, PATIO);
    const state = { ...createEmptySonosState(), groupVolumes: { [KITCHEN.ip]: 40 } };
    const row = { ip: KITCHEN.ip, name: 'Kitchen', roomIds: [kitchen.id] };
    expect(undoLevels(row, [kitchen, PATIO], state, true)).toEqual({ [kitchen.id]: 40 });
  });

  it('should re-add a room alone in its group at its level now', () => {
    const state = { ...createEmptySonosState(), groupVolumes: { [STUDY.ip]: 12 } };
    const row = { ip: STUDY.ip, name: 'Study', roomIds: [STUDY.id] };
    expect(undoLevels(row, ROOMS, state)).toEqual({ [STUDY.id]: 12 });
    expect(undoLevels(row, ROOMS, createEmptySonosState())).toEqual({});
  });
});

describe('masterTargets', () => {
  it('should move a joined cast by its group, and a room added later on its own', () => {
    const joinedStudy = room('Study', STUDY.ip, ['Bedroom', BEDROOM.ip]);
    const cast = { speakerIps: [BEDROOM.ip, STUDY.ip, KITCHEN.ip], syncSpeakers: true };
    expect(masterTargets(cast, [BEDROOM, joinedStudy, KITCHEN, PATIO])).toEqual({
      joined: [BEDROOM.ip, STUDY.ip],
      solo: [KITCHEN.ip],
    });
  });

  it('should move every room of a regrouped cast by the group, whatever the order', () => {
    // Regrouped into Study's group; the rows are sorted by name, so Study is not first.
    const bedroom = room('Bedroom', BEDROOM.ip, ['Study', STUDY.ip]);
    const kitchen = room('Kitchen', KITCHEN.ip, ['Study', STUDY.ip]);
    const cast = { speakerIps: [BEDROOM.ip, KITCHEN.ip, STUDY.ip], syncSpeakers: true };
    expect(masterTargets(cast, [bedroom, kitchen, PATIO, STUDY])).toEqual({
      joined: [BEDROOM.ip, KITCHEN.ip, STUDY.ip],
      solo: [],
    });
  });

  it('should move every target on its own when the cast is not joined', () => {
    expect(
      masterTargets({ speakerIps: [BEDROOM.ip, STUDY.ip], syncSpeakers: false }, ROOMS),
    ).toEqual({ joined: [], solo: [BEDROOM.ip, STUDY.ip] });
    // Asked to join, but the topology has not joined them (yet).
    expect(
      masterTargets({ speakerIps: [BEDROOM.ip, STUDY.ip], syncSpeakers: true }, ROOMS),
    ).toEqual({ joined: [], solo: [BEDROOM.ip, STUDY.ip] });
  });
});

describe('addableRooms', () => {
  it('should offer every room the cast does not already play in', () => {
    const cast = { speakerIps: [KITCHEN.ip], roomIds: [KITCHEN.id], syncSpeakers: false };
    expect(addableRooms(cast, ROOMS)).toEqual([BEDROOM, STUDY]);
  });

  it('should not offer a room already joining the cast', () => {
    const cast = { speakerIps: [KITCHEN.ip], roomIds: [KITCHEN.id], syncSpeakers: false };
    expect(addableRooms(cast, ROOMS, [BEDROOM.id])).toEqual([STUDY]);
  });

  it('should offer nothing once the cast plays in every room', () => {
    const cast = {
      speakerIps: ROOMS.map((room) => room.coordinatorIp),
      roomIds: ROOMS.map((room) => room.id),
      syncSpeakers: false,
    };
    expect(addableRooms(cast, ROOMS)).toEqual([]);
  });

  it("should offer a room by the cast's rooms when it plays as one group", () => {
    // Patio is still grouped with Kitchen, but the cast played only Kitchen.
    const cast = { speakerIps: [KITCHEN.ip], roomIds: [KITCHEN.id], syncSpeakers: true };
    expect(addableRooms(cast, ROOMS)).toEqual([BEDROOM, PATIO, STUDY]);
    expect(inCast(cast, KITCHEN)).toBe(true);
    expect(inCast(cast, PATIO)).toBe(false);
  });

  it('should fall back to the Sonos group for a cast that names no rooms', () => {
    const cast = { speakerIps: [KITCHEN.ip], roomIds: [], syncSpeakers: true };
    expect(addableRooms(cast, ROOMS)).toEqual([BEDROOM, STUDY]);
  });
});

describe('scaleLevels', () => {
  it('should move every row by the same ratio, keeping the balance', () => {
    expect(scaleLevels([20, 40], 60)).toEqual([40, 80]);
    expect(scaleLevels([20, 40], 15)).toEqual([10, 20]);
  });

  it('should stay within 0 to 100', () => {
    expect(scaleLevels([10, 90], 80)).toEqual([16, 100]);
  });

  it('should set every row to the master when nothing is known or all are silent', () => {
    expect(scaleLevels([undefined, 30], 45)).toEqual([45, 45]);
    expect(scaleLevels([0, 0], 25)).toEqual([25, 25]);
  });
});
