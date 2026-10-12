import { describe, expect, it } from 'bun:test';
import type { Room } from '@thaumic-cast/protocol';

import { castBarLines, planCast, playbackTargets } from './cast-plan';

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
const DECK = room('Deck', '10.0.0.3', ['Kitchen', '10.0.0.1']);
const STUDY = room('Study', '10.0.0.4');
const ROOMS = [DECK, KITCHEN, PATIO, STUDY];
const list = (names: string[]) => names.join(' and ');

describe('planCast', () => {
  it('should cast a room alone in its group to itself, with nothing extra', () => {
    const plan = planCast([STUDY.id], ROOMS);
    expect(plan).toEqual({
      rooms: [STUDY],
      targets: [STUDY.ip],
      targetOf: { [STUDY.id]: STUDY.ip },
      extraRooms: [],
      leaving: [],
      restarting: [],
    });
    expect(castBarLines(plan, list)).toEqual([]);
  });

  it('should cast a grouped room to its whole group, through the coordinator', () => {
    const plan = planCast([PATIO.id], ROOMS);
    expect(plan.targets).toEqual([KITCHEN.ip]);
    expect(plan.targetOf).toEqual({ [PATIO.id]: KITCHEN.ip });
    expect(plan.extraRooms).toEqual([DECK, KITCHEN]);
  });

  it('should add nothing when the chosen rooms are exactly a group', () => {
    const plan = planCast([KITCHEN.id, PATIO.id, DECK.id], ROOMS);
    expect(plan.targets).toEqual([KITCHEN.ip]);
    expect(plan.extraRooms).toEqual([]);
  });

  it('should send one target per group, in the order chosen', () => {
    const plan = planCast([STUDY.id, PATIO.id, KITCHEN.id], ROOMS);
    expect(plan.targets).toEqual([STUDY.ip, KITCHEN.ip]);
    expect(plan.rooms).toEqual([STUDY, PATIO, KITCHEN]);
    expect(plan.extraRooms).toEqual([DECK]);
  });

  it('should leave out a chosen room that is not here, and repeats', () => {
    const plan = planCast(['RINCON_GONE', STUDY.id, STUDY.id], ROOMS);
    expect(plan.rooms).toEqual([STUDY]);
    expect(planCast(['RINCON_GONE'], ROOMS).targets).toEqual([]);
  });
});

describe('castBarLines with an older companion', () => {
  it('should name one room that plays too, and the chosen rooms it is grouped with', () => {
    expect(castBarLines(planCast([KITCHEN.id, DECK.id], ROOMS), list)).toEqual([
      {
        key: 'cast_plays_too',
        params: { count: 1, name: 'Patio', with: 'Deck and Kitchen', names: 'Patio' },
      },
    ]);
  });

  it('should list every room that plays too', () => {
    expect(castBarLines(planCast([PATIO.id], ROOMS), list)[0].params).toMatchObject({
      count: 2,
      names: 'Deck and Kitchen',
    });
  });
});

describe('planCast with a companion that regroups', () => {
  const PLAYING = { [KITCHEN.ip]: 'Playing' as const };

  it('should send each chosen room by its own IP, in the order chosen, with nothing extra', () => {
    const plan = planCast([STUDY.id, PATIO.id], ROOMS, { regroup: true });
    expect(plan.targets).toEqual([STUDY.ip, PATIO.ip]);
    expect(plan.targetOf).toEqual({ [STUDY.id]: STUDY.ip, [PATIO.id]: PATIO.ip });
    expect(plan.extraRooms).toEqual([]);
  });

  it('should say a member leaves its group, and restart nothing when its coordinator stays', () => {
    const plan = planCast([STUDY.id, PATIO.id], ROOMS, { regroup: true, transport: PLAYING });
    expect(plan.leaving).toEqual([PATIO]);
    expect(plan.restarting).toEqual([]);
  });

  it("should say a chosen coordinator's partners start again when their group plays", () => {
    const plan = planCast([KITCHEN.id], ROOMS, { regroup: true, transport: PLAYING });
    expect(plan.leaving).toEqual([KITCHEN]);
    expect(plan.restarting).toEqual([DECK, PATIO]);
  });

  it('should restart nothing when the group is not playing', () => {
    expect(planCast([KITCHEN.id], ROOMS, { regroup: true }).restarting).toEqual([]);
    const paused = { [KITCHEN.ip]: 'PAUSED_PLAYBACK' as const };
    expect(planCast([KITCHEN.id], ROOMS, { regroup: true, transport: paused }).restarting).toEqual(
      [],
    );
  });

  it('should leave and restart only the unchosen rooms of a group partly chosen', () => {
    const plan = planCast([KITCHEN.id, DECK.id], ROOMS, { regroup: true, transport: PLAYING });
    expect(plan.leaving).toEqual([DECK, KITCHEN]);
    expect(plan.restarting).toEqual([PATIO]);
  });

  it('should say nothing when the chosen rooms are exactly a group', () => {
    const plan = planCast([PATIO.id, KITCHEN.id, DECK.id, STUDY.id], ROOMS, {
      regroup: true,
      transport: PLAYING,
    });
    expect(plan.leaving).toEqual([]);
    expect(plan.restarting).toEqual([]);
    expect(castBarLines(plan, list)).toEqual([]);
  });

  it('should measure added rooms against the rooms not in the cast', () => {
    // Add mode: only the rooms being added are chosen; Study already casts.
    const plan = planCast([DECK.id], ROOMS, { regroup: true, transport: PLAYING });
    expect(plan.targets).toEqual([DECK.ip]);
    expect(plan.leaving).toEqual([DECK]);
  });
});

describe('castBarLines with a companion that regroups', () => {
  const PLAYING = { [KITCHEN.ip]: 'Playing' as const };

  it('should say who leaves, then whose music starts again', () => {
    const plan = planCast([KITCHEN.id, STUDY.id], ROOMS, { regroup: true, transport: PLAYING });
    expect(castBarLines(plan, list)).toEqual([
      { key: 'cast_leaves_group', params: { count: 1, name: 'Kitchen', names: 'Kitchen' } },
      { key: 'cast_music_restarts', params: { names: 'Deck and Patio' } },
    ]);
  });

  it('should count every room that leaves, by name', () => {
    const plan = planCast([PATIO.id, DECK.id], ROOMS, { regroup: true, transport: PLAYING });
    expect(castBarLines(plan, list)).toEqual([
      { key: 'cast_leaves_group', params: { count: 2, name: 'Deck', names: 'Deck and Patio' } },
    ]);
  });
});

describe('playbackTargets', () => {
  it('should name the rooms, by their own IPs in the same order, to a companion that regroups', () => {
    const plan = planCast([STUDY.id, PATIO.id], ROOMS, { regroup: true });
    expect(playbackTargets(plan, true)).toEqual({
      speakerIps: [STUDY.ip, PATIO.ip],
      rooms: [STUDY.id, PATIO.id],
    });
  });

  it('should send an older companion the coordinators only', () => {
    const plan = planCast([STUDY.id, PATIO.id], ROOMS);
    expect(playbackTargets(plan, false)).toEqual({ speakerIps: [STUDY.ip, KITCHEN.ip] });
  });
});
