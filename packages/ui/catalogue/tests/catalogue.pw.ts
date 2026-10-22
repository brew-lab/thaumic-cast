/*
 * The catalogue checks (DESIGN.md §10 row 6).
 *
 * axe: every section, with the page in light and in dark (each section also draws both
 * schemes side by side), against WCAG 2.2 A and AA.
 *
 * Both run in the Chromium and the WebKit project (playwright.config.ts).
 *
 * Screenshots: one per section (both schemes are in it), each its own test on a page of
 * only that section (shots.ts), so a change to one section never moves another's picture and
 * the CI shards share the sections out. They run only with DS_SCREENSHOTS=1, which CI sets;
 * shots.ts says how a baseline is made and committed.
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SECTION_IDS } from './open';
import { matchesItsScreenshot } from './shots';

for (const id of SECTION_IDS) {
  test(`the ${id} section matches its screenshot`, async ({ page }) => {
    await matchesItsScreenshot(page, '/?theme=light', id, `${id}.png`);
  });
}

// The tests above come from sections/index.ts as open.ts reads it; a section that reading
// missed would have no picture, so the page drawn is the list's check.
test('every section drawn has a screenshot test', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?theme=light');
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
  // The catalogue's own sections: a specimen's PopupShell draws a <main> of its own.
  const drawn = await page
    .locator('main > section.section[id]')
    .evaluateAll((els) => els.map((e) => e.id));
  expect(drawn).toEqual(SECTION_IDS);
});

const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  test(`axe finds no violations with the page in ${theme}`, async ({ page }) => {
    // The whole catalogue, every frame and both schemes, is one long page for axe.
    test.setTimeout(180_000);
    await page.goto(`/?theme=${theme}`);
    await expect(page.locator('html[data-ready]')).toHaveCount(1);
    // Content runs under a StickyActionBar by design (L-bar), so at the top of a long frame
    // whatever sits at the bar's edge is partly under it, and axe (target-size) calls it
    // obscured; which target that is changes with every string. Each bar's scroller is read
    // at its end instead, where its end padding keeps everything clear of the bar.
    await page.evaluate(() => {
      for (const bar of document.querySelectorAll('[data-sticky-bar]')) {
        const scroller = bar.closest<HTMLElement>('[data-scroller]');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }
    });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const summary = results.violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
    );
    expect(summary).toEqual([]);
  });
}
