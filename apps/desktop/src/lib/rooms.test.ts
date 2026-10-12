import { describe, expect, it } from 'bun:test';
import type { ZoneGroup } from '@thaumic-cast/protocol';

import { reserveMeter, roomCards } from './rooms';

const member = (name: string, ip: string, model = 'Sonos One') => ({
  uuid: `RINCON_${name.toUpperCase()}`,
  ip,
  zoneName: name,
  model,
});

const GROUPS: ZoneGroup[] = [
  {
    id: 'g1',
    name: 'Kitchen',
    coordinatorUuid: 'RINCON_KITCHEN',
    coordinatorIp: '10.0.0.2',
    members: [member('Kitchen', '10.0.0.2'), member('Office', '10.0.0.3', 'Sonos Era 100')],
  },
  {
    id: 'g2',
    name: 'Bedroom',
    coordinatorUuid: 'RINCON_BEDROOM',
    coordinatorIp: '10.0.0.4',
    members: [member('Bedroom', '10.0.0.4')],
  },
  {
    id: 'g3',
    name: 'Attic',
    coordinatorUuid: 'RINCON_ATTIC',
    coordinatorIp: '10.0.0.5',
    members: [member('Attic', '10.0.0.5')],
  },
];

describe('roomCards', () => {
  it('should give every room its own card, a grouped room included', () => {
    const cards = roomCards(GROUPS, new Set(), {});
    expect(cards.map((c) => c.room.name)).toEqual(['Attic', 'Bedroom', 'Kitchen', 'Office']);
    expect(cards.find((c) => c.room.name === 'Office')?.room.groupedWith).toEqual(['Kitchen']);
    expect(cards.find((c) => c.room.name === 'Office')?.model).toBe('Sonos Era 100');
  });

  it('should put casting rooms first, each in name order', () => {
    const cards = roomCards(GROUPS, new Set(['10.0.0.4', '10.0.0.5']), {});
    expect(cards.map((c) => c.room.name)).toEqual(['Attic', 'Bedroom', 'Kitchen', 'Office']);
    const office = roomCards(GROUPS, new Set(['10.0.0.3']), {});
    expect(office.map((c) => c.room.name)).toEqual(['Office', 'Attic', 'Bedroom', 'Kitchen']);
  });

  it("should read a member's state from its coordinator when it has none of its own", () => {
    const cards = roomCards(GROUPS, new Set(), { '10.0.0.2': 'Playing' });
    expect(cards.find((c) => c.room.name === 'Office')?.badge).toEqual({
      key: 'transport.in_use',
      tone: 'warning',
    });
  });

  it('should say Casting for a member room whose coordinator plays our cast', () => {
    const cards = roomCards(GROUPS, new Set(['10.0.0.2']), { '10.0.0.2': 'Playing' });
    const office = cards.find((c) => c.room.name === 'Office');
    expect(office?.casting).toBe(true);
    expect(office?.badge).toEqual({ key: 'device.streaming', tone: 'casting' });
    expect(cards.map((c) => c.room.name)).toEqual(['Kitchen', 'Office', 'Attic', 'Bedroom']);
  });

  it('should say Casting for a room our cast holds', () => {
    const cards = roomCards(GROUPS, new Set(['10.0.0.2']), { '10.0.0.2': 'Playing' });
    expect(cards[0]?.badge).toEqual({ key: 'device.streaming', tone: 'casting' });
  });
});

describe('reserveMeter', () => {
  it('should show nothing without a reserve', () => {
    expect(reserveMeter(undefined)).toBeNull();
    expect(reserveMeter({ floorMs: 150 })).toBeNull();
  });

  it('should scale to twice the settled reserve, with the floor as the low mark', () => {
    expect(reserveMeter({ reserveMs: 380, floorMs: 150, targetMs: 1000 })).toEqual({
      value: 380,
      max: 2000,
      low: 150,
    });
  });

  it('should never draw a reading past the end of the bar or under zero', () => {
    expect(reserveMeter({ reserveMs: 2500, targetMs: 1000 })).toEqual({
      value: 2500,
      max: 2500,
      low: 0,
    });
    expect(reserveMeter({ reserveMs: -20 })).toEqual({ value: 0, max: 1, low: 0 });
  });
});
