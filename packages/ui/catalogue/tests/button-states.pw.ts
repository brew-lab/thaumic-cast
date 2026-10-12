/*
 * A Button's change of state (DESIGN.md A-button, "Changing state"), on the catalogue's
 * Button states specimen (sections/button-states.tsx). Under automation the demo does not
 * loop: a press starts an action, and "Next step" settles it or returns a result to idle.
 *
 * The motion tests turn reduced motion off and slow --dur-change eight times, then log every
 * animation frame in the page while one change runs: which words show and how much, the
 * Button's box and its neighbour's.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

/** One animation frame of a change, as the page logs it. */
interface Frame {
  /** Every set of words in the Button: the text, its effective opacity and its box. */
  words: { text: string; opacity: number; left: number; right: number }[];
  /** The Button's inline edges. */
  button: { left: number; right: number };
  /** The neighbour's inline edges, if it has one. */
  neighbour: { left: number; right: number } | null;
}

/** A Button's block sizes over a run of changes, as the page logs them. */
interface Blocks {
  /** Where it is: the context, kind, density, size and words. */
  name: string;
  /** The statuses it showed. */
  statuses: string[];
  /** The block size of the Button, its parent and its row at rest. */
  rest: number[];
  /** The largest change from rest of each, in px. */
  worst: number[];
}

/**
 * The slowed --dur-change, in ms: eight times, so a loaded runner's headless WebKit (some
 * six frames a second) still logs more than ten frames of every change.
 */
const D = 8 * 268;

/**
 * A Button in the light panel of the specimen.
 * @param page - The page
 * @param where - A selector inside the specimen that ends at the Button's host
 * @returns The Button
 */
const button = (page: Page, where: string): Locator =>
  page.locator(`#button-states [data-scheme="light"] ${where} button`).first();

/**
 * Runs "Next step": settles every waiting action, or returns every result to idle.
 * @param page - The page
 */
const nextStep = async (page: Page): Promise<void> => {
  await page
    .locator('#button-states [data-scheme="light"] [data-next-step]')
    .evaluate((el: HTMLElement) => el.click());
};

/**
 * Logs every animation frame while `change` runs and for a little longer than the change.
 * @param target - The Button
 * @param change - What starts the change
 * @returns The frames
 */
async function framesOf(target: Locator, change: () => Promise<void>): Promise<Frame[]> {
  await target.evaluate((b: HTMLElement) => {
    const edges = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    };
    const opacity = (el: Element): number => {
      let o = 1;
      for (let e: Element | null = el; e && e !== b.parentElement; e = e.parentElement) {
        o *= Number(getComputedStyle(e).opacity);
      }
      return o;
    };
    let neighbour: Element | null = null;
    for (let p = b.parentElement, d = 0; p && !neighbour && d < 5; p = p.parentElement, d++) {
      neighbour = p.querySelector('[data-neighbour]');
    }
    const frames: Frame[] = [];
    const w = window as unknown as { __frames: Frame[] | null };
    w.__frames = frames;
    const tick = (): void => {
      if (w.__frames !== frames) return;
      frames.push({
        words: [...b.querySelectorAll('[class*="label"]')].map((l) => ({
          text: l.textContent ?? '',
          opacity: opacity(l),
          ...edges(l),
        })),
        button: edges(b),
        neighbour: neighbour ? edges(neighbour) : null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // The first frame is logged before the change starts, so frames[0] is the Button at rest.
  await target
    .page()
    .waitForFunction(
      () => ((window as unknown as { __frames: Frame[] | null }).__frames?.length ?? 0) > 1,
    );
  await change();
  await target.page().waitForTimeout(D * 1.3 + 150);
  return target.page().evaluate(() => {
    const w = window as unknown as { __frames: Frame[] | null };
    const frames = w.__frames ?? [];
    w.__frames = null;
    return frames;
  });
}

/**
 * The frames in which more than one set of words can be seen (above 0.05 opacity).
 * @param frames - The frames
 * @returns Those frames' words
 */
const overlapping = (frames: Frame[]): string[] =>
  frames
    .filter((f) => f.words.filter((w) => w.opacity > 0.05).length > 1)
    .map((f) => f.words.map((w) => `${w.text} ${w.opacity.toFixed(2)}`).join(' / '));

/**
 * Whether the Button's width only ever grows or only ever shrinks.
 * @param frames - The frames
 * @returns True when it moves one way
 */
const monotonic = (frames: Frame[]): boolean => {
  const w = frames.map((f) => f.button.right - f.button.left);
  const up = w.every((x, i) => i === 0 || x >= w[i - 1]! - 0.3);
  const down = w.every((x, i) => i === 0 || x <= w[i - 1]! + 0.3);
  return up || down;
};

/**
 * How far an edge moved over the frames, in px.
 * @param frames - The frames
 * @param pick - Picks the edge from a frame
 * @returns The largest distance from where it started
 */
const travel = (frames: Frame[], pick: (f: Frame) => number): number =>
  Math.max(...frames.map((f) => Math.abs(pick(f) - pick(frames[0]!))));

test.beforeEach(async ({ page }) => {
  await page.goto('/?theme=light');
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
});

test('a Button fits what it shows: long words widen it, short words narrow it', async ({
  page,
}) => {
  const add = button(page, '[data-kind="tonal"] [data-case="Add speaker"]');
  const width = (): Promise<number> => add.evaluate((el: HTMLElement) => el.offsetWidth);
  const idle = await width();
  await add.click();
  await expect(add).toHaveAccessibleName('Knocking politely…');
  const busy = await width();
  await nextStep(page);
  await expect(add).toHaveAccessibleName('Added');
  const done = await width();
  await nextStep(page);
  await expect(add).toHaveAccessibleName('Add speaker');
  expect(busy).toBeGreaterThan(idle);
  expect(done).toBeLessThan(idle);
  expect(await width()).toBe(idle);
});

test('done and failed are said through the Announcer, busy is not, and focus stays', async ({
  page,
}) => {
  const connect = button(page, '[data-kind="filled"] [data-case="Connect"]');
  const status = page.getByRole('status');
  await connect.focus();
  await connect.press('Enter');
  await expect(connect).toHaveAttribute('aria-busy', 'true');
  await expect(status).not.toHaveText('Connecting…');
  await nextStep(page);
  await expect(connect).not.toHaveAttribute('data-status', /.+/);
  await connect.press('Enter');
  await nextStep(page);
  await expect(connect).toHaveAccessibleName('Try again');
  await expect(status).toHaveText('Try again');
  await expect(connect).toBeFocused();
});

test('Stop keeps its words while busy; only the square becomes the Clacks', async ({ page }) => {
  const stop = button(page, '[data-kind="soft danger"] [data-case="Stop"]');
  const width = await stop.evaluate((el: HTMLElement) => el.offsetWidth);
  await stop.click();
  await expect(stop).toHaveAttribute('data-status', 'busy');
  await expect(stop).toHaveAccessibleName('Stop');
  expect(await stop.evaluate((el: HTMLElement) => el.offsetWidth)).toBe(width);
});

test('under reduced motion a change is instant: no frame in between', async ({ page }) => {
  const add = button(page, '[data-kind="filled"] [data-case="Add speaker"]');
  const frames = await framesOf(add, () => add.click());
  const widths = new Set(frames.map((f) => Math.round(f.button.right - f.button.left)));
  expect(widths.size, JSON.stringify([...widths])).toBeLessThanOrEqual(2);
  expect(frames.every((f) => f.words.length === 1)).toBe(true);
});

test('a busy Badge is as tall as every other tone, and so is its line', async ({ page }) => {
  const lines = page.locator('#button-states [data-scheme="light"] [data-tone-case]');
  const sizes = await lines.evaluateAll((all: HTMLElement[]) =>
    all.map((line) => ({
      tone: line.getAttribute('data-tone-case'),
      badge: line.firstElementChild?.getBoundingClientRect().height ?? 0,
      line: line.getBoundingClientRect().height,
    })),
  );
  expect(sizes.map((s) => s.tone)).toContain('busy');
  for (const s of sizes) {
    expect(Math.abs(s.badge - sizes[0]!.badge), s.tone ?? '').toBeLessThanOrEqual(0.01);
    expect(Math.abs(s.line - sizes[0]!.line), s.tone ?? '').toBeLessThanOrEqual(0.01);
  }
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  // Three changes per test at the slowed --dur-change: some 25 s on the CI WebKit runner, more
  // as the catalogue grows, so past the 30 s default.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await page.addStyleTag({ content: `.states { --dur-change: ${D}ms; }` });
  });

  for (const kind of ['filled', 'tonal', 'outline', 'quiet', 'danger', 'soft danger']) {
    test(`${kind}: the words never overlap and the width moves one way`, async ({ page }) => {
      const add = button(page, `[data-kind="${kind}"] [data-case="Add speaker"]`);
      for (const step of [() => add.click(), () => nextStep(page), () => nextStep(page)]) {
        const frames = await framesOf(add, step);
        expect(frames.length).toBeGreaterThan(10);
        // The change ran: the old words were still drawn while the new ones waited.
        expect(frames.some((f) => f.words.length === 2)).toBe(true);
        expect(overlapping(frames)).toEqual([]);
        expect(monotonic(frames)).toBe(true);
        // A free end: the start edge stays.
        expect(travel(frames, (f) => f.button.left)).toBeLessThan(0.5);
      }
    });
  }

  test('a change never changes the block size of a Button, its parent or its row', async ({
    page,
  }) => {
    // Six changes, each waited out at the slowed --dur-change.
    test.slow();
    const hosts = page.locator('#button-states [data-scheme="light"] .states-host > button');
    // Every kind in both sizes and densities, with and without a glyph, plus every context.
    expect(
      await page
        .locator('#button-states [data-scheme="light"] [data-context="blocks"] button')
        .count(),
    ).toBe(7 * 4 * 2);
    await hosts.first().evaluate(() => {
      const box = (el: Element | null): Element | null => {
        let p = el?.parentElement ?? null;
        while (p && getComputedStyle(p).display === 'contents') p = p.parentElement;
        return p;
      };
      const all = [
        ...document.querySelectorAll('#button-states [data-scheme="light"] .states-host > button'),
      ].map((b) => {
        const parent = box(b);
        return { b, parent, row: box(parent) };
      });
      const w = window as unknown as { __blocks: Blocks[] | null };
      const log: Blocks[] = all.map(({ b }) => ({
        name: [
          b.closest('[data-context]')?.getAttribute('data-context'),
          b.closest('[data-kind]')?.getAttribute('data-kind'),
          b.closest('[data-density]')?.getAttribute('data-density'),
          b.closest('[data-size]')?.getAttribute('data-size'),
          b.textContent,
        ].join(' / '),
        statuses: [],
        rest: [],
        worst: [0, 0, 0],
      }));
      w.__blocks = log;
      const tick = (): void => {
        if (w.__blocks !== log) return;
        all.forEach(({ b, parent, row }, i) => {
          const h = [b, parent, row].map((el) => el?.getBoundingClientRect().height ?? 0);
          const entry = log[i]!;
          if (!entry.rest.length) entry.rest = h;
          h.forEach((x, k) => {
            const d = Math.abs(x - entry.rest[k]!);
            if (d > entry.worst[k]!) entry.worst[k] = d;
          });
          const status = b.getAttribute('data-status') ?? 'idle';
          if (!entry.statuses.includes(status)) entry.statuses.push(status);
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const settle = (): Promise<void> => page.waitForTimeout(D * 1.3 + 150);
    const pressIdle = async (): Promise<void> => {
      await hosts.evaluateAll((all: HTMLElement[]) => {
        for (const b of all) if (!b.hasAttribute('data-status')) b.click();
      });
      await settle();
    };
    // Idle to busy to done to idle, then idle to busy to failed to idle.
    for (const step of [pressIdle, nextStep, nextStep, pressIdle, nextStep, nextStep]) {
      await step(page);
      await settle();
    }
    const blocks = await page.evaluate(() => {
      const w = window as unknown as { __blocks: Blocks[] | null };
      const log = w.__blocks ?? [];
      w.__blocks = null;
      return log;
    });
    const grid = blocks.filter((b) => b.name.startsWith('blocks'));
    expect(grid.every((b) => ['busy', 'done', 'failed'].every((s) => b.statuses.includes(s)))).toBe(
      true,
    );
    const moved = blocks
      .filter((b) => b.worst.some((d) => d > 0.01))
      .map((b) => `${b.name}: ${b.worst.map((d) => d.toFixed(2)).join(' / ')}`);
    expect(moved).toEqual([]);
  });

  test('in the row-end case, Stop all casts moves nothing: not its words, not its neighbour', async ({
    page,
  }) => {
    const stop = button(page, '[data-context="row"] [data-case="Stop all casts"]');
    for (const step of [() => stop.click(), () => nextStep(page)]) {
      const frames = await framesOf(stop, step);
      expect(frames.every((f) => f.neighbour)).toBe(true);
      expect(travel(frames, (f) => f.neighbour!.left)).toBe(0);
      expect(travel(frames, (f) => f.button.right - f.button.left)).toBe(0);
      expect(travel(frames, (f) => f.words[0]!.left)).toBe(0);
    }
  });

  test('end-aligned, a Button grows towards the start and the old words hold still', async ({
    page,
  }) => {
    const restart = button(page, '[data-context="settings"] [data-case="Restart Thaumic Cast"]');
    for (const step of [() => restart.click(), () => nextStep(page)]) {
      const frames = await framesOf(restart, step);
      expect(travel(frames, (f) => f.button.right)).toBeLessThan(0.5);
      expect(travel(frames, (f) => f.button.left)).toBeGreaterThan(20);
      expect(overlapping(frames)).toEqual([]);
      expect(monotonic(frames)).toBe(true);
      // The words it leaves stay where they were until they have gone.
      const first = frames[0]!.words[0]!;
      const leaving = frames.flatMap((f) => f.words.filter((w) => w.text === first.text));
      expect(Math.max(...leaving.map((w) => Math.abs(w.left - first.left)))).toBeLessThan(0.5);
    }
  });

  test('full width, the width holds and the words take turns', async ({ page }) => {
    const cast = button(page, '[data-context="full"] [data-case="Cast to 3 rooms"]');
    for (const step of [() => cast.click(), () => nextStep(page), () => nextStep(page)]) {
      const frames = await framesOf(cast, step);
      expect(travel(frames, (f) => f.button.right - f.button.left)).toBe(0);
      expect(overlapping(frames)).toEqual([]);
    }
  });
});
