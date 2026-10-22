/*
 * The settings components in a real browser (Chromium and WebKit): a SettingsSection is one
 * subgrid whose rows end their controls on one edge (and a readout's values on it too), its items are divided by one rule
 * (none under the heading, none round a Notice, none under a subheading or above help), a
 * Notice in it keeps its own padding and sits the section's gap from its neighbours, its
 * action Buttons share one width, rows inside Advanced are divided the same way, and an
 * empty list draws no padding of its own inside it.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSections } from './open';

/**
 * One frame of one of the section's specimens, in the light scheme.
 * @param page - The page
 * @param title - The specimen's title
 * @param range - compact, medium or wide
 * @param density - 0 for the popup density, 1 for the desktop
 * @returns The frame
 */
const frame = (page: Page, title: RegExp, range: string, density: 0 | 1): Locator =>
  page
    .locator('#settings-section [data-scheme="light"] .stack', {
      has: page.getByRole('heading', { name: title }),
    })
    .last()
    .locator(`.frame[data-range="${range}"]`)
    .nth(density);

test.beforeEach(async ({ page }) => {
  await openSections(page, '/?theme=light');
});

for (const density of [0, 1] as const) {
  test(`rows share one control edge from 25rem (${density ? 'desktop' : 'popup'})`, async ({
    page,
  }) => {
    for (const range of ['medium', 'wide']) {
      const result = await frame(page, /^Audio, Bespoke/, range, density).evaluate((el) => {
        const grid = el.querySelector('[data-settings-grid="section"]')!;
        const ends = [...grid.querySelectorAll(':scope > [data-setrow][data-width="narrow"]')].map(
          (row) => Math.round(row.querySelector('select')!.getBoundingClientRect().right),
        );
        return { tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').length, ends };
      });
      expect(result.tracks).toBe(range === 'wide' ? 3 : 2);
      expect(result.ends.length).toBe(4);
      expect(new Set(result.ends).size, JSON.stringify(result.ends)).toBe(1);
    }
  });
}

for (const density of [0, 1] as const) {
  test(`a readout's values end where the Selects end, in every frame (${density ? 'desktop' : 'popup'})`, async ({
    page,
  }) => {
    for (const range of ['compact', 'medium', 'wide']) {
      const result = await frame(page, /^Audio, Bespoke/, range, density).evaluate((el) => {
        const grid = el.querySelector('[data-settings-grid="section"]')!;
        const right = (e: Element) => Math.round(e.getBoundingClientRect().right * 10) / 10;
        const dl = grid.querySelector(':scope > [data-readout]')!;
        return {
          selects: [...grid.querySelectorAll(':scope > [data-setrow][data-width="narrow"]')].map(
            (row) => right(row.querySelector('select')!),
          ),
          values: [...dl.querySelectorAll('dd')].map(right),
          // The readout's own rule runs the grid's full width, as every item's does.
          listWidth: Math.round(dl.getBoundingClientRect().width),
          gridWidth: Math.round(grid.getBoundingClientRect().width),
        };
      });
      const at = `${range}: ${JSON.stringify(result)}`;
      expect(result.selects.length, at).toBe(4);
      expect(result.values.length, at).toBeGreaterThanOrEqual(2);
      for (const value of result.values) {
        expect(Math.abs(value - result.selects[0]), at).toBeLessThanOrEqual(1);
      }
      expect(result.listWidth, at).toBe(result.gridWidth);
    }
  });
}

test('a rule parts each item from the one before, except round a Notice, a subheading or help', async ({
  page,
}) => {
  for (const range of ['compact', 'medium', 'wide']) {
    const items = await frame(page, /^Audio, Bespoke/, range, 1).evaluate((el) => {
      const grid = el.querySelector('[data-settings-grid="section"]')!;
      const head = grid.previousElementSibling!;
      return {
        head: parseFloat(getComputedStyle(head).borderBlockEndWidth),
        items: [...grid.children].map((c) => ({
          what: c.hasAttribute('data-notice') ? 'notice' : c.tagName.toLowerCase(),
          rule: parseFloat(getComputedStyle(c).borderBlockStartWidth),
        })),
      };
    });
    expect(items.head).toBe(0);
    const ruled = items.items.map((item, i) => {
      const prev = items.items[i - 1];
      const plain =
        i === 0 ||
        item.what === 'notice' ||
        item.what === 'p' ||
        prev.what === 'notice' ||
        prev.what === 'h3';
      return { ...item, ok: plain ? item.rule === 0 : item.rule > 0 };
    });
    expect(
      ruled.filter((r) => !r.ok),
      JSON.stringify(ruled),
    ).toEqual([]);
  }
});

for (const density of [0, 1] as const) {
  test(`a Notice in a section keeps its own padding and the section's gap (${density ? 'desktop' : 'popup'})`, async ({
    page,
  }) => {
    for (const range of ['compact', 'medium', 'wide']) {
      const notices = await frame(page, /^Audio, Bespoke/, range, density).evaluate((el) => {
        const px = (v: string): number => parseFloat(v) || 0;
        const r1 = (v: number): number => Math.round(v * 10) / 10;
        const grid = el.querySelector('[data-settings-grid="section"]')!;
        const gr = grid.getBoundingClientRect();
        return [...grid.querySelectorAll(':scope > [data-notice]')].map((n) => {
          const cs = getComputedStyle(n);
          const r = n.getBoundingClientRect();
          const g = n.firstElementChild!.getBoundingClientRect();
          return {
            pad: [
              cs.paddingBlockStart,
              cs.paddingInlineEnd,
              cs.paddingBlockEnd,
              cs.paddingInlineStart,
            ].map(px),
            glyph: [r1(g.left - r.left), r1(g.top - r.top)],
            gap: px(getComputedStyle(grid).rowGap),
            around: [
              r1(r.top - n.previousElementSibling!.getBoundingClientRect().bottom),
              r1(n.nextElementSibling!.getBoundingClientRect().top - r.bottom),
            ],
            edges: [r1(r.left - gr.left), r1(gr.right - r.right)],
          };
        });
      });
      expect(notices.length).toBe(2);
      for (const n of notices) {
        const [start, end, blockEnd, inlineStart] = n.pad;
        expect(start, JSON.stringify(n)).toBeGreaterThan(0);
        expect(start, JSON.stringify(n)).toBe(blockEnd);
        expect(end, JSON.stringify(n)).toBe(inlineStart);
        expect(n.glyph, JSON.stringify(n)).toEqual([inlineStart, start]);
        expect(n.around, JSON.stringify(n)).toEqual([n.gap, n.gap]);
        expect(n.edges, JSON.stringify(n)).toEqual([0, 0]);
      }
    }
  });
}

test('rows inside Advanced are divided by the same rule, with none under the summary', async ({
  page,
}) => {
  const rules = await frame(page, /^Audio, Bespoke/, 'medium', 1).evaluate((el) => {
    const panel = el.querySelector('details > summary + *')!;
    return [...panel.children].map((c) => parseFloat(getComputedStyle(c).borderBlockStartWidth));
  });
  expect(rules[0]).toBe(0);
  expect(rules.slice(1).every((r) => r > 0)).toBe(true);
});

for (const density of [0, 1] as const) {
  test(`every row's help ends on one line, a wide control's too (${density ? 'desktop' : 'popup'})`, async ({
    page,
  }) => {
    // Advanced holds two narrow Selects and the wide one for falling behind, each with help.
    // The help's measure is the same in every row: the label track from 25rem (ending before
    // the control track), the help track from 45rem, the row's width under 25rem. A narrow
    // control stays in the control track; from 25rem the wide one ends on the same edge, and
    // it never runs over the help.
    for (const range of ['compact', 'medium', 'wide']) {
      const result = await frame(page, /^Audio, Bespoke/, range, density).evaluate((el) => {
        const r1 = (v: number): number => Math.round(v * 10) / 10;
        const panel = el.querySelector('details > summary + *')!;
        const cs = getComputedStyle(panel);
        const tracks = cs.gridTemplateColumns.split(' ').map(parseFloat);
        const start = panel.getBoundingClientRect().left + parseFloat(cs.paddingInlineStart);
        const gap = parseFloat(cs.columnGap) || 0;
        const rows = [...panel.querySelectorAll(':scope > [data-setrow]')].map((row) => {
          const help = row.querySelector('[id$="-help"]')!.getBoundingClientRect();
          // The drawn box (the Select's ::before), not the taller hit area over it.
          const control = row.querySelector('select')!.parentElement!.getBoundingClientRect();
          const overlap =
            control.left < help.right &&
            control.right > help.left &&
            control.top < help.bottom &&
            control.bottom > help.top;
          return {
            width: row.getAttribute('data-width'),
            helpStart: r1(help.left),
            helpEnd: r1(help.right),
            controlStart: r1(control.left),
            controlEnd: r1(control.right),
            overlap,
          };
        });
        return {
          tracks: tracks.length,
          labelEnd: r1(start + tracks[0]),
          controlTrack: r1(start + tracks[0] + gap),
          rows,
        };
      });
      const at = `${range}: ${JSON.stringify(result)}`;
      expect(result.rows.length, at).toBe(3);
      expect(result.rows.filter((r) => r.width === 'wide').length, at).toBe(1);
      const ends = result.rows.map((r) => r.helpEnd);
      expect(Math.max(...ends) - Math.min(...ends), at).toBeLessThanOrEqual(1);
      const starts = result.rows.map((r) => r.helpStart);
      expect(Math.max(...starts) - Math.min(...starts), at).toBeLessThanOrEqual(1);
      expect(result.rows.find((r) => r.width === 'wide')!.overlap, at).toBe(false);
      if (range !== 'compact') {
        const controlEnds = result.rows.map((r) => r.controlEnd);
        expect(Math.max(...controlEnds) - Math.min(...controlEnds), at).toBeLessThanOrEqual(1);
      }
      if (range === 'medium') {
        for (const row of result.rows) {
          expect(row.helpEnd, at).toBeLessThanOrEqual(result.labelEnd + 1);
          if (row.width === 'narrow') {
            expect(row.controlStart, at).toBeGreaterThanOrEqual(result.controlTrack - 1);
          }
        }
      }
    }
  });
}

for (const density of [0, 1] as const) {
  test(`action Buttons in a section share one width (${density ? 'desktop' : 'popup'})`, async ({
    page,
  }) => {
    for (const range of ['medium', 'wide']) {
      const widths = await frame(page, /^Actions/, range, density).evaluate((el) =>
        [...el.querySelectorAll('[data-width="action"] button')].map(
          (b) => b.getBoundingClientRect().width,
        ),
      );
      expect(widths.length).toBe(3);
      expect(Math.max(...widths) - Math.min(...widths), JSON.stringify(widths)).toBeLessThan(1);
    }
  });
}

test('an empty list in a section draws no padding of its own', async ({ page }) => {
  for (const range of ['compact', 'medium']) {
    const pad = await frame(page, /^Saved sets/, range, 1).evaluate((el) => {
      const art = el.querySelector('[aria-hidden="true"]')!.parentElement!;
      const cs = getComputedStyle(art);
      return [cs.paddingBlockStart, cs.paddingInlineStart, cs.paddingBlockEnd].map(parseFloat);
    });
    expect(pad).toEqual([0, 0, 0]);
  }
});

test('four choices read two by two from 25rem, never three and an orphan', async ({ page }) => {
  for (const [range, columns] of [
    ['compact', 1],
    ['medium', 2],
    ['wide', 2],
  ] as const) {
    for (const density of [0, 1] as const) {
      const lefts = await frame(page, /^Audio, Bespoke/, range, density).evaluate((el) =>
        [...el.querySelectorAll('fieldset input[type="radio"]')].map((r) =>
          Math.round(r.getBoundingClientRect().left),
        ),
      );
      expect(lefts.length).toBe(4);
      expect(new Set(lefts).size, `${range} ${density}: ${lefts}`).toBe(columns);
    }
  }
});
