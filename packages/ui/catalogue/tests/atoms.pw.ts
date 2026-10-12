/*
 * Behaviour of the atoms (DESIGN.md §4), on the catalogue page in a real browser: the
 * keyboard, the click-to-set slider (WCAG 2.5.7), the async Button and the Tooltip timing.
 */
import { expect, test, type Page } from '@playwright/test';
import { TOOLTIP_DELAY_MS } from '../../src/tokens';

const light = (page: Page, id: string) => page.locator(`#${id} [data-scheme="light"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('/?theme=light');
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
});

test('a click anywhere on the slider track sets the value, no drag needed', async ({ page }) => {
  const slider = light(page, 'slider').getByRole('slider', { name: 'Kitchen volume' });
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.waitForTimeout(100);
  const value = Number(await slider.inputValue());
  expect(value).toBeGreaterThan(70);
  expect(value).toBeLessThan(90);
});

test('Page Up and Page Down move the slider ten steps', async ({ page }) => {
  const slider = light(page, 'slider').getByRole('slider', { name: 'Kitchen volume' });
  await slider.focus();
  await page.keyboard.press('PageUp');
  await expect(slider).toHaveValue('40');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect(slider).toHaveValue('20');
});

test('an unknown level is read as words and the slider is inert', async ({ page }) => {
  const slider = light(page, 'slider').getByRole('slider', { name: 'Study volume' });
  await expect(slider).toHaveAttribute('aria-valuetext', 'Not known yet');
  await expect(slider).toBeDisabled();
});

test('the switch row is one target: clicking its words toggles it', async ({ page }) => {
  // The name is the name line alone (with its Badge); the description is read once, as the
  // description.
  const sw = light(page, 'switch').getByRole('switch', { name: 'Video sync', exact: true });
  await expect(sw).toHaveAccessibleDescription(
    "Plays the sound early, so a film's lips and words arrive together.",
  );
  await expect(
    light(page, 'switch').getByRole('switch', { name: 'Video sync In step', exact: true }),
  ).toHaveCount(1);
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await light(page, 'switch').getByText('Video sync', { exact: true }).first().click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.press('Space');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
});

test('the segmented control is one tab stop and the arrows choose', async ({ page }) => {
  const group = light(page, 'segmented').getByRole('radiogroup', { name: 'Theme', exact: true });
  const auto = group.getByRole('radio', { name: 'Auto' });
  await auto.focus();
  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio', { name: 'Light' })).toBeChecked();
});

test('Delete on a chip removes it and moves focus to the next one', async ({ page }) => {
  const chips = light(page, 'chip');
  await chips.getByRole('button', { name: 'Remove 192.168.1.47' }).focus();
  await page.keyboard.press('Delete');
  await expect(chips.getByRole('button', { name: 'Remove 192.168.1.47' })).toHaveCount(0);
  await expect(chips.getByRole('button', { name: 'Remove 192.168.1.52' })).toBeFocused();
});

test('a search field clears on Esc and keeps focus', async ({ page }) => {
  const field = light(page, 'text-input').getByRole('searchbox', { name: 'Find a room' }).first();
  await field.focus();
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
});

test('an async Button is busy, then holds its result until the next press', async ({ page }) => {
  const done = light(page, 'button').getByRole('button', { name: 'Connected' });
  await expect(done).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(done).toBeVisible();
  const busy = light(page, 'button').locator('button[aria-busy="true"]').first();
  await expect(busy).toHaveAttribute('aria-disabled', 'true');
});

test('a pressed Button exposes aria-pressed', async ({ page }) => {
  await expect(
    light(page, 'button').getByRole('button', { name: 'Last cast', pressed: true }),
  ).toBeVisible();
});

test('the tooltip shows at once on keyboard focus and Esc hides it', async ({ page }) => {
  const scheme = light(page, 'tooltip');
  const trigger = scheme.getByRole('button', { name: 'Ask again' }).first();
  await trigger.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const tip = scheme.locator('[role="tooltip"]').first();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(scheme.locator('[role="tooltip"]:visible')).toHaveCount(0);
});

test('a pressed Select still shows its value and chevron over the box', async ({ page }) => {
  // The forced press draws the box scaled; the value and the chevron must paint over it,
  // so hiding them changes the picture.
  const select = light(page, 'select').getByRole('combobox', { name: 'Codec, press' });
  await select.scrollIntoViewIfNeeded();
  // A handle, since a hidden select no longer resolves by its role.
  const control = (await select.locator('..').elementHandle())!;
  const shown = await control.screenshot();
  await control.evaluate((el) => {
    for (const part of el.children) (part as HTMLElement).style.visibility = 'hidden';
  });
  const hidden = await control.screenshot();
  expect(shown.equals(hidden)).toBe(false);
});

test('a busy Select keeps focus but takes no choice', async ({ page }) => {
  const select = light(page, 'select').getByRole('combobox', { name: 'Language, busy' });
  await expect(select).toHaveAttribute('aria-busy', 'true');
  await expect(select).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled reads as disabled to Playwright, so the choice is made as the browser
  // makes it: a new value and a change event.
  await select.evaluate((el: HTMLSelectElement) => {
    el.value = 'flac';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(select).toHaveValue('aac');
});

test('an invalid Select says so', async ({ page }) => {
  const select = light(page, 'select').getByRole('combobox', { name: 'Codec, error' });
  await expect(select).toHaveAttribute('aria-invalid', 'true');
});

test('a press in a field box padding focuses the field', async ({ page }) => {
  const field = light(page, 'text-input').getByRole('textbox', { name: 'Set name' }).first();
  await field.scrollIntoViewIfNeeded();
  const box = (await field.locator('..').boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await expect(field).toBeFocused();
});

test('choosing a segment moves nothing: the track keeps its width', async ({ page }) => {
  const group = light(page, 'segmented').getByRole('radiogroup', { name: 'Theme', exact: true });
  const track = group.locator('> span').last();
  const widths: number[] = [];
  for (const name of ['Auto', 'Light', 'Dark']) {
    await group.locator('label').filter({ hasText: name }).click();
    widths.push(Math.round((await track.boundingBox())!.width));
  }
  expect(new Set(widths).size, JSON.stringify(widths)).toBe(1);
});

test('a disabled fieldset draws every control inside it disabled', async ({ page }) => {
  const section = light(page, 'checkbox');
  const inSet = section.locator('fieldset[disabled]').getByText('Study', { exact: true });
  const own = section.locator('.state-grid label').filter({ has: page.locator('input:disabled') });
  const ink = (l: typeof inSet) => l.evaluate((el) => getComputedStyle(el).color);
  expect(await ink(inSet)).toBe(await ink(own.first()));
  await expect(section.locator('fieldset[disabled]').getByRole('switch')).toBeDisabled();
});

test('the Button section draws md: 36 in the popup and 44 on the desktop', async ({ page }) => {
  const section = light(page, 'button');
  const heights = async (density: string) =>
    section
      .locator(`[data-density="${density}"] button[data-size="md"]`)
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  expect(new Set(await heights('popup'))).toEqual(new Set([36]));
  expect(new Set(await heights('desktop'))).toEqual(new Set([44]));
});

test('a link Button reaches the hit floor', async ({ page }) => {
  const link = light(page, 'button').getByRole('link', { name: 'Update available' }).first();
  const hit = await link.evaluate((el) => parseFloat(getComputedStyle(el, '::after').height));
  expect(hit).toBeGreaterThanOrEqual(24);
});

test('a disabled link is dimmed words, with no fill', async ({ page }) => {
  const link = light(page, 'button').locator('a[aria-disabled="true"]').first();
  // Fully transparent, whatever colour space the engine reports it in.
  await expect(link).toHaveCSS('background-color', /(\/ 0\)|, 0\))$/);
});

test('an IconButton exposes pressed and busy', async ({ page }) => {
  const section = light(page, 'icon-button');
  await expect(section.getByRole('button', { name: 'Mute Kitchen', pressed: true })).toHaveCount(1);
  await expect(section.locator('button[aria-busy="true"]').first()).toBeVisible();
});

test('a marked IconButton draws its dot at the corner, unclipped, in every state', async ({
  page,
}) => {
  for (const scheme of ['light', 'dark']) {
    const group = page
      .locator(`#icon-button [data-scheme="${scheme}"]`)
      .getByRole('group', { name: 'Marked' });
    const buttons = group.locator('button');
    await expect(buttons).toHaveCount(5);
    for (const button of await buttons.all()) {
      const dot = button.locator('span[aria-hidden="true"]').last();
      const [box, mark] = [(await button.boundingBox())!, (await dot.boundingBox())!];
      // Inside the button's box, at its block-start, inline-end corner: nothing moves.
      expect(mark.x + mark.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(mark.y).toBeGreaterThanOrEqual(box.y - 0.5);
      expect(mark.x).toBeGreaterThan(box.x + box.width / 2);
      expect(mark.y + mark.height).toBeLessThan(box.y + box.height / 2);
      // Nothing clips it: the shape of focus and press is the button's own radius and corner
      // shape, which clip nothing while the button shows its overflow and has no clip path.
      const clip = await button.evaluate((el) => {
        const style = getComputedStyle(el);
        return { overflow: style.overflow, clipPath: style.clipPath };
      });
      expect(clip).toEqual({ overflow: 'visible', clipPath: 'none' });
      expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(
        /(\/ 0\)|, 0\))$/,
      );
    }
    await expect(
      group.getByRole('button', { name: 'Settings, update available' }).first(),
    ).toBeVisible();
  }
});

test('the tooltip waits for the delay on hover, then stays while hovered', async ({ page }) => {
  const scheme = light(page, 'tooltip');
  const trigger = scheme.getByRole('button', { name: 'Settings' });
  const tip = scheme.locator('[role="tooltip"]', { hasText: 'Settings' });
  // Timed in the page, from the pointer's arrival to the tip's opening, so a slow round trip
  // from the test (a loaded runner) never reads as an early tip.
  await tip.evaluate((el) => {
    const w = window as unknown as { __tipTimes: { enter?: number; open?: number } };
    w.__tipTimes = {};
    el.parentElement!.addEventListener(
      'pointerenter',
      () => (w.__tipTimes.enter ??= performance.now()),
      { once: true },
    );
    new MutationObserver((_, observer) => {
      if (!el.hasAttribute('data-open')) return;
      w.__tipTimes.open = performance.now();
      observer.disconnect();
    }).observe(el, { attributes: true, attributeFilter: ['data-open'] });
  });
  await trigger.hover();
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
  const { enter, open } = await page.evaluate(
    () => (window as unknown as { __tipTimes: { enter: number; open: number } }).__tipTimes,
  );
  expect(open - enter).toBeGreaterThanOrEqual(TOOLTIP_DELAY_MS - 20);
  await tip.hover();
  await page.waitForTimeout(300);
  await expect(tip).toBeVisible();
});

test('a low reading shows the warning glyph as well as the fill', async ({ page }) => {
  const section = light(page, 'meter');
  const low = section.getByRole('meter', { name: 'Study reserve' }).locator('..');
  const fine = section.getByRole('meter', { name: 'Kitchen reserve' }).locator('..');
  await expect(low.locator('svg')).toHaveCount(1);
  await expect(fine.locator('svg')).toHaveCount(0);
});

test('meter names are never cut off, the bars line up and the readings end at one edge', async ({
  page,
}) => {
  const section = light(page, 'meter');
  const rows = await section.locator('.meter-list meter').evaluateAll((els) =>
    els.map((m) => {
      const root = m.parentElement as HTMLElement;
      const [head, bar] = [...root.children] as HTMLElement[];
      const name = head.firstElementChild as HTMLElement;
      const value = head.querySelector('.num') as HTMLElement;
      const b = bar.getBoundingClientRect();
      return {
        cut: name.scrollWidth > name.clientWidth,
        bar: `${Math.round(b.left)}:${Math.round(b.width)}`,
        end: Math.round(value.getBoundingClientRect().right),
      };
    }),
  );
  expect(rows).toHaveLength(3);
  expect(rows.filter((r) => r.cut)).toEqual([]);
  expect(new Set(rows.map((r) => r.bar)).size).toBe(1);
  expect(new Set(rows.map((r) => r.end)).size).toBe(1);
});

test('a low reading does not move the value: the glyph slot is always kept', async ({ page }) => {
  const section = light(page, 'meter');
  const starts = await section
    .locator('.meter-list .num')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(starts).size).toBe(1);
});

test('the step indicator is named by its step', async ({ page }) => {
  await expect(
    light(page, 'step-indicator').getByRole('progressbar', { name: 'Step 2 of 4: Companion' }),
  ).toBeVisible();
});

test('under forced colours a control with no edge at rest draws one', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Only Chromium emulates forced colours.');
  await page.emulateMedia({ forcedColors: 'active' });
  const edge = await light(page, 'icon-button')
    .getByRole('button', { name: 'Settings' })
    .first()
    .evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(edge).toBe('solid');
});

/**
 * The layout box of an element: its offset size.
 * @param el - The element
 * @returns Its width and height
 */
const boxOf = (el: HTMLElement): string => `${el.offsetWidth}x${el.offsetHeight}`;

test('a Button fits each state it shows, and comes back to its idle size', async ({ page }) => {
  // The cycle Button that fails every other run: idle, busy, done, idle, busy, failed, idle.
  // Its height never changes; its width follows its words (A-button, "Changing state").
  // Found by its idle words once, then by place: its words change as it runs.
  const cycles = light(page, 'button').locator('[data-cycle]');
  const texts = await cycles.allTextContents();
  const button = cycles.nth(texts.lastIndexOf('Connect'));
  const idle = await button.evaluate(boxOf);
  const height = idle.split('x')[1];
  const widths: Record<string, string> = {};
  for (const result of ['done', 'failed']) {
    await button.click();
    await expect(button).toHaveAttribute('data-status', 'busy');
    widths.busy = await button.evaluate(boxOf);
    await expect(button).toHaveAttribute('data-status', result);
    widths[result] = await button.evaluate(boxOf);
    await expect(button).not.toHaveAttribute('data-status', /.+/, { timeout: 5000 });
    expect(await button.evaluate(boxOf)).toBe(idle);
  }
  for (const box of Object.values(widths)) expect(box.split('x')[1]).toBe(height);
  // The Clacks and "Working…" are wider than "Connect"; the check and "Done" narrower.
  expect(parseFloat(widths.busy!)).toBeGreaterThan(parseFloat(idle));
  expect(parseFloat(widths.done!)).toBeLessThan(parseFloat(widths.busy!));
});

test('a pressed Button keeps its check slot, so turning it on or off moves nothing', async ({
  page,
}) => {
  const button = light(page, 'button').locator('[data-toggle]');
  const off = await button.evaluate(boxOf);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(await button.evaluate(boxOf)).toBe(off);
});

test('the radio dot is centred in its ring at both densities', async ({ page }) => {
  for (const id of ['radio', 'choice-group']) {
    const offsets = await light(page, id)
      .locator('input[type="radio"]:checked')
      .evaluateAll((els) =>
        els.map((input) => {
          const ring = input.getBoundingClientRect();
          const dot = (input.nextElementSibling as HTMLElement).getBoundingClientRect();
          return [
            dot.width % 2,
            Math.abs(dot.x + dot.width / 2 - (ring.x + ring.width / 2)),
            Math.abs(dot.y + dot.height / 2 - (ring.y + ring.height / 2)),
          ];
        }),
      );
    expect(offsets.length).toBeGreaterThan(0);
    for (const [odd, dx, dy] of offsets) {
      expect(odd).toBe(0);
      expect(dx).toBeLessThan(0.01);
      expect(dy).toBeLessThan(0.01);
    }
  }
});

test('the words beside a column of status dots start at one edge', async ({ page }) => {
  const lists = await light(page, 'status-dot')
    .locator('.dot-lines')
    .evaluateAll((uls) =>
      uls.map((ul) =>
        [...ul.querySelectorAll('li')].map((li) => {
          const slot = (li.firstElementChild as HTMLElement).getBoundingClientRect();
          return `${Math.round(slot.left)}:${Math.round(slot.width)}`;
        }),
      ),
    );
  expect(lists).toHaveLength(2);
  for (const slots of lists) expect(new Set(slots).size).toBe(1);
});

test('a busy badge gives the Clacks the same air at the start and before the words', async ({
  page,
}) => {
  const badge = light(page, 'badge').locator('[class*="_busy_"]').first();
  const air = await badge.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const clacks = (el.firstElementChild as HTMLElement).getBoundingClientRect();
    const words = (el.lastElementChild as HTMLElement).getBoundingClientRect();
    const edge = parseFloat(getComputedStyle(el).borderInlineStartWidth);
    return [Math.round(clacks.left - box.left - edge), Math.round(words.left - clacks.right)];
  });
  expect(air[0]).toBe(air[1]);
});

test('the rail BrandBlock centres its mark on the name, not on the name and version', async ({
  page,
}) => {
  const brand = light(page, 'brand-block').locator('[class*="_rail_"]');
  const [mark, name] = await brand.evaluate((el) =>
    ['[class*="_mark_"]', '[class*="_name_"]'].map((sel) => {
      const r = (el.querySelector(sel) as HTMLElement).getBoundingClientRect();
      return r.top + r.height / 2;
    }),
  );
  expect(Math.abs(mark - name)).toBeLessThan(0.5);
});

test('the Clacks animate only opacity and scale, never a custom property', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const animated = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName !== 'drift')
      .flatMap((a) => (a.effect as KeyframeEffect).getKeyframes())
      .flatMap((frame) =>
        Object.keys(frame).filter(
          (k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k),
        ),
      ),
  );
  expect(animated.length).toBeGreaterThan(0);
  expect([...new Set(animated)].sort()).toEqual(['opacity', 'scale']);
});
