import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { renderTokens } from './generate-tokens';
import { hexToOklchCss, oklchToHex } from './oklch';
import { SET_TOKEN } from '../../../scripts/check-ds';
import { CHROME, LADDERS, LIVE, SEMANTIC_COLORS, STATUS_SETS } from './tokens.table';

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

  it('should keep tokens.ts free of imports, so a service worker can load it alone', async () => {
    // Exported as "@thaumic-cast/ui/tokens": the extension's background reads the toolbar
    // badge colours from it without Preact or CSS.
    const files = await renderTokens();
    const tokens = Object.entries(files).find(([path]) => path.endsWith('src/tokens.ts'));
    expect(tokens).toBeDefined();
    expect(tokens?.[1]).not.toMatch(/^\s*import\b/m);
  });

  it('should write every drawn hex as oklch() that maps back to the same hex', () => {
    const hexes = tableHexes();
    expect(hexes.length).toBeGreaterThan(90);
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

  it('should map every status set onto the --tone-* tokens', async () => {
    const files = await renderTokens();
    const css = Object.entries(files).find(([p]) => p.endsWith('tokens.css'))?.[1] ?? '';
    for (const set of Object.keys(STATUS_SETS)) {
      expect(css).toContain(`[data-tone='${set}'] {
    --tone-container: var(--${set}-container);
    --on-tone-container: var(--on-${set}-container);
    --tone-glyph: var(--${set}-glyph);
    --tone-ink: var(--${set}-ink);
  }`);
    }
  });

  it("should draw the toolbar badge in the sets' inks, with no red of its own", () => {
    const { danger, warning } = CHROME.toolbarBadge;
    expect(danger.light.bg).toBe(STATUS_SETS.danger.ink.light);
    expect(danger.dark.bg).toBe(STATUS_SETS.danger.ink.dark);
    expect(warning.light.bg).toBe(STATUS_SETS.warning.ink.light);
    expect(warning.dark.bg).toBe(STATUS_SETS.warning.ink.dark);
    expect(SEMANTIC_COLORS.tokens).not.toHaveProperty('danger');
    expect(LADDERS).not.toHaveProperty('red');
  });

  it('should reject a status set read by name, and allow the tones', () => {
    for (const read of [
      'var(--danger-ink)',
      'var(--on-warning-container)',
      'var( --success-glyph)',
      'var(--info-container)',
    ]) {
      expect(SET_TOKEN.test(read)).toBe(true);
    }
    for (const read of ['var(--tone-ink)', 'var(--on-danger)', 'var(--on-tone-container)']) {
      expect(SET_TOKEN.test(read)).toBe(false);
    }
  });
});
