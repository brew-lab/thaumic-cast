import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { GLYPH_NAMES, GLYPHS } from './glyphs';

describe('glyph inventory', () => {
  it('should hold exactly the F-icons list from DESIGN.md', async () => {
    const design = await readFile(new URL('../../DESIGN.md', import.meta.url), 'utf8');
    const row = /\|\s*F-icons\s*\|[^|]*\|\s*33 glyphs plus the mark: ([^.]+)\./.exec(design);
    expect(row).not.toBeNull();
    const listed = row![1].split(',').map((s) => s.trim());
    expect(listed).toHaveLength(33);
    expect<string[]>(GLYPH_NAMES).toEqual(listed);
  });

  it('should mirror only chevron-start and external', () => {
    const mirrored = GLYPH_NAMES.filter((g) => 'mirror' in GLYPHS[g] && GLYPHS[g].mirror);
    expect(mirrored).toEqual(['chevron-start', 'external']);
  });
});
