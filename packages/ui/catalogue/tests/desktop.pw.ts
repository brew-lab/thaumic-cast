/*
 * The desktop's parts on their own (`?frame=…`, the pages the desktop sections draw in
 * iframes), in Chromium and WebKit. Dialog: focus starts on Cancel, Esc and Close cancel and
 * give focus back to the opener but wait while the confirm runs, the confirm is busy and closes
 * it, a failed confirm keeps it open, and the actions stack under a 25rem dialog.
 */
import { expect, test, type Page } from '@playwright/test';

/**
 * Opens a frame alone at a window size.
 * @param page - The page
 * @param query - The frame and its query
 * @param width - The window's width
 * @param height - The window's height
 */
async function open(page: Page, query: string, width = 840, height = 640): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`/?frame=${query}&theme=light`);
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
}

/**
 * The accessible name of the focused element.
 * @param page - The page
 * @returns Its words
 */
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return (a?.getAttribute('aria-label') || a?.innerText || '').trim();
  });

test('the Dialog opens on Cancel, and Esc gives focus back to its opener', async ({ page }) => {
  await open(page, 'dialog');
  const opener = page.getByRole('button', { name: 'Stop all casts' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Stop all casts' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/Stops every cast/);
  expect(await focused(page)).toBe('Cancel');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await focused(page)).toBe('Stop all casts');
});

test('Close and Cancel cancel; the page behind is inert while it is open', async ({ page }) => {
  await open(page, 'dialog');
  const opener = page.getByRole('button', { name: 'Stop all casts' });
  await opener.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await opener.click();
  // Tab stays inside a modal dialog.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-stopped]')).toHaveCount(0);
});

test('the confirm is busy, then closes the Dialog', async ({ page }) => {
  await open(page, 'dialog');
  await page.getByRole('button', { name: 'Stop all casts' }).click();
  const stop = page.getByRole('dialog').getByRole('button', { name: 'Stop', exact: true });
  await stop.click();
  await expect(stop).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('[data-stopped]')).toHaveText('Stopped 1 times.');
});

test('a failed confirm keeps the Dialog open and says so', async ({ page }) => {
  await open(page, 'dialog&fail=1');
  await page.getByRole('button', { name: 'Stop all casts' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('Esc waits while the confirm runs, so a failure still shows', async ({ page }) => {
  await open(page, 'dialog&fail=1');
  await page.getByRole('button', { name: 'Stop all casts' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(dialog).toBeVisible();
  // Once it has settled, Esc cancels again.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

for (const [width, stacked] of [
  [600, false],
  [360, true],
] as const) {
  test(`the actions ${stacked ? 'stack' : 'share a row'} in a ${width} px window`, async ({
    page,
  }) => {
    await open(page, 'dialog&open=1', width, 480);
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('dialog button')]
        .slice(-2)
        .map((b) => b.getBoundingClientRect())
        .map((r) => ({ top: Math.round(r.top), left: Math.round(r.left), w: r.width })),
    );
    const [cancel, confirm] = boxes;
    if (stacked) {
      expect(confirm.top).toBeGreaterThan(cancel.top);
      expect(Math.abs(confirm.w - cancel.w)).toBeLessThanOrEqual(1);
    } else {
      expect(confirm.top).toBe(cancel.top);
      expect(confirm.left).toBeGreaterThan(cancel.left);
    }
  });
}

/**
 * The scroll containers drawn on the page.
 * @param page - The page
 * @returns Their tag names
 */
const scrollers = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((e) => e.getClientRects().length > 0)
      .filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY))
      .map((e) => e.tagName.toLowerCase()),
  );

/**
 * The desktop window's layout: its scrollers, the rail, main and the toast row.
 * @param page - The page
 * @returns The facts
 */
const shell = async (page: Page) => ({
  scrollers: await scrollers(page),
  ...(await page.evaluate(() => {
    const row = document.querySelector('[data-toast-row]')!;
    const main = document.querySelector('main')!;
    return {
      documentScrolls: document.documentElement.scrollHeight > innerHeight,
      rail: Math.round(document.querySelector('[data-rail]')!.getBoundingClientRect().width),
      row: row.getBoundingClientRect().height,
      rowInMain: main.contains(row),
      mainBottom: main.getBoundingClientRect().bottom,
      rowTop: row.getBoundingClientRect().top,
    };
  })),
});

for (const [width, rail] of [
  [600, 72],
  [840, 216],
] as const) {
  test(`the DesktopShell has one scroller and a ${rail} px rail at ${width} px`, async ({
    page,
  }) => {
    await open(page, 'desktop&view=server&long=1', width, 640);
    const f = await shell(page);
    expect(f.scrollers).toEqual(['main']);
    expect(f.documentScrolls).toBe(false);
    expect(f.rail).toBe(rail);
    expect(f.row).toBe(0);
  });
}

test('a Toast sits in the row under main, outside the scroller, and never over focus', async ({
  page,
}) => {
  await open(page, 'desktop&view=server&long=1&toast=1', 840, 640);
  const f = await shell(page);
  expect(f.rowInMain).toBe(false);
  expect(f.row).toBeGreaterThan(0);
  expect(f.rowTop).toBeGreaterThanOrEqual(f.mainBottom - 0.5);
  // Tab to the last control in main: it scrolls into view above the row, not under it.
  const last = page.locator('main button').last();
  await last.focus();
  const box = await last.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(f.rowTop + 0.5);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  expect((await shell(page)).row).toBe(0);
});

test("Not found's title is the page heading and its action a link", async ({ page }) => {
  await open(page, 'desktop&view=notfound', 600, 360);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('There is no page here');
  await expect(page.getByRole('link', { name: 'Back to Rooms' })).toBeVisible();
});

test('the full Wizard is not a modal, and its footer is one line with Back from step 2', async ({
  page,
}) => {
  await open(page, 'wizard&step=0', 600, 560);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Carry on' }).click();
  const rows = await page.evaluate(() =>
    ['Skip the formalities', 'Back', 'Carry on'].map((name) => {
      const b = [...document.querySelectorAll('button')].find((e) => e.innerText.trim() === name);
      const r = b!.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    }),
  );
  expect(new Set(rows).size).toBe(1);
  expect(await scrollers(page)).toEqual(['main']);
});
