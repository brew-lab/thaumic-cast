import { describe, expect, it } from 'bun:test';
import { labelFor, remainingBusyMs, settledStatus } from './Button/action';
import { fillRange, pageStep, percentOf } from './Slider/geometry';
import { CLACKS_PATH, openCells } from './Clacks/snake';
import { BUSY_MIN_MS } from './tokens';

// Modules that import CSS are covered by the catalogue's Playwright tests; these are the
// pure parts of the atoms.

describe('Button action states', () => {
  it('should show done only when the Button has words for it', () => {
    expect(settledStatus('resolved', { done: 'Connected' })).toBe('done');
    expect(settledStatus('resolved', {})).toBe('idle');
  });

  it('should show failed only when the Button has words for it (Stop has busy only)', () => {
    expect(settledStatus('rejected', { failed: 'Try again' })).toBe('failed');
    expect(settledStatus('rejected', { busy: 'Stopping…' })).toBe('idle');
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

  it('should open three shutters at each step, following the path', () => {
    expect(openCells(2)).toEqual([0, 1, 2]);
    expect(openCells(4)).toEqual([2, 3, 7]);
    expect(openCells(1)).toEqual([0, 1, 4]);
  });
});
