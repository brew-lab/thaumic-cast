/*
 * The catalogue checks (DESIGN.md §10 row 6).
 *
 * axe: every section, with the page in light and in dark (each section also draws both
 * schemes side by side), against WCAG 2.2 A and AA.
 *
 * Screenshots: one per section (both schemes are in it). They run only with
 * DS_SCREENSHOTS=1, which CI sets; locally they are skipped. Baselines are made in CI only:
 * when a section has no baseline yet, the CI run passes and writes the picture into the
 * `catalogue-results` artifact under `new-baselines/`. Download it, copy the files into
 * `packages/ui/catalogue/tests/__screenshots__/` and commit them. From then on a changed
 * section fails CI until its baseline is replaced the same way.
 */
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  test(`axe finds no violations with the page in ${theme}`, async ({ page }) => {
    await page.goto(`/?theme=${theme}`);
    await expect(page.locator('main > section').first()).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const summary = results.violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
    );
    expect(summary).toEqual([]);
  });
}

test('every section matches its screenshot', async ({ page }, testInfo) => {
  test.skip(!process.env.DS_SCREENSHOTS, 'Screenshots run in CI only (DS_SCREENSHOTS=1).');
  await page.goto('/?theme=light');
  await page.evaluate(() => document.fonts.ready);
  const ids = await page.locator('main > section').evaluateAll((els) => els.map((e) => e.id));
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const name = `${id}.png`;
    const section = page.locator(`#${id}`);
    if (!existsSync(testInfo.snapshotPath(name))) {
      await section.screenshot({ path: testInfo.outputPath('new-baselines', name) });
      testInfo.annotations.push({ type: 'new baseline', description: name });
      continue;
    }
    await expect(section).toHaveScreenshot(name);
  }
});
