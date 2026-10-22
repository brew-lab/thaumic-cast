/*
 * The screenshots (DESIGN.md §10 row 6): each section is drawn on a page of its own and taken
 * there, so a change to one section never moves another. On one long page every section
 * started where the ones above it ended; the fluid spacing gives sections fractional heights,
 * so a section that grew moved every later one by a fraction of a pixel, which changed their
 * anti-aliasing and the box a screenshot rounds to, and dozens of untouched baselines failed.
 *
 * They run only with DS_SCREENSHOTS=1, which CI sets; locally they are skipped. Baselines are
 * made in CI only: when a section has no baseline yet, the CI run passes and writes the
 * picture into the `catalogue-results` artifact under `new-baselines/`. Download it, copy the
 * files into `packages/ui/catalogue/tests/__screenshots__/<project>/` (chromium or webkit) and
 * commit them. From then on a changed section fails CI until its baseline is replaced the
 * same way.
 */
import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openOnly } from './open';

// The page's header (the title, the theme switch, the table of contents) is not part of any
// section, and its height is fluid; without it the section starts at the page's padding and
// its own margin, both whole pixels at the test viewport.
const NO_HEADER = '.page-header { display: none; }';

/**
 * Opens a page of the one section and compares it with its baseline, or, when it has none,
 * writes the picture to `new-baselines/` in the test's output.
 * @param page - The test's page
 * @param address - The address as it would open the whole page, e.g. `/?theme=light`
 * @param id - The section's id
 * @param name - The baseline's file name
 * @param opened - Checks the page opened as the test needs, before anything is taken
 */
export async function matchesItsScreenshot(
  page: Page,
  address: string,
  id: string,
  name: string,
  opened?: (page: Page) => Promise<void>,
): Promise<void> {
  test.skip(!process.env.DS_SCREENSHOTS, 'Screenshots run in CI only (DS_SCREENSHOTS=1).');
  // Some sections are several screens tall, and WebKit takes its time over them.
  test.setTimeout(120_000);
  await openOnly(page, address, [id]);
  await opened?.(page);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: NO_HEADER });
  const section = page.locator(`#${id}`);
  // A fraction of a pixel here would make the picture depend on rounding again.
  const top = await section.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  expect(top % 1, `#${id} starts at ${top}px`).toBe(0);
  // A window's iframe loads lazily, as it nears the view: each is brought there and drawn.
  for (const iframe of await section.locator('iframe').all()) {
    await iframe.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        iframe.evaluate(
          (f: HTMLIFrameElement) => !!f.contentDocument?.getElementById('app')?.childElementCount,
        ),
      )
      .toBe(true);
  }
  // Nothing shows focus in a picture. A specimen that focuses on load (an open Dialog's
  // Cancel) draws its focus ring or not as WebKit's focus-visible guess falls, and with two
  // windows only one of them holds focus; so each document lets go of it.
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
  }
  const testInfo = test.info();
  if (!existsSync(testInfo.snapshotPath(name))) {
    // At CSS scale, as toHaveScreenshot compares; at WebKit's 2x the tallest sections pass
    // the 32767 px a screenshot can be.
    // As toHaveScreenshot takes it: animations stopped and the caret hidden, so a section
    // with a running animation (a busy Button's Clacks) matches its own baseline.
    await section.screenshot({
      path: testInfo.outputPath('new-baselines', name),
      scale: 'css',
      animations: 'disabled',
      caret: 'hide',
    });
    testInfo.annotations.push({ type: 'new baseline', description: name });
    return;
  }
  // Soft, so the test still reports the rest of its checks; each section is its own test.
  await expect.soft(section).toHaveScreenshot(name);
}
