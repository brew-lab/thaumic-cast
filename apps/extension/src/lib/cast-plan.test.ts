import { describe, expect, it } from 'bun:test';
import type { Room } from '@thaumic-cast/protocol';

import { planCast, playsTooLine } from './cast-plan';

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
    });
    expect(playsTooLine(plan, list)).toBeNull();
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

describe('playsTooLine', () => {
  it('should name one room that plays too, and the chosen rooms it is grouped with', () => {
    expect(playsTooLine(planCast([KITCHEN.id, DECK.id], ROOMS), list)).toEqual({
      key: 'cast_plays_too',
      params: { count: 1, name: 'Patio', with: 'Deck and Kitchen', names: 'Patio' },
    });
  });

  it('should list every room that plays too', () => {
    expect(playsTooLine(planCast([PATIO.id], ROOMS), list)?.params).toMatchObject({
      count: 2,
      names: 'Deck and Kitchen',
    });
  });
});
