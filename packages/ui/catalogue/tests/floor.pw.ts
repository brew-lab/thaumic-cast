/*
 * The desktop's WebKit floor (DESIGN.md §10, the floors), drawn by the catalogue's floor mode
 * (`?floor=1`, catalogue/floor.ts): the features the floor lacks are taken away, so the
 * fallbacks are what renders. It runs in both projects; the WebKit project is the one that
 * stands for macOS 13 and 14. With DS_SCREENSHOTS=1 it also takes one picture per section
 * under `floor-<section>.png`, each its own test on a page of only that section, made and
 * kept like the other baselines (shots.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openSections, SECTION_IDS } from './open';
import { matchesItsScreenshot } from './shots';

/**
 * Opens the floor in dark: the whole page, or only the sections this file names.
 * @param page - The test's page
 * @param whole - Whether to draw every section, as axe reads it
 */
async function openFloor(page: Page, whole: boolean): Promise<void> {
  if (whole) {
    await page.goto('/?theme=dark&floor=1');
    await expect(page.locator('html[data-ready]')).toHaveCount(1);
  } else {
    await openSections(page, '/?theme=dark&floor=1');
  }
  await expect(page.locator('html[data-floor]')).toHaveCount(1);
}

for (const id of SECTION_IDS) {
  test(`the ${id} section on the floor matches its screenshot`, async ({ page }) => {
    await matchesItsScreenshot(page, '/?theme=dark&floor=1', id, `floor-${id}.png`, (opened) =>
      expect(opened.locator('html[data-floor]')).toHaveCount(1),
    );
  });
}

test('axe finds no violations on the floor', async ({ page }) => {
  test.setTimeout(180_000);
  await openFloor(page, true);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  );
  expect(summary).toEqual([]);
});

test.describe('on the sections it names', () => {
  test.beforeEach(async ({ page }) => {
    await openFloor(page, false);
  });

  test('the themed tokens come from webkit-fallbacks.css, not light-dark()', async ({ page }) => {
    const surface = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
    );
    expect(surface).not.toContain('light-dark');
    // The dark surface, as the fallback file repeats it.
    expect(surface).toMatch(/^oklch\(21% 0?\.028 303\.7\)$/);
  });

  test('a pressed Button keeps its rest corner where corner-shape is missing', async ({ page }) => {
    const radius = await page
      .locator('#button [data-scheme="light"] button[data-force="press"]')
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    // --radius-control (8px), not the bevel a press takes where corner-shape exists: call 29.
    expect(radius).toBe('8px');
  });

  test('the Select falls back to the native list', async ({ page }) => {
    const select = page.locator('#select [data-scheme="light"] select').first();
    expect(await select.evaluate((el) => getComputedStyle(el).appearance)).not.toBe('base-select');
    await expect(select.locator('button')).toHaveCount(0);
  });
});
