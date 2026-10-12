/*
 * The size rule (DESIGN.md F-size), checked on the catalogue: sm is 32 everywhere, every
 * target reaches 44 in a window by its hit area (not its box), hit areas never overlap, and
 * every md instance is listed so an unmarked default flip shows up in review.
 */
import { expect, test, type Page } from '@playwright/test';

interface Hit {
  label: string;
  box: { top: number; bottom: number; left: number; right: number };
  hit: { top: number; bottom: number; left: number; right: number };
}

/**
 * The drawn box and the hit area of every target inside a mock view. A Button, IconButton,
 * Chip ×, summary or segment grows its hit area with ::after; a TextInput and a Select are
 * hit through their native element.
 * @param page - The page
 * @param mock - The mock's data-mock name
 * @returns The targets
 */
async function hits(page: Page, mock: string): Promise<Hit[]> {
  return page.locator(`#size [data-scheme="light"] [data-mock="${mock}"]`).evaluate((root) => {
    const out: Hit[] = [];
    const name = (el: Element): string =>
      el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName;
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const el of root.querySelectorAll('button, a[href], summary, label')) {
      if (!visible(el)) continue;
      const after = getComputedStyle(el, '::after');
      if (after.content === 'none' || after.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      const px = (v: string): number => (v === 'auto' ? 0 : parseFloat(v));
      out.push({
        label: name(el),
        box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        hit: {
          top: r.top + px(after.top),
          bottom: r.bottom - px(after.bottom),
          left: r.left + px(after.left),
          right: r.right - px(after.right),
        },
      });
    }
    for (const el of root.querySelectorAll('input:not([type="range"]), select')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const drawn = (el.closest('[data-size]') ?? el).getBoundingClientRect();
      out.push({
        label: name(el.closest('[data-size]') ?? el),
        box: { top: drawn.top, bottom: drawn.bottom, left: drawn.left, right: drawn.right },
        hit: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      });
    }
    return out;
  });
}

const overlap = (a: Hit['hit'], b: Hit['hit']): boolean =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;

test.beforeEach(async ({ page }) => {
  await page.goto('/?theme=light');
  // The page blurs and scrolls to the top a second after load; measure after that.
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
  await expect(page.locator('#size')).toBeVisible();
});

for (const mock of ['atoms', 'server', 'settings', 'speakers']) {
  test(`window targets in the ${mock} mock reach 44 and never overlap`, async ({ page }) => {
    const targets = await hits(page, mock);
    expect(targets.length).toBeGreaterThan(0);
    const short = targets.filter((t) => t.hit.bottom - t.hit.top < 43.5);
    expect(short.map((t) => `${t.label}: ${(t.hit.bottom - t.hit.top).toFixed(1)}`)).toEqual([]);
    const pairs: string[] = [];
    targets.forEach((a, i) =>
      targets.slice(i + 1).forEach((b) => {
        if (overlap(a.hit, b.hit)) pairs.push(`${a.label} × ${b.label}`);
      }),
    );
    expect(pairs).toEqual([]);
  });
}

test('sm is drawn 32 tall in a window, whatever the hit area', async ({ page }) => {
  const atoms = page.locator('#size [data-scheme="light"] [data-mock="atoms"]');
  for (const name of ['Restart', 'Disconnect']) {
    const box = await atoms.getByRole('button', { name }).boundingBox();
    expect(box?.height).toBeCloseTo(32, 0);
  }
  const field = await atoms.locator('[data-size="sm"]').first().boundingBox();
  expect(field?.height).toBeCloseTo(32, 0);
  const md = await atoms.getByRole('button', { name: 'Stop all casts' }).boundingBox();
  expect(md?.height).toBeCloseTo(44, 0);
});

test('every md instance is listed', async ({ page }, testInfo) => {
  const md = await page.locator('main [data-size="md"]').evaluateAll((els) =>
    els.map((el) => {
      const section = el.closest('section.section')?.id ?? '?';
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
      return `${section}: ${el.tagName.toLowerCase()} "${name}"`;
    }),
  );
  await testInfo.attach('md-instances.txt', { body: [...new Set(md)].join('\n') });
  expect(md.length).toBeGreaterThan(0);
});

test('a press just outside a 32 field lands in its native element', async ({ page }) => {
  const atoms = page.locator('#size [data-scheme="light"] [data-mock="atoms"]');
  const input = atoms.getByRole('textbox', { name: 'Speaker address' });
  await input.scrollIntoViewIfNeeded();
  const drawn = (await atoms.locator('[data-size="sm"]:has(> input)').boundingBox())!;
  await page.mouse.click(drawn.x + drawn.width / 2, drawn.y - 4);
  await expect(input).toBeFocused();
  const select = atoms.getByRole('combobox', { name: 'Speaker head start' });
  const box = (await atoms.locator('[data-size="sm"]:has(> select)').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 4);
  // A customisable select opens its picker and focuses the chosen option inside it.
  const reached = await select.evaluate(
    (el) =>
      el.matches(':open') || el === document.activeElement || el.contains(document.activeElement),
  );
  expect(reached).toBe(true);
  await page.keyboard.press('Escape');
});
