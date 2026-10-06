import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { renderTokens } from './generate-tokens';
import { hexToOklchCss, oklchToHex } from './oklch';
import { LADDERS, LIVE, SEMANTIC_COLORS, STATUS_SETS } from './tokens.table';

const parse = (css: string): { l: number; c: number; h: number } => {
  const m = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(css);
  if (!m) throw new Error(`Unexpected oklch(): ${css}`);
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) };
};

const tableHexes = (): string[] => {
  const out = Object.values(LADDERS).flat();
  for (const group of [SEMANTIC_COLORS, LIVE]) {
    for (const v of Object.values(group.tokens)) {
      if (typeof v === 'string') out.push(v);
      else out.push(v.light, v.dark);
    }
  }
  for (const set of Object.values(STATUS_SETS)) {
    for (const pair of [set.container, set.on, set.ink]) out.push(pair.light, pair.dark);
  }
  return out.filter((v) => /^#[0-9a-f]{6}$/i.test(v));
};

describe('design tokens', () => {
  it('should match the committed generated files', async () => {
    const files = await renderTokens();
    for (const [path, text] of Object.entries(files)) {
      expect({ path, text: await readFile(path, 'utf8') }).toEqual({ path, text });
    }
  });

  it('should write every drawn hex as oklch() that maps back to the same hex', () => {
    const hexes = tableHexes();
    expect(hexes.length).toBeGreaterThan(100);
    for (const hex of hexes) {
      expect(oklchToHex(parse(hexToOklchCss(hex)))).toBe(hex);
    }
  });

  it('should keep the spec values for type, space, radius and motion', async () => {
    const files = await renderTokens();
    const css = Object.entries(files).find(([p]) => p.endsWith('tokens.css'))?.[1] ?? '';
    const expected = [
      '--text-1: 0.6875rem;',
      '--text-4: clamp(0.875rem, 0.8304rem + 0.1786cqi, 0.9375rem);',
      '--text-8: clamp(2rem, 1.6429rem + 1.4286cqi, 2.5rem);',
      '--text-4-fixed: 0.875rem;',
      '--space-2-5: 0.375rem;',
      '--space-5: clamp(1rem, 0.8214rem + 0.7143cqi, 1.25rem);',
      '--radius-control: 0.5rem;',
      '--radius-dialog: 1.75rem;',
      '--shape-bevel: 0.625rem;',
      '--dur-fast: 183ms;',
      '--dur-effects: 268ms;',
      '--dur-spatial: 480ms;',
      '--dur-step: 120ms;',
      '--ease-spatial: cubic-bezier(0.34, 1.36, 0.64, 1);',
      '--z-sticky: 2;',
      '--warning-ink: light-dark(oklch(52.5% 0.1135 70.56), oklch(85% 0.145 79.8));',
    ];
    for (const line of expected) expect(css).toContain(line);
  });
});
