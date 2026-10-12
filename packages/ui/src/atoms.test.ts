import { describe, expect, it } from 'bun:test';
import { labelFor, remainingBusyMs, settledStatus } from './Button/action';
import { IN_START, OUT_END, anchorOf, heldAt, inlineSpan, parseTime } from './Button/morph';
import { fillRange, pageStep, percentOf } from './Slider/geometry';
import { CLACKS_PATH, openCells, walkPosition } from './Clacks/snake';
import { BUSY_MIN_MS } from './tokens';

// Modules that import CSS are covered by the catalogue's Playwright tests; these are the
// pure parts of the atoms.

describe('Button action states', () => {
  it('should show done only when the Button has words for it', () => {
    expect(settledStatus('resolved', { done: 'Connected' })).toBe('done');
    expect(settledStatus('resolved', {})).toBe('idle');
  });

  it('should show failed only when the Button has words for it (Stop has none)', () => {
    expect(settledStatus('rejected', { failed: 'Try again' })).toBe('failed');
    expect(settledStatus('rejected', { busy: 'Connecting…' })).toBe('idle');
    expect(settledStatus('rejected')).toBe('idle');
  });

  it('should keep a busy state on screen for at least BUSY_MIN_MS', () => {
    expect(remainingBusyMs(1000, 1100)).toBe(BUSY_MIN_MS - 100);
    expect(remainingBusyMs(1000, 1000 + BUSY_MIN_MS + 5)).toBe(0);
  });

  it('should pick the label for each status, falling back to the idle label', () => {
    const labels = { busy: 'Connecting…', done: 'Connected', failed: 'Try again' };
    expect(labelFor('idle', 'Connect', labels)).toBe('Connect');
    expect(labelFor('busy', 'Connect', labels)).toBe('Connecting…');
    expect(labelFor('done', 'Connect', labels)).toBe('Connected');
    expect(labelFor('failed', 'Connect', labels)).toBe('Try again');
    expect(labelFor('busy', 'Stop')).toBe('Stop');
  });
});

describe('Button change of state', () => {
  it('should read --dur-change in ms, and 0 (instant) for anything else', () => {
    expect(parseTime('268ms')).toBe(268);
    expect(parseTime(' 0.268s ')).toBe(268);
    expect(parseTime('0s')).toBe(0);
    expect(parseTime('')).toBe(0);
    expect(parseTime('var(--dur-effects)')).toBe(0);
  });

  it('should fade the old words out before the new ones start, so they never overlap', () => {
    expect(OUT_END).toBeLessThan(IN_START);
    expect(IN_START).toBeLessThan(1);
  });

  it('should keep the edge the layout keeps: start, end, or the centre', () => {
    const at = (start: number, end: number) => ({ start, end });
    expect(anchorOf(at(10, 110), at(10, 160))).toBe('start');
    expect(anchorOf(at(10, 110), at(-40, 110))).toBe('end');
    expect(anchorOf(at(10, 110), at(-15, 135))).toBe('center');
    expect(anchorOf(at(10, 110), at(10, 110))).toBe('start');
  });

  it('should measure along the inline axis in both directions', () => {
    expect(inlineSpan(10, 110, false)).toEqual({ start: 10, end: 110 });
    expect(inlineSpan(10, 110, true)).toEqual({ start: -110, end: -10 });
  });

  it('should hold the old words where they were, from the edge that stays', () => {
    const box = { start: 100, end: 220 };
    const unit = { start: 115, end: 205 };
    const border = { start: 1, end: 1 };
    expect(heldAt('start', box, unit, border)).toBe('14px');
    expect(heldAt('end', box, unit, border)).toBe('calc(100% - 104px)');
    expect(heldAt('center', box, unit, border)).toBe('calc(50% - 45px)');
  });
});

describe('Slider geometry', () => {
  it('should place a value as a percentage of its range, clamped', () => {
    expect(percentOf(30, 0, 100)).toBe(30);
    expect(percentOf(0, -500, 500)).toBe(50);
    expect(percentOf(900, -500, 500)).toBe(100);
    expect(percentOf(5, 5, 5)).toBe(0);
  });

  it('should fill a plain slider from its low end', () => {
    expect(fillRange(30, 0, 100)).toEqual({ start: 0, end: 30 });
  });

  it('should fill a centred slider from the centre towards the value', () => {
    expect(fillRange(250, -500, 500, 0)).toEqual({ start: 50, end: 75 });
    expect(fillRange(-250, -500, 500, 0)).toEqual({ start: 25, end: 50 });
    expect(fillRange(0, -500, 500, 0)).toEqual({ start: 50, end: 50 });
  });

  it('should move ten steps on Page Up and Page Down, within range', () => {
    expect(pageStep(30, 1, 1, 0, 100)).toBe(40);
    expect(pageStep(5, 1, -1, 0, 100)).toBe(0);
    expect(pageStep(450, 10, 1, -500, 500)).toBe(500);
  });
});

describe('Clacks', () => {
  it('should walk the snake: the top row, then back along the bottom', () => {
    expect([...CLACKS_PATH]).toEqual([0, 1, 2, 3, 7, 6, 5, 4]);
  });

  it('should turn the DOM index into the walk with the CSS formula', () => {
    const fromIndex = CLACKS_PATH.map((_, i) => walkPosition(i + 1) - 1);
    expect(fromIndex).toEqual([...CLACKS_PATH]);
  });

  it('should open three shutters at each step, following the path', () => {
    expect(openCells(2)).toEqual([0, 1, 2]);
    expect(openCells(4)).toEqual([2, 3, 7]);
    expect(openCells(1)).toEqual([0, 1, 4]);
  });
});
