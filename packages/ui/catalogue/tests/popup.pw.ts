/*
 * The popup's frame (DESIGN.md L-popup, L-bar), on the catalogue's PopupShell frames: one
 * scroller, the bar's size published as --overlay-end, the scroll padding that follows it,
 * focus never under the bar (WCAG 2.4.11), and the hairline only while content runs under
 * the bar.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSections } from './open';

const frame = (page: Page, name: string): Locator =>
  page.locator(`#popup-shell [data-scheme="light"] [data-frame="${name}"]`);

test.beforeEach(async ({ page }) => {
  await openSections(page, '/?theme=light');
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

test('the long popup keeps its content centred: the gutter is reserved on both edges', async ({
  page,
}) => {
  // F-shift: classic scrollbars (Windows, and this runner) reserve a gutter; reserved on one
  // edge only, the header and the cards sat off centre by its width.
  const { start, end, gutter, width } = await frame(page, 'long').evaluate((root) => {
    const shell = root.querySelector<HTMLElement>('[data-scroller]')!;
    const outer = shell.getBoundingClientRect();
    const main = shell.querySelector('main')!.getBoundingClientRect();
    const style = getComputedStyle(shell);
    return {
      start: main.left - outer.left,
      end: outer.right - main.right,
      gutter: style.scrollbarGutter,
      width: style.scrollbarWidth,
    };
  });
  expect(gutter).toBe('stable both-edges');
  expect(width).toBe('thin');
  expect(Math.abs(start - end)).toBeLessThan(0.5);
});

test('the header and main are one column: the mark and Settings take the content edges', async ({
  page,
}) => {
  const edges = await frame(page, 'long').evaluate((root) => {
    const shell = root.querySelector<HTMLElement>('[data-scroller]')!;
    const rect = (el: Element | null): DOMRect => el!.getBoundingClientRect();
    const header = shell.querySelector('header')!;
    const main = rect(shell.querySelector('main'));
    return {
      header: [rect(header).left, rect(header).right],
      main: [main.left, main.right],
      mark: rect(header.querySelector('svg')).left,
      settings: rect(header.querySelector('button')).right,
      heading: rect(shell.querySelector('main h2')).left,
    };
  });
  expect(edges.header[0]).toBeCloseTo(edges.main[0], 1);
  expect(edges.header[1]).toBeCloseTo(edges.main[1], 1);
  expect(edges.mark).toBeCloseTo(edges.heading, 0);
  expect(edges.settings).toBeCloseTo(edges.main[1], 0);
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
    const locate = () =>
      page.evaluate(() => {
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
    // Where focus comes to rest: a slow runner can draw the scroll to it a frame late, so a
    // control that still sits under the bar after a second counts as hidden.
    let where = await locate();
    for (let t = 0; where && !where.done && (where.under || where.above) && t < 10; t++) {
      await page.waitForTimeout(100);
      where = await locate();
    }
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

test('an update marks Settings, renames it and moves nothing in the header', async ({ page }) => {
  const section = page.locator('#popup-header [data-scheme="light"]');
  const headers = section.locator('header');
  const plain = headers.nth(0);
  const marked = section
    .getByRole('button', { name: 'Settings, update available', exact: true })
    .locator('xpath=ancestor::header');
  await expect(marked).toHaveCount(1);
  const [a, b] = [(await plain.boundingBox())!, (await marked.boundingBox())!];
  expect(b.height).toBeCloseTo(a.height, 1);
  const button = marked.getByRole('button', { name: 'Settings, update available' });
  const plainButton = plain.getByRole('button', { name: 'Settings', exact: true });
  const [p, m] = [(await plainButton.boundingBox())!, (await button.boundingBox())!];
  expect(m.width).toBeCloseTo(p.width, 1);
  expect(m.x).toBeCloseTo(p.x, 1);
  // The words are in the name and in the Tooltip, not in colour alone.
  const tip = marked.locator('[role="tooltip"]', { hasText: 'Settings, update available' });
  await button.hover();
  // Waited for in the page: polling toBeVisible forces a layout of the whole catalogue each
  // time, which on a slow WebKit runner holds the delay's timer back by seconds.
  await tip.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        if (el.hasAttribute('data-open')) return resolve();
        new MutationObserver((_, observer) => {
          if (!el.hasAttribute('data-open')) return;
          observer.disconnect();
          resolve();
        }).observe(el, { attributes: true, attributeFilter: ['data-open'] });
      }),
  );
  await expect(tip).toBeVisible();
});
