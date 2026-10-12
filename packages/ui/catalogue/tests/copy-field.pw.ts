/*
 * CopyField's action morphs like any Button (DESIGN.md M-copy, P-copy, A-button "Changing
 * state"; §11 call 80). Every CopyField on the catalogue page (beside a value, alone on a
 * card, a long wrapping value, both densities, compact, medium and wide containers) is
 * pressed at once with a faked clipboard, and every animation frame logs the Button, its
 * words, the value, the row and the field, through Copy, Copied and back after
 * COPY_CONFIRM_MS, and through a refusal.
 */
import { expect, test, type Page } from '@playwright/test';
import { COPY_CONFIRM_MS } from '../../src/tokens';

/** A box, relative to the field's parent, so a scroll never reads as a move. */
type Box = [x: number, y: number, w: number, h: number];

/** One animation frame of one CopyField. */
interface Frame {
  /** The Button's status. */
  status: string;
  /** The Button's box. */
  button: Box;
  /** The value's box, when it is shown. */
  value: Box | null;
  /** The row holding the value and the action. */
  row: Box;
  /** The whole field. */
  field: Box;
}

/** One CopyField's run. */
interface Run {
  /** Where it is. */
  name: string;
  /** Every frame. */
  frames: Frame[];
}

/** The slowed --dur-change, in ms. */
const D = 4 * 268;

/** The sections that draw a CopyField. */
const SECTIONS = ['copy-field', 'container-fields', 'size', 'description-list'];

/**
 * Makes the clipboard take everything, or refuse everything, before the page loads.
 * @param page - The page
 * @param accept - Whether it takes the text
 */
async function fakeClipboard(page: Page, accept: boolean): Promise<void> {
  await page.addInitScript((ok: boolean) => {
    const write = (): Promise<void> => (ok ? Promise.resolve() : Promise.reject(new Error('no')));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText: write },
    });
  }, accept);
}

/**
 * Presses every CopyField action at rest in the light panels at once, and logs every frame
 * for `ms`.
 * @param page - The page
 * @param ms - How long to log
 * @returns Each field's frames
 */
async function pressAll(page: Page, ms: number): Promise<Run[]> {
  return page.evaluate(
    async ({ sections, ms }) => {
      const roots = sections.map((id) => `#${id} [data-scheme="light"]`).join(', ');
      // A CopyField's text action: a Button whose wrapper sits in the field's row.
      const buttons = [...document.querySelectorAll<HTMLButtonElement>(`:is(${roots}) button`)]
        .filter(
          (b) =>
            b.textContent?.startsWith('Copy') &&
            !b.disabled &&
            !b.hasAttribute('data-status') &&
            b.parentElement?.parentElement?.className.includes('line') &&
            getComputedStyle(b.parentElement).display !== 'none',
        )
        .map((b) => {
          const row = b.parentElement!.parentElement!;
          const field = row.parentElement!;
          return { b, row, field, frame: field.parentElement! };
        });
      const box = (el: Element | null, origin: DOMRect): Box | null => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.left - origin.left, r.top - origin.top, r.width, r.height].map(
          (n) => Math.round(n * 100) / 100,
        ) as Box;
      };
      const runs = buttons.map(({ b }) => ({
        name: [
          b.closest('section')?.id,
          b.closest('[data-density]')?.getAttribute('data-density'),
          b.closest('[class*="width-"], [class*="frame"]')?.className,
          b.textContent,
        ].join(' / '),
        frames: [] as Frame[],
      }));
      let on = true;
      const tick = (): void => {
        if (!on) return;
        buttons.forEach(({ b, row, field, frame }, i) => {
          const origin = frame.getBoundingClientRect();
          runs[i]!.frames.push({
            status: b.getAttribute('data-status') ?? 'idle',
            button: box(b, origin)!,
            value: box(row.querySelector('[tabindex="-1"]'), origin),
            row: box(row, origin)!,
            field: box(field, origin)!,
          });
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      for (const { b } of buttons) b.click();
      await new Promise((done) => setTimeout(done, ms));
      on = false;
      return runs;
    },
    { sections: SECTIONS, ms },
  );
}

/**
 * How many times the Button's width turns between growing and shrinking.
 * @param frames - The frames
 * @returns The number of turns
 */
const turns = (frames: Frame[]): number => {
  let dir = 0;
  let n = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i]!.button[2] - frames[i - 1]!.button[2];
    if (Math.abs(d) < 0.3) continue;
    if (dir && Math.sign(d) !== dir) n++;
    dir = Math.sign(d);
  }
  return n;
};

/**
 * How far a part of the frames strays from the first frame, in px.
 * @param frames - The frames
 * @param pick - Picks the numbers to compare
 * @returns The largest difference; 0 when there is nothing to compare
 */
const drift = (frames: Frame[], pick: (f: Frame) => number[]): number =>
  Math.max(0, ...frames.flatMap((f) => pick(f).map((x, k) => Math.abs(x - pick(frames[0]!)[k]!))));

test.use({ reducedMotion: 'no-preference' });

test.describe('accepted', () => {
  test.beforeEach(async ({ page }) => {
    await fakeClipboard(page, true);
    await page.goto('/?theme=light');
    await expect(page.locator('html[data-ready]')).toHaveCount(1);
    await page.addStyleTag({
      content: `${SECTIONS.map((id) => `#${id}`).join(', ')} { --dur-change: ${D}ms; }`,
    });
  });

  test('Copy, Copied and back: the width eases one way and back, and nothing else moves', async ({
    page,
  }) => {
    // The catalogue's refused specimens bring their own clipboard, which refuses.
    const runs = (await pressAll(page, COPY_CONFIRM_MS + D * 1.3 + 300)).filter((r) =>
      r.frames.some((f) => f.status === 'done'),
    );
    expect(runs.length).toBeGreaterThanOrEqual(10);
    for (const { name, frames } of runs) {
      const statuses = frames
        .map((f) => f.status)
        .filter((st, i, all) => i === 0 || st !== all[i - 1]);
      expect(statuses, name).toEqual(['idle', 'done', 'idle']);
      const idle = frames[0]!.button[2];
      const widths = frames.map((f) => f.button[2]);
      const narrowest = Math.min(...widths);
      // It shrinks to Copied and grows back to Copy: one turn, no snap at either end.
      expect(turns(frames), name).toBe(1);
      expect(Math.max(...widths), name).toBeLessThanOrEqual(idle + 0.3);
      expect(frames.at(-1)!.button[2], name).toBeCloseTo(idle, 1);
      expect(narrowest, name).toBeLessThan(idle - 10);
      // Copied's own width is where it settles: the morph never undershoots it.
      const settled = frames.filter((f) => f.status === 'done').at(-1)!.button[2];
      expect(narrowest, name).toBeGreaterThanOrEqual(settled - 0.3);
      // The start edge holds (a free end), and the value, the row and the field keep their boxes.
      expect(
        drift(frames, (f) => [f.button[0], f.button[1], f.button[3]]),
        name,
      ).toBeLessThan(0.5);
      expect(
        drift(frames, (f) => f.value ?? []),
        name,
      ).toBe(0);
      expect(
        drift(frames, (f) => f.row),
        name,
      ).toBe(0);
      expect(
        drift(frames, (f) => f.field),
        name,
      ).toBe(0);
    }
  });

  test('a CopyField action is as wide as the same Button anywhere else', async ({ page }) => {
    const inField = page
      .locator('#copy-field [data-scheme="light"] .copy-states button', { hasText: 'Copy address' })
      .first();
    const alone = page
      .locator('#button-states [data-scheme="light"] [data-case="Copy address"] button')
      .first();
    const width = (el: HTMLElement): number => el.getBoundingClientRect().width;
    expect(await inField.evaluate(width)).toBeCloseTo(await alone.evaluate(width), 1);
  });
});

test.describe('refused', () => {
  test.beforeEach(async ({ page }) => {
    await fakeClipboard(page, false);
    await page.goto('/?theme=light');
    await expect(page.locator('html[data-ready]')).toHaveCount(1);
  });

  test('a refusal keeps the Button; only a hidden value arrives, and the action wraps once', async ({
    page,
  }) => {
    // The catalogue's "back to rest" specimen brings its own clipboard, which takes it.
    const runs = (await pressAll(page, 800)).filter((r) =>
      r.frames.every((f) => f.status === 'idle'),
    );
    expect(runs.length).toBeGreaterThanOrEqual(10);
    let revealed = 0;
    for (const { name, frames } of runs) {
      expect(
        drift(frames, (f) => [f.button[2], f.button[3]]),
        name,
      ).toBe(0);
      if (frames[0]!.value) {
        // Shown from the start: the value and the row hold while it is selected.
        expect(
          drift(frames, (f) => f.value!),
          name,
        ).toBe(0);
        expect(
          drift(frames, (f) => f.row),
          name,
        ).toBe(0);
        expect(
          drift(frames, (f) => f.button),
          name,
        ).toBe(0);
      } else {
        // Revealed: the value arrives in one frame and the action moves under it once.
        revealed++;
        const at = frames.findIndex((f) => f.value);
        expect(at, name).toBeGreaterThan(0);
        expect(
          drift(frames.slice(0, at), (f) => f.button),
          name,
        ).toBe(0);
        expect(
          drift(frames.slice(at), (f) => [...f.button, ...f.value!]),
          name,
        ).toBe(0);
      }
    }
    expect(revealed).toBeGreaterThan(0);
  });
});
