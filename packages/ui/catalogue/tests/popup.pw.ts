/*
 * The popup's frame (DESIGN.md L-popup, L-bar), on the catalogue's PopupShell frames: one
 * scroller, the bar's size published as --overlay-end, the scroll padding that follows it,
 * focus never under the bar (WCAG 2.4.11), and the hairline only while content runs under
 * the bar.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const frame = (page: Page, name: string): Locator =>
  page.locator(`#popup-shell [data-scheme="light"] [data-frame="${name}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('/?theme=light');
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
  await page.locator('#popup-shell').scrollIntoViewIfNeeded();
});

for (const name of ['idle', 'long']) {
  test(`the ${name} popup has one scroller, and no box inside scrolls`, async ({ page }) => {
    const scrollers = await frame(page, name).evaluate((root) =>
      [...root.querySelectorAll('*')]
        .filter((el) => {
          const style = getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        })
        .map((el) => (el.hasAttribute('data-scroller') ? 'shell' : el.className)),
    );
    expect(scrollers).toEqual(name === 'long' ? ['shell'] : []);
  });

  test(`the ${name} popup pads its end by the bar plus 8 px`, async ({ page }) => {
    const { bar, overlay, padding } = await frame(page, name).evaluate((root) => {
      const shell = root.querySelector<HTMLElement>('[data-scroller]')!;
      const sticky = root.querySelector<HTMLElement>('[data-sticky-bar]')!;
      return {
        bar: sticky.getBoundingClientRect().height,
        overlay: parseFloat(shell.style.getPropertyValue('--overlay-end')),
        padding: parseFloat(getComputedStyle(shell).scrollPaddingBlockEnd),
      };
    });
    expect(Math.abs(overlay - bar)).toBeLessThan(0.5);
    expect(Math.abs(padding - (bar + 8))).toBeLessThan(0.5);
  });
}

test('the popup is 22rem wide and at most 37.5rem tall', async ({ page }) => {
  const box = await frame(page, 'long').locator('[data-scroller]').boundingBox();
  expect(box?.width).toBeCloseTo(352, 0);
  expect(box?.height).toBeLessThanOrEqual(600.5);
});

test('the bar follows a Toast arriving and leaving', async ({ page }) => {
  const shell = frame(page, 'long').locator('[data-scroller]');
  const overlay = (): Promise<number> =>
    shell.evaluate((el) => parseFloat(el.style.getPropertyValue('--overlay-end')));
  const before = await overlay();
  await frame(page, 'long').getByRole('button', { name: 'Undo: Patio left this cast' }).click();
  await expect.poll(overlay).toBeLessThan(before - 20);
  const bar = await frame(page, 'long').locator('[data-sticky-bar]').boundingBox();
  expect(Math.abs((await overlay()) - (bar?.height ?? 0))).toBeLessThan(0.5);
});

test('focus moves on to the next control when the focused one goes away (2.4.3)', async ({
  page,
}) => {
  const undo = frame(page, 'long').getByRole('button', { name: 'Undo: Patio left this cast' });
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(frame(page, 'long').getByRole('button', { name: 'Cast to 2 rooms' })).toBeFocused();
});

test('tabbing through the long popup never leaves focus under the bar (2.4.11)', async ({
  page,
}) => {
  const root = frame(page, 'long');
  const shell = root.locator('[data-scroller]');
  await shell.evaluate((el) => (el.scrollTop = 0));
  await root.getByRole('button', { name: 'Settings' }).focus();
  const hidden: string[] = [];
  let visited = 0;
  let reachedBar = false;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const shell = el?.closest<HTMLElement>('[data-scroller]');
      if (!el || !shell) return null;
      const bar = shell.querySelector<HTMLElement>('[data-sticky-bar]')!;
      if (bar.contains(el) || !shell.contains(el)) return { done: bar.contains(el) };
      const r = el.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const s = shell.getBoundingClientRect();
      return {
        done: false,
        name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName,
        under: r.bottom > b.top + 0.5,
        above: r.top < s.top - 0.5,
      };
    });
    if (!where || where.done) {
      reachedBar = Boolean(where?.done);
      break;
    }
    visited++;
    if (where.under || where.above) hidden.push(where.name ?? '?');
  }
  expect(hidden).toEqual([]);
  expect(visited).toBeGreaterThan(10);
  expect(reachedBar).toBe(true);
});

test('the hairline shows only while content runs under the bar, where scroll-state exists', async ({
  page,
}) => {
  const supported = await page.evaluate(() => CSS.supports('container-type', 'scroll-state'));
  const rule = async (name: string): Promise<string> =>
    frame(page, name)
      .locator('[data-sticky-bar] > :first-child')
      .evaluate((el) => getComputedStyle(el).visibility);
  if (!supported) {
    // The floor (all WebKit, Chrome 125 to 132): always shown.
    expect(await rule('idle')).toBe('visible');
    expect(await rule('long')).toBe('visible');
    return;
  }
  expect(await rule('idle')).toBe('hidden');
  expect(await rule('long')).toBe('visible');
  const shell = frame(page, 'long').locator('[data-scroller]');
  await shell.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => rule('long')).toBe('hidden');
});

test('md in the popup is only the owned sizes: Cast, Add, the sets and the list folds', async ({
  page,
}) => {
  const ids = [
    'room-row-pick',
    'room-row-cast',
    'media-header',
    'group-volume',
    'video-sync',
    'popup-header',
    'room-picker',
    'cast-bar',
    'notice-slot',
    'tab-card',
    'cast-tile',
    'popup-shell',
  ];
  const md = new Set<string>();
  for (const id of ids) {
    const names = await page
      .locator(`#${id} [data-scheme="light"] [data-size="md"]`)
      .evaluateAll((els) =>
        // IconButton's md is its own 32 box, not the F-size md: icon-only targets are left out.
        els
          .filter((el) => el.textContent?.trim())
          .map((el) => {
            const target = el.matches('details') ? el.querySelector('summary')! : el;
            const label = target.querySelector('[class*="label"]')?.textContent ?? '';
            return (el.getAttribute('aria-label') ?? (label || target.textContent) ?? '').trim();
          }),
      );
    for (const n of names) md.add(n.replace(/\d+/g, 'N'));
  }
  const allowed = [
    /^Cast( to N rooms?)?$/,
    /^Starting…$/,
    /^Add N rooms?( to .+)?$/,
    /^Cancel$/,
    /^Add a room$/,
    /^N rooms$/,
    /^Rooms$/,
    /^(Last cast|Evenings|Everywhere)/,
  ];
  expect([...md].filter((n) => !allowed.some((re) => re.test(n)))).toEqual([]);
  expect([...md].some((n) => /^Cast to/.test(n))).toBe(true);
});
