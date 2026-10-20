/*
 * The shape grammar (DESIGN.md F-grammar, T-state "Shape per state") on the live controls of
 * #press-states: hover is colour and leaves the shape round, focus-visible bevels, and a
 * press morphs to the bevel and back, held for the morph (utils/press.ts) so a quick click,
 * Enter or Space shows it in full. Nothing changes size, and under reduced motion the shape
 * swaps at once. Where corner-shape is missing (WebKit) nothing reshapes at all.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSections } from './open';

const section = (page: Page): Locator =>
  page.locator('#press-states [data-scheme="light"] [data-live]');

/** A live control: how to find what is pressed, and the part that takes the shape. */
interface Control {
  name: string;
  /** The element marked data-press. */
  find: (page: Page) => Locator;
  /** The part that reshapes, from the pressed element. */
  shaped?: string;
  /** What takes focus, from the pressed element (a checkbox's or a segment's input). */
  focus?: string;
  /** The keys that press it. */
  keys: ('Enter' | 'Space')[];
}

const KINDS = ['filled', 'filled-danger', 'tonal', 'tonal-danger', 'outline', 'quiet', 'link'];

const CONTROLS: Control[] = [
  ...KINDS.map(
    (kind): Control => ({
      name: `button-${kind}`,
      find: (page) => section(page).locator(`button[data-kind="${kind}"]`).first(),
      keys: ['Enter', 'Space'],
    }),
  ),
  ...['icon-sm', 'icon-md', 'icon-tonal'].map(
    (kind): Control => ({
      name: kind,
      find: (page) => section(page).locator(`button[data-kind="${kind}"]`),
      keys: ['Enter', 'Space'],
    }),
  ),
  {
    name: 'chip-remove',
    find: (page) => section(page).getByRole('button', { name: 'Remove 192.168.1.47' }),
    keys: ['Enter', 'Space'],
  },
  {
    name: 'switch',
    find: (page) => section(page).getByRole('switch', { name: 'Video sync', exact: true }),
    shaped: '[class*="thumb"]',
    keys: ['Enter', 'Space'],
  },
  {
    name: 'checkbox',
    find: (page) => section(page).locator('label[data-press]').filter({ hasText: 'Kitchen' }),
    shaped: 'input',
    focus: 'input',
    keys: ['Space'],
  },
  {
    name: 'checkbox-row',
    find: (page) => section(page).locator('label[data-press]').filter({ hasText: 'Kitchen' }),
    focus: 'input',
    keys: ['Space'],
  },
  {
    name: 'radio-option',
    find: (page) => section(page).locator('label[data-press]').filter({ hasText: 'Low' }),
    focus: 'input',
    keys: ['Space'],
  },
  {
    name: 'segment',
    find: (page) => section(page).locator('label[data-press]').filter({ hasText: 'Light' }),
    focus: 'input',
    keys: ['Space'],
  },
  {
    name: 'button-link-href',
    find: (page) => section(page).locator('a[data-kind="link-href"]'),
    keys: ['Enter'],
  },
  {
    name: 'nav-item',
    find: (page) => section(page).locator('a[data-press]:not([data-kind])'),
    keys: ['Enter'],
  },
  {
    name: 'disclosure',
    find: (page) => section(page).locator('summary[data-press]'),
    keys: ['Enter', 'Space'],
  },
];

/** The shape of a corner, as the engine computes it now. */
interface Shape {
  /** The radius, in px. */
  radius: number;
  /**
   * The corner's superellipse exponent: 1 round, 0 bevel, between them mid-morph; null
   * where corner-shape is missing. The engines compute a keyword as superellipse().
   */
  curve: number | null;
}

declare global {
  interface Window {
    /** Reads a part's start-start corner (installed by READ_SHAPE). */
    readShape: (part: Element) => Shape;
  }
}

/** The live controls that go busy from their own press (§11 call 78). */
const ASYNC: Control[] = [
  {
    name: 'button-async',
    find: (page) => section(page).locator('button[data-kind="async"]'),
    keys: ['Enter', 'Space'],
  },
  {
    name: 'button-async-filled',
    find: (page) => section(page).locator('button[data-kind="async-filled"]'),
    keys: ['Enter', 'Space'],
  },
  {
    name: 'icon-async',
    find: (page) => section(page).locator('button[data-kind="icon-async"]'),
    keys: ['Enter', 'Space'],
  },
  {
    name: 'switch-async',
    find: (page) => section(page).getByRole('switch', { name: 'Launch at login' }),
    shaped: '[class*="thumb"]',
    keys: ['Enter', 'Space'],
  },
];

/** Installs window.readShape in the page, so a frame sampler in the page can use it too. */
const READ_SHAPE = `window.readShape = (part) => {
  const cs = getComputedStyle(part);
  const corner = cs.getPropertyValue('corner-top-left-shape').trim();
  const named = { round: 1, bevel: 0 };
  const match = /superellipse\\(([^)]+)\\)/.exec(corner);
  const curve = corner === '' ? null : corner in named ? named[corner] : Number(match?.[1]);
  return { radius: parseFloat(cs.borderTopLeftRadius), curve };
};`;

/**
 * Reads the start-start corner of the control's shaped part.
 * @param control - The control
 * @param el - The pressed element
 * @returns Its shape
 */
const shapeOf = (control: Control, el: Locator): Promise<Shape> =>
  el.evaluate(
    (node, sel) => window.readShape(sel ? node.querySelector(sel)! : node),
    control.shaped ?? null,
  );

/**
 * Reads the control's shape at rest: round, once any morph left by the control before it
 * (the same row, on a slow runner) has ended.
 * @param control - The control
 * @param el - The pressed element
 * @returns Its shape at rest
 */
async function restOf(control: Control, el: Locator): Promise<Shape> {
  await expect
    .poll(async () => (await shapeOf(control, el)).curve ?? 1, {
      message: `${control.name} at rest`,
    })
    .toBe(1);
  return shapeOf(control, el);
}

/**
 * Whether the engine draws corner shapes (Chromium does, WebKit does not).
 * @param page - The page
 * @returns True where corner-shape is supported
 */
const hasCornerShape = (page: Page): Promise<boolean> =>
  page.evaluate(() => CSS.supports('corner-shape', 'bevel'));

/**
 * Leaves the pointer and the focus away from every control, and waits for any morph.
 * @param page - The page
 */
async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(350);
}

/** One frame of a control during a click: its shape, and whether it was busy. */
interface Sample extends Shape {
  /** Whether the control was busy (aria-busy) in this frame. */
  busy: boolean;
}

/**
 * Clicks a control for 80 ms and samples its shaped part on every frame, in the page, from
 * before the press until 900 ms after it, and on until a frame draws the shape at rest (a
 * loaded runner draws few frames, so the way back can end after the 900 ms).
 * @param page - The page
 * @param control - The control
 * @param el - The pressed element
 * @param rest - The shape at rest
 * @returns One sample per frame
 */
async function sampleClick(
  page: Page,
  control: Control,
  el: Locator,
  rest: Shape,
): Promise<Sample[]> {
  await el.evaluate((node, sel) => {
    const part = sel ? node.querySelector(sel)! : node;
    const w = window as unknown as { samples: Sample[]; sampling: boolean };
    w.samples = [];
    w.sampling = true;
    const tick = (): void => {
      w.samples.push({ ...window.readShape(part), busy: node.matches('[aria-busy="true"]') });
      if (w.sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, control.shaped ?? null);
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(900);
  await expect
    .poll(
      () =>
        page.evaluate(({ radius, curve }) => {
          const last = (window as unknown as { samples: Sample[] }).samples.at(-1);
          return last?.radius === radius && last.curve === curve;
        }, rest),
      { message: `${control.name} came back`, timeout: 5000 },
    )
    .toBe(true);
  return page.evaluate(() => {
    const w = window as unknown as { samples: Sample[]; sampling: boolean };
    w.sampling = false;
    return w.samples;
  });
}

/**
 * Reads the bevel a control's forced press draws: the end state of its morph.
 * @param control - The control
 * @param el - The pressed element
 * @returns The bevel
 */
async function forcedBevel(control: Control, el: Locator): Promise<Shape> {
  // The chip draws its ×'s states from the chip's own data-force.
  // Headless WebKit draws few frames, so the morph is waited out rather than timed.
  const curve = async (): Promise<number | null> => (await shapeOf(control, el)).curve;
  await el.evaluate((n) => (n.closest('[data-chip]') ?? n).setAttribute('data-force', 'press'));
  await expect.poll(curve, { message: control.name }).toBe(0);
  const bevel = await shapeOf(control, el);
  await el.evaluate((n) => (n.closest('[data-chip]') ?? n).removeAttribute('data-force'));
  await expect.poll(curve, { message: control.name }).toBe(1);
  return bevel;
}

test.beforeEach(async ({ page }) => {
  // Each test walks every live control in turn, with waits for the morph.
  test.slow();
  await page.addInitScript({ content: READ_SHAPE });
  await openSections(page, '/?theme=light#press-states');
});

test('hover is colour only: the shape stays round', async ({ page }) => {
  for (const control of CONTROLS) {
    const el = control.find(page);
    await el.scrollIntoViewIfNeeded();
    await settle(page);
    const rest = await shapeOf(control, el);
    await el.hover();
    await page.waitForTimeout(50);
    expect(await shapeOf(control, el), control.name).toEqual(rest);
    if (rest.curve !== null) expect(rest.curve, control.name).toBe(1);
  }
});

test('focus-visible takes the bevel and the ring', async ({ page }) => {
  const shapes = await hasCornerShape(page);
  for (const control of CONTROLS) {
    const el = control.find(page);
    await el.scrollIntoViewIfNeeded();
    await settle(page);
    const rest = await shapeOf(control, el);
    const target = control.focus ? el.locator(control.focus) : el;
    await target.focus();
    expect(await target.evaluate((n) => n.matches(':focus-visible')), control.name).toBe(true);
    const focused = await shapeOf(control, el);
    if (shapes) {
      expect(focused.curve, control.name).toBe(0);
    } else {
      expect(focused, control.name).toEqual(rest);
    }
  }
});

test('a quick click reaches the full bevel before it returns', async ({ page }) => {
  test.skip(!(await hasCornerShape(page)), 'Nothing reshapes without corner-shape.');
  // Every live control, each a forced press, a click and its way back: on the CI runner's
  // headless WebKit (some six frames a second) that walk outlasts test.slow()'s 90 s.
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const control of CONTROLS) {
    const el = control.find(page);
    await el.scrollIntoViewIfNeeded();
    await settle(page);
    const rest = await restOf(control, el);
    // The forced press of the same control is the bevel's end state; read it from the rule.
    const bevel = await forcedBevel(control, el);
    expect(bevel.curve, control.name).toBe(0);

    const samples = await sampleClick(page, control, el, rest);
    const full = samples.findIndex(
      (s) => s.curve === 0 && Math.abs(s.radius - bevel.radius) < 0.01,
    );
    expect(full, `${control.name} reached the bevel: ${JSON.stringify(samples)}`).toBeGreaterThan(
      -1,
    );
    expect(samples.at(-1), `${control.name} came back`).toEqual({ ...rest, busy: false });
    await page.keyboard.press('Escape');
  }
});

test('a quick click that makes a control busy still plays the whole morph', async ({ page }) => {
  test.skip(!(await hasCornerShape(page)), 'Nothing reshapes without corner-shape.');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const control of ASYNC) {
    const el = control.find(page);
    await el.scrollIntoViewIfNeeded();
    await settle(page);
    await expect(el).not.toHaveAttribute('aria-busy', 'true');
    const rest = await restOf(control, el);
    const bevel = await forcedBevel(control, el);
    const samples = await sampleClick(page, control, el, rest);
    const log = `${control.name}: ${JSON.stringify(samples)}`;
    // It went busy during the click, reached the full bevel, and came back round, busy.
    expect(
      samples.some((s) => s.busy),
      log,
    ).toBe(true);
    const full = samples.findIndex(
      (s) => s.curve === 0 && Math.abs(s.radius - bevel.radius) < 0.01,
    );
    expect(full, log).toBeGreaterThan(-1);
    // Once it starts back it never turns again: one morph in and one out.
    const curves = samples.map((s) => s.curve ?? 1);
    const back = curves.findIndex((c, i) => i > full && c > 0);
    if (back > -1) {
      for (let i = back + 1; i < curves.length; i++) {
        expect(curves[i]!, log).toBeGreaterThanOrEqual(curves[i - 1]!);
      }
    }
    expect(samples.at(-1), log).toEqual({ ...rest, busy: true });

    // A press while it is busy shows nothing: no hold, and the shape stays round. The
    // click's own hold ends first (headless WebKit draws few frames, so it is waited out).
    // A loaded runner can outlast the click's busy spell, so a fresh one is started with a
    // click from script (no pointer, so no hold) and the press lands well inside it.
    await expect(el).not.toHaveAttribute('data-pressing');
    await expect(el).not.toHaveAttribute('aria-busy', 'true', { timeout: 5000 });
    await el.evaluate((n: HTMLElement) => n.click());
    await expect(el).toHaveAttribute('aria-busy', 'true');
    expect(await shapeOf(control, el), control.name).toEqual(rest);
    const box = (await el.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(250);
    expect(await el.getAttribute('data-pressing'), control.name).toBeNull();
    expect(await shapeOf(control, el), control.name).toEqual(rest);
    await page.mouse.move(1, 1);
    await page.mouse.up();
    await expect(el).not.toHaveAttribute('aria-busy', 'true', { timeout: 5000 });
  }
});

test('Enter and Space each hold a press for the morph', async ({ page }) => {
  // Every control, both keys: past 90 s on the CI WebKit runner.
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const control of CONTROLS) {
    const el = control.find(page);
    await el.scrollIntoViewIfNeeded();
    for (const key of ['Enter', 'Space'] as const) {
      await settle(page);
      const target = control.focus ? el.locator(control.focus) : el;
      await target.focus();
      await page.keyboard.press(key);
      if (control.keys.includes(key)) {
        await expect(el, `${control.name} ${key}`).toHaveAttribute('data-pressing', '');
        await expect(el, `${control.name} ${key} lets go`).not.toHaveAttribute('data-pressing');
      } else {
        expect(await el.getAttribute('data-pressing'), `${control.name} ${key}`).toBeNull();
      }
      await page.keyboard.press('Escape');
    }
  }
});

test('a press changes no size: nothing scales or shrinks', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  /**
   * Every box in the control and the scale and transform of each part and its pseudos. The
   * Switch's thumb stretches inside the track by design (A-switch), so its width is left out.
   * @param el - The control
   * @returns One line per box and per part's scale and transform
   */
  const snapshot = (el: Locator): Promise<string[]> =>
    el.evaluate((node) => {
      const out: string[] = [];
      const parts = [node, ...node.querySelectorAll('*')] as HTMLElement[];
      for (const part of parts) {
        const r = part.getBoundingClientRect();
        const thumb = /thumb/.test(part.getAttribute('class') ?? '');
        out.push(thumb ? `${r.height.toFixed(2)}` : `${r.width.toFixed(2)}x${r.height.toFixed(2)}`);
        for (const pseudo of [null, '::before', '::after']) {
          const cs = getComputedStyle(part, pseudo);
          out.push(`${cs.scale}|${cs.transform}`);
        }
      }
      return out;
    });
  for (const control of CONTROLS) {
    const el = control.find(page);
    await el.scrollIntoViewIfNeeded();
    await settle(page);
    const rest = await snapshot(el);
    const box = (await el.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    expect(await snapshot(el), control.name).toEqual(rest);
    // Let go off the control, so the press is not a click.
    await page.mouse.move(1, 1);
    await page.mouse.up();
  }
});

test('under reduced motion the shape swaps at once and the hold ends with the release', async ({
  page,
}) => {
  // The config runs every test with reducedMotion: 'reduce'.
  const shapes = await hasCornerShape(page);
  const control = CONTROLS[0]!;
  const el = control.find(page);
  await el.scrollIntoViewIfNeeded();
  await settle(page);
  const rest = await shapeOf(control, el);
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const during = await shapeOf(control, el);
  if (shapes) expect(during.curve).toBe(0);
  else expect(during).toEqual(rest);
  await page.waitForTimeout(80);
  await page.mouse.up();
  expect(await el.getAttribute('data-pressing')).toBeNull();
  await page.mouse.move(1, 1);
  expect(await shapeOf(control, el)).toEqual(rest);
});

test('a disabled or busy control takes no press', async ({ page }) => {
  const disabled = page.locator('#button [data-scheme="light"] button:disabled').first();
  const busy = page.locator('#icon-button [data-scheme="light"] button[aria-busy="true"]').first();
  for (const el of [disabled, busy]) {
    await el.scrollIntoViewIfNeeded();
    const box = (await el.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(await el.getAttribute('data-pressing')).toBeNull();
    await page.mouse.up();
  }
});

test('under reduced motion a tap inside one frame is still drawn', async ({ page }) => {
  // The config runs every test with reducedMotion: 'reduce'.
  const el = CONTROLS[0]!.find(page);
  await el.scrollIntoViewIfNeeded();
  await settle(page);
  // Press and let go in one task, as a near-instant tap can; count the frames it is held.
  const frames = await el.evaluate(
    (node) =>
      new Promise<number>((resolve) => {
        const init = { bubbles: true, isPrimary: true, button: 0, pointerId: 1 };
        node.dispatchEvent(new PointerEvent('pointerdown', init));
        node.dispatchEvent(new PointerEvent('pointerup', init));
        let held = 0;
        const tick = (): void => {
          if (!node.hasAttribute('data-pressing')) resolve(held);
          else if (held++ < 30) requestAnimationFrame(tick);
          else resolve(-1);
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(frames).toBeGreaterThan(0);
  expect(frames).toBeLessThan(5);
});

test('a Select list opened by a pointer keeps its chosen option calm; a key shows focus', async ({
  page,
}) => {
  test.skip(
    !(await page.evaluate(
      () => CSS.supports('appearance', 'base-select') && CSS.supports('corner-shape', 'bevel'),
    )),
    'Only the customisable list draws option shapes.',
  );
  const select = page.locator('#select [data-scheme="light"] select').first();
  await select.scrollIntoViewIfNeeded();
  const chosen = select.locator('option:checked');
  /**
   * The chosen option's corner and ring.
   * @returns Its curve and box shadow
   */
  const look = (): Promise<{ curve: number | null; ring: string }> =>
    chosen.evaluate((n) => ({
      curve: window.readShape(n).curve,
      ring: getComputedStyle(n).boxShadow,
    }));

  // A mouse open: Chromium focuses the chosen option, but it stays calm: round, no ring.
  await select.click();
  await page.waitForTimeout(350);
  expect(await look()).toEqual({ curve: 1, ring: 'none' });
  // A key after it shows the focus: the focused option takes the bevel and the ring.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(350);
  const focused = page
    .locator('#select [data-scheme="light"] select')
    .first()
    .locator('option:focus');
  expect(await focused.evaluate((n) => window.readShape(n).curve)).toBe(0);
  // Close it by a press outside (light dismiss), away from the Select.
  await page.mouse.click(5, 5);
  await expect.poll(() => select.evaluate((n) => n.matches(':open'))).toBe(false);

  // A keyboard open: the chosen option is focused, beveled and ringed.
  await select.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(350);
  const keyed = await look();
  expect(keyed.curve).toBe(0);
  expect(keyed.ring).not.toBe('none');
  await page.mouse.click(5, 5);
});
