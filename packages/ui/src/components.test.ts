import { describe, expect, it } from 'bun:test';
import { allMuted, meanVolume, volumeSummary } from './GroupVolume/summary';
import { filterRooms } from './RoomPicker/filter';
import { artBand, GREY_SEED } from './MediaHeader/band';
import { startSettable, startShown, startWords, type StartLevelStrings } from './StartLevel/start';

// The pure parts of the popup's components (DESIGN.md §5–§8, Phase 3); their behaviour in
// a browser is in catalogue/tests/components.pw.ts.

const START: StartLevelStrings = {
  label: (name) => `${name} start level`,
  caption: (now, start) => `Now ${now}; starts at ${start}`,
  capped: (now, limit) => `Now ${now}; starts at your limit of ${limit}`,
  cappedFrom: (now) => `capped from ${now}`,
  nowShort: (now) => `now ${now}`,
  levelNow: (now) => `at ${now} now`,
  startsAt: (start) => `starts at ${start}`,
  unknown: (limit) =>
    limit === null ? 'not known yet' : `not known yet; starts no louder than ${limit}`,
  fixed: 'Fixed',
  fixedSpoken: 'fixed level; turn the amplifier instead',
};

describe('the start level (P-start, annex 2 §4)', () => {
  it('should start at the level now when it is at or under the limit', () => {
    const shown = startShown({ now: 18 }, 30);
    expect(shown).toEqual({ kind: 'level', start: 18, now: 18, why: 'plain' });
    const words = startWords(shown, 'Study', START);
    expect(words.text).toBe('18');
    expect(words.sub).toBeUndefined();
    expect(words.caption).toBeUndefined();
    expect(words.name).toBe('Study start level, 18');
  });

  it('should start at the limit when the room is above it, and say it was capped', () => {
    const shown = startShown({ now: 72 }, 30);
    expect(shown).toEqual({ kind: 'level', start: 30, now: 72, why: 'capped' });
    const words = startWords(shown, 'Living Room', START);
    expect(words.text).toBe('30');
    expect(words.sub).toBe('at 72 now');
    expect(words.caption).toBe('Now 72; starts at your limit of 30');
    expect(words.name).toBe('Living Room start level, 30, capped from 72');
    expect(words.valueText).toBe('30, capped from 72');
  });

  it('should let a level set lower by hand win, and say the level now', () => {
    const words = startWords(startShown({ now: 41, set: 12 }, 30), 'Kitchen', START);
    expect(words.text).toBe('12');
    expect(words.sub).toBe('at 41 now');
    expect(words.caption).toBe('Now 41; starts at 12');
    expect(words.name).toBe('Kitchen start level, 12, now 41');
  });

  it('should let a level set higher by hand win, with no warning', () => {
    const words = startWords(startShown({ now: 30, set: 45 }, 30), 'Study', START);
    expect(words.text).toBe('45');
    expect(words.caption).toBe('Now 30; starts at 45');
    expect(words.name).toBe('Study start level, 45, now 30');
    expect(JSON.stringify(words)).not.toMatch(/limit|warn/i);
  });

  it('should show "…" while the level is not known, and say the limit', () => {
    const shown = startShown({}, 30);
    expect(shown).toEqual({ kind: 'unknown', limit: 30 });
    const words = startWords(shown, 'Bedroom', START);
    expect(words.text).toBe('…');
    expect(words.spoken).toBe(', not known yet; starts no louder than 30');
    expect(words.name).toBeUndefined();
  });

  it('should let "…" be set by hand only while the limit is on', () => {
    expect(startSettable(startShown({}, 30))).toBe(true);
    expect(startSettable(startShown({}, null))).toBe(false);
    expect(startSettable(startShown({ now: 40, fixed: true }, 30))).toBe(false);
    expect(startSettable(startShown({ now: 40 }, null))).toBe(true);
  });

  it('should show "Fixed" for a fixed output, whatever else is known', () => {
    const words = startWords(startShown({ now: 75, set: 20, fixed: true }, 30), 'Port', START);
    expect(words.text).toBe('Fixed');
    expect(words.spoken).toBe(', fixed level; turn the amplifier instead');
    expect(words.name).toBeUndefined();
  });

  it('should start at the level now when the limit is off', () => {
    const words = startWords(startShown({ now: 52 }, null), 'Study', START);
    expect(words.text).toBe('52');
    expect(words.caption).toBeUndefined();
    expect(startWords(startShown({}, null), 'Study', START).spoken).toBe(', not known yet');
  });

  it('should say nothing more when a hand-set level equals the level now', () => {
    const words = startWords(startShown({ now: 41, set: 41 }, 30), 'Kitchen', START);
    expect(words.sub).toBeUndefined();
    expect(words.caption).toBeUndefined();
  });

  it('should keep a hand-set level while the level now is still unknown', () => {
    expect(startShown({ set: 20 }, 30)).toEqual({ kind: 'level', start: 20, why: 'plain' });
  });

  it('should say only the start after an unchosen room, as its sub line says the rest', () => {
    expect(startWords(startShown({ now: 72 }, 30), 'Living Room', START).spoken).toBe(
      ', starts at 30',
    );
  });
});

describe('the artwork-seeded band (T-colour)', () => {
  it('should swap a near-grey seed for purple-grey', () => {
    expect(artBand([0.55, 0.005, 0])).toEqual({ ...GREY_SEED, red: false });
    expect(artBand([0.5, Number.NaN, 10])).toEqual({ ...GREY_SEED, red: false });
  });

  it('should set the red guard for hue 20 to 40 above chroma .1 only', () => {
    expect(artBand([0.5, 0.2, 27]).red).toBe(true);
    expect(artBand([0.5, 0.1, 27]).red).toBe(false);
    expect(artBand([0.5, 0.2, 45]).red).toBe(false);
  });

  it('should keep the hue and chroma of a coloured seed, the hue in 0 to 360', () => {
    expect(artBand([0.55, 0.11, 200])).toEqual({ hue: 200, chroma: 0.11, red: false });
    expect(artBand([0.55, 0.11, -160]).hue).toBe(200);
  });
});

describe('the group volume (M-groupvol)', () => {
  const words = {
    muted: 'muted',
    joining: (name: string) => `${name} is joining…`,
    condition: (name: string, word: string) => `${name} ${word.toLowerCase()}`,
  };

  it('should read the master as the mean of the known levels, rounded', () => {
    expect(
      meanVolume([
        { name: 'A', volume: 30, muted: false },
        { name: 'B', volume: 45, muted: false },
        { name: 'C', muted: false },
      ]),
    ).toBe(38);
    expect(meanVolume([{ name: 'A', muted: false }])).toBeUndefined();
  });

  it('should leave a joining room out of the mean and out of muted', () => {
    const rooms = [
      { name: 'A', volume: 20, muted: true },
      { name: 'B', volume: 80, muted: false, joining: { level: 80 } },
    ];
    expect(meanVolume(rooms)).toBe(20);
    expect(allMuted(rooms)).toBe(true);
    expect(
      allMuted([
        { name: 'A', volume: 20, muted: true },
        { name: 'C', muted: false },
      ]),
    ).toBe(false);
  });

  it('should list conditions first, then levels, then joining rooms', () => {
    expect(
      volumeSummary(
        [
          { name: 'Kitchen', volume: 30, muted: false },
          { name: 'Living Room', volume: 46, muted: true },
          { name: 'TV Room', volume: 25, muted: false, condition: 'May cut out' },
          { name: 'Bedroom', volume: 30, muted: false, joining: { level: 30 } },
          { name: 'Garden', muted: false },
        ],
        words,
      ),
    ).toBe('TV Room may cut out · Kitchen 30 · Living Room muted · Garden … · Bedroom is joining…');
  });
});

describe('the picker search (C-picker)', () => {
  const rooms = ['Bathroom', 'Bedroom', 'Kitchen', 'Study', 'Café'].map((name) => ({
    room: { id: name, name },
    checked: name === 'Kitchen' || name === 'Bedroom' || name === 'Study',
  }));

  it('should show every room for an empty query', () => {
    expect(filterRooms(rooms, '  ')).toEqual({ shown: rooms, hiddenChosen: 0 });
  });

  it('should filter by name ignoring case and accents, and count the chosen rooms it hides', () => {
    const { shown, hiddenChosen } = filterRooms(rooms, 'ROOM');
    expect(shown.map((r) => r.room.name)).toEqual(['Bathroom', 'Bedroom']);
    expect(hiddenChosen).toBe(2);
    expect(filterRooms(rooms, 'cafe').shown.map((r) => r.room.name)).toEqual(['Café']);
  });

  it('should never change a choice', () => {
    filterRooms(rooms, 'x');
    expect(rooms.filter((r) => r.checked)).toHaveLength(3);
  });
});
