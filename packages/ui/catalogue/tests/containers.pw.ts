/*
 * The containers and the CSS the audit asked for, in a real browser (Chromium and WebKit):
 * every frame lands in its range, settings rows share one control column, the narrow rail
 * shows its Tooltip and the wide one does not, the fluid ramp follows its container, the
 * Clacks walk from their index, a .num box holds on a plain span, and the live heading is
 * never drawn invisible.
 */
import { expect, test, type Page } from '@playwright/test';
import { openSections } from './open';

const light = (page: Page, id: string) => page.locator(`#${id} [data-scheme="light"]`);

test.beforeEach(async ({ page }) => {
  await openSections(page, '/?theme=light');
});

test('every frame is drawn in the range it names', async ({ page }) => {
  for (const id of ['container-frames', 'container-fields']) {
    const labels = await light(page, id).locator('.frame > .label').allTextContents();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((l) => l.includes('too narrow'))).toEqual([]);
  }
});

test('settings rows end their controls in one column from 25rem', async ({ page }) => {
  // The desktop density's medium frame of the settings card.
  const frame = light(page, 'container-frames')
    .locator('.stack', { has: page.getByRole('heading', { name: /^SettingsRow on its section/ }) })
    .last()
    .locator('.frame[data-range="medium"]')
    .nth(1);
  const result = await frame.evaluate((el) => {
    const body = el.querySelector('[data-settings-grid="section"]');
    const ends = [...el.querySelectorAll('[data-setrow][data-width="narrow"]')].map((row) => {
      const control =
        row.querySelector('button[role="switch"]') ??
        row.querySelector(':scope > div > p + div')?.firstElementChild;
      return control ? Math.round(control.getBoundingClientRect().right) : -1;
    });
    return {
      tracks: body ? getComputedStyle(body).gridTemplateColumns.split(' ').length : 0,
      ends,
    };
  });
  expect(result.tracks).toBe(2);
  expect(result.ends.length).toBeGreaterThan(3);
  expect(new Set(result.ends).size, JSON.stringify(result.ends)).toBe(1);
});

test('the narrow rail shows a NavItem tooltip on focus; the wide rail does not', async ({
  page,
}) => {
  const narrow = light(page, 'rail').locator('[data-rail="narrow"]');
  const wide = light(page, 'rail').locator('[data-rail="wide"]');
  await narrow.getByRole('link', { name: 'Server' }).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(narrow.locator('[role="tooltip"]', { hasText: 'Server' })).toBeVisible();
  await wide.getByRole('link', { name: 'Server' }).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(wide.locator('[role="tooltip"]', { hasText: 'Server' })).toBeHidden();
});

test('the fluid ramp runs from its minimum at 352 px to its maximum at 960 px', async ({
  page,
}) => {
  const sizes = await light(page, 'fluid')
    .locator('.ramp-box')
    .evaluateAll((boxes) =>
      boxes.map((box) => {
        const step = box.querySelector<HTMLElement>('[data-step="--text-8"]');
        return step ? Math.round(parseFloat(getComputedStyle(step).fontSize)) : 0;
      }),
    );
  expect(sizes[0]).toBe(32);
  expect(sizes[1]).toBeGreaterThan(32);
  expect(sizes[1]).toBeLessThan(40);
  expect(sizes[2]).toBe(40);
});

test('the Clacks shutters walk the snake from their index', async ({ page }) => {
  const delays = await light(page, 'clacks')
    .locator('[aria-hidden="true"]')
    .first()
    .evaluate((clacks) =>
      [...clacks.children].map((s) => parseFloat(getComputedStyle(s).animationDelay)),
    );
  expect(delays.length).toBe(8);
  // Positions 1 2 3 4 8 7 6 5: each step is one --dur-step behind the next on the walk.
  const order = delays.map((d) => d - delays[0]);
  const step = order[1];
  expect(step).toBeGreaterThan(0);
  expect(order.map((d) => Math.round(d / step))).toEqual([0, 1, 2, 3, 7, 6, 5, 4]);
});

test('a .num box holds its width on a plain inline span', async ({ page }) => {
  const span = light(page, 'utilities').locator('span.num').first();
  const ok = await span.evaluate((el) => {
    const style = getComputedStyle(el);
    return style.display === 'inline-block' && style.textAlign === 'end';
  });
  expect(ok).toBe(true);
});

test('the live heading always paints its gradient behind transparent text', async ({ page }) => {
  const heading = light(page, 'section-header').getByRole('heading', { name: 'Casting now' });
  const image = await heading
    .locator('span')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(image).toContain('gradient');
});

test('a stacking Cluster puts its actions full width under 25rem, side by side from it', async ({
  page,
}) => {
  const widths = async (range: string): Promise<number[]> =>
    light(page, 'container-fields')
      .locator(`.frame[data-range="${range}"]`)
      .filter({ has: page.getByRole('button', { name: 'Stop all casts' }) })
      .first()
      .getByRole('button')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  const compact = await widths('compact');
  const medium = await widths('medium');
  expect(compact[0]).toBe(compact[1]);
  expect(medium[0]).toBeLessThan(medium[1]);
});
