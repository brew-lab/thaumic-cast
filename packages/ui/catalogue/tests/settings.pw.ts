/*
 * The settings components in a real browser (Chromium and WebKit): a SettingsSection is one
 * subgrid whose rows end their controls on one edge, its items are divided by one rule
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
