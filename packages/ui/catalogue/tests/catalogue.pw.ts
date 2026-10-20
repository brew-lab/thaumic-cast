/*
 * The catalogue checks (DESIGN.md §10 row 6).
 *
 * axe: every section, with the page in light and in dark (each section also draws both
 * schemes side by side), against WCAG 2.2 A and AA.
 *
 * Both run in the Chromium and the WebKit project (playwright.config.ts).
 *
 * Screenshots: one per section (both schemes are in it). They run only with
 * DS_SCREENSHOTS=1, which CI sets; locally they are skipped. Baselines are made in CI only:
 * when a section has no baseline yet, the CI run passes and writes the picture into the
 * `catalogue-results` artifact under `new-baselines/`. Download it, copy the files into
 * `packages/ui/catalogue/tests/__screenshots__/<project>/` (chromium or webkit) and commit them. From then on a changed
 * section fails CI until its baseline is replaced the same way.
 */
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The screenshot test is the longest; first, it starts at once instead of after an axe run on
// the same worker.
test('every section matches its screenshot', async ({ page }, testInfo) => {
  test.skip(!process.env.DS_SCREENSHOTS, 'Screenshots run in CI only (DS_SCREENSHOTS=1).');
  // Over fifty sections, some of them several screens tall.
  test.setTimeout(600_000);
  await page.goto('/?theme=light');
  await page.evaluate(() => document.fonts.ready);
  // The catalogue's own sections: a specimen's PopupShell draws a <main> of its own.
  const ids = await page
    .locator('main > section.section[id]')
    .evaluateAll((els) => els.map((e) => e.id));
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const name = `${id}.png`;
    const section = page.locator(`#${id}`);
    // A window's iframe loads lazily, as it nears the view: each is brought there and drawn.
    for (const iframe of await section.locator('iframe').all()) {
      await iframe.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          iframe.evaluate(
            (f: HTMLIFrameElement) => !!f.contentDocument?.getElementById('app')?.childElementCount,
          ),
        )
        .toBe(true);
    }
    if (!existsSync(testInfo.snapshotPath(name))) {
      // At CSS scale, as toHaveScreenshot compares; at WebKit's 2x the tallest sections pass
      // the 32767 px a screenshot can be.
      await section.screenshot({ path: testInfo.outputPath('new-baselines', name), scale: 'css' });
      testInfo.annotations.push({ type: 'new baseline', description: name });
      continue;
    }
    await expect(section).toHaveScreenshot(name);
  }
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
