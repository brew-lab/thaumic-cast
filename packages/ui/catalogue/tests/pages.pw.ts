/*
 * The options page shell on its own (`?frame=options`, the page the OptionsShell section
 * draws in an iframe), in Chromium and WebKit: the document is the one scroller, the column
 * keeps to --page-max, the bar is mounted but 0 tall without a Toast, and with one it sticks
 * to the window's end and the end scroll padding follows it (2.4.11), with nothing above it
 * moving as it comes and goes.
 */
import { expect, test, type Page } from '@playwright/test';

/**
 * Opens the options page alone at a window size.
 * @param page - The page
 * @param width - The window's width
 * @param query - More of the query
 */
async function open(page: Page, width: number, query = ''): Promise<void> {
  await page.setViewportSize({ width, height: 640 });
  await page.goto(`/?frame=options&theme=light${query}`);
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
}

/**
 * Facts about the page: scrollers, the column, the bar and the root's end padding.
 * @param page - The page
 * @returns The facts
 */
const facts = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-sticky-bar]')!;
    const main = document.querySelector('main')!;
    const scrollers = [...document.querySelectorAll('*')].filter((e) => {
      const o = getComputedStyle(e).overflowY;
      return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight;
    }).length;
    const sections = [...main.querySelectorAll('section')].map((s) =>
      Math.round(s.getBoundingClientRect().top + scrollY),
    );
    return {
      scrollers,
      scrollable: document.documentElement.scrollHeight > innerHeight,
      column: main.getBoundingClientRect().width,
      bar: bar.getBoundingClientRect().height,
      barBottom: bar.getBoundingClientRect().bottom,
      vh: innerHeight,
      padEnd: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBlockEnd),
      sections,
    };
  });

for (const width of [400, 1200]) {
  test(`the document is the one scroller and the column keeps to 40rem (${width} px)`, async ({
    page,
  }) => {
    await open(page, width);
    const f = await facts(page);
    expect(f.scrollers).toBe(0);
    expect(f.column).toBeLessThanOrEqual(640);
    expect(f.bar).toBe(0);
  });
}

test('the Toast sticks to the end, the end padding follows it, and nothing above moves', async ({
  page,
}) => {
  await open(page, 400);
  const before = await facts(page);
  await page.getByRole('button', { name: 'Remove Evenings' }).click();
  await expect(page.getByText('Evenings removed.')).toBeVisible();
  // The bar publishes its size from a ResizeObserver, a frame after the Toast is drawn.
  await expect
    .poll(async () => {
      const f = await facts(page);
      return Math.abs(f.padEnd - (f.bar + 8));
    })
    .toBeLessThan(1);
  const during = await facts(page);
  expect(during.bar).toBeGreaterThan(0);
  expect(Math.abs(during.barBottom - during.vh), JSON.stringify(during)).toBeLessThan(1);
  // The bar's height plus --space-3 (8 px).
  expect(Math.abs(during.padEnd - (during.bar + 8)), JSON.stringify(during)).toBeLessThan(1);
  // The set left the last section; the sections above it stay where they were.
  expect(during.sections.slice(0, -1)).toEqual(before.sections.slice(0, -1));
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Evenings removed.')).toHaveCount(0);
  const after = await facts(page);
  expect(after.bar).toBe(0);
  expect(after.sections).toEqual(before.sections);
  // Focus left with the Toast's Undo; it moves on to a control, never to the page.
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
});

test('loading puts the words in place of the sections, with the column busy', async ({ page }) => {
  await open(page, 400, '&busy=1');
  await expect(page.locator('main[aria-busy="true"]')).toHaveCount(1);
  await expect(page.getByText('Loading settings…')).toBeVisible();
  await expect(page.locator('main section')).toHaveCount(0);
});
