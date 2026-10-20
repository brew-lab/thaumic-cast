/*
 * Behaviour of the molecules (DESIGN.md §5), on the catalogue page in a real browser:
 * copy feedback (P-copy), address testing and validation (M-address, P-forms), the
 * details-based Disclosure, and the notices' roles.
 */
import { expect, test, type Page } from '@playwright/test';
import { openSections } from './open';

const light = (page: Page, id: string) => page.locator(`#${id} [data-scheme="light"]`);

test.beforeEach(async ({ page }) => {
  await openSections(page, '/?theme=light');
});

test('"Copied" is brief: it returns to the rest label after COPY_CONFIRM_MS', async ({ page }) => {
  // The "copied" specimen writes to a clipboard that takes everything.
  const specimen = light(page, 'copy-field')
    .locator('.copy-states > .stack')
    .filter({ has: page.getByText(/^copied, then back to rest/) })
    .first();
  await specimen.getByRole('button').first().click();
  await expect(specimen.getByRole('button', { name: 'Copied' })).toBeVisible();
  await page.waitForTimeout(2600);
  await expect(specimen.getByRole('button', { name: 'Copy address' })).toBeVisible();
});

test('a refused copy reveals the field and says why', async ({ page }) => {
  const section = light(page, 'copy-field');
  await expect(section.getByText('Copying did not work.').first()).toBeVisible();
  const revealed = section.locator('[tabindex="-1"]', { hasText: 'live.flac' }).last();
  await expect(revealed).toHaveText(/live\.flac$/);
});

test('a long value is shown whole: it wraps and is never cut off', async ({ page }) => {
  const value = light(page, 'copy-field').locator('.mono', { hasText: 'listen.flac' });
  await expect(value).toHaveText(/listen\.flac$/);
  const fits = await value.evaluate(
    (el) =>
      el.scrollWidth <= el.clientWidth + 1 &&
      el.getBoundingClientRect().height > 1.5 * parseFloat(getComputedStyle(el).lineHeight),
  );
  expect(fits).toBe(true);
});

test('nothing to copy disables the action and says why', async ({ page }) => {
  const section = light(page, 'copy-field');
  await expect(
    section.getByText("This computer's address is not known yet.").first(),
  ).toBeVisible();
});

test('a failed request says so without marking the field invalid', async ({ page }) => {
  const section = light(page, 'address-field');
  await expect(section.getByRole('button', { name: 'Try again' })).toBeVisible();
  const failed = section.getByRole('textbox', { name: 'Server address' }).nth(3);
  await expect(failed).not.toHaveAttribute('aria-invalid', 'true');
  await expect(section.getByText('Nothing answered at that address.')).toBeVisible();
});

test('an address that cannot be right is invalid and makes no request', async ({ page }) => {
  const section = light(page, 'address-field');
  const invalid = section.getByRole('textbox', { name: 'Server address' }).nth(4);
  await expect(invalid).toHaveAttribute('aria-invalid', 'true');
  await expect(invalid).toHaveAccessibleDescription(/not an address Thaumic Cast can use/);
});

test('testing keeps the value visible and only the Button is busy', async ({ page }) => {
  const section = light(page, 'address-field');
  const testing = section.getByRole('textbox', { name: 'Server address' }).nth(1);
  await expect(testing).toHaveAttribute('readonly', '');
  await expect(section.locator('button[aria-busy="true"]')).toHaveCount(1);
});

test('the speaker kind adds the address as the last Chip and clears the field', async ({
  page,
}) => {
  const section = light(page, 'address-field');
  const field = section.getByRole('textbox', { name: 'Add a speaker by IP address' });
  await field.fill('192.168.1.60');
  await field.press('Enter');
  await expect(section.getByRole('button', { name: 'Remove 192.168.1.60' })).toBeVisible();
  await expect(field).toHaveValue('');
});

test('a disclosure opens and shuts with the keyboard', async ({ page }) => {
  const section = light(page, 'disclosure');
  const details = section.locator('details').first();
  const summary = details.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(details).not.toHaveAttribute('open', '');
});

test('notices have no alert role; a banner is a region named by its lead', async ({ page }) => {
  const section = light(page, 'notice');
  await expect(section.locator('[role="alert"]')).toHaveCount(0);
  await expect(
    section.getByRole('region', { name: 'No desktop app or server answered' }),
  ).toBeVisible();
});

test('details on a notice open in place', async ({ page }) => {
  const section = light(page, 'notice');
  await section.getByRole('button', { name: 'Details' }).click();
  await expect(section.getByText('Its reserve ran dry')).toBeVisible();
});

test('the catalogue holds "Copied" for review', async ({ page }) => {
  const specimen = light(page, 'copy-field')
    .locator('.copy-states > .stack')
    .filter({ has: page.getByText('copied', { exact: true }) })
    .first();
  await page.waitForTimeout(2600);
  await expect(specimen.getByRole('button', { name: 'Copied' }).first()).toBeAttached();
});

test('Esc and X dismiss a toast; it never takes focus', async ({ page }) => {
  const section = light(page, 'toast');
  const again = section.getByRole('button', { name: 'Show the toast again' });
  const toast = section.getByText('Garden left this cast');
  await expect(toast).toBeVisible();
  await again.focus();
  // The catalogue shows one tooltip open from the start; the first Esc is the tooltip's.
  await page.keyboard.press('Escape');
  await expect(toast).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toast).toHaveCount(0);
  await again.click();
  await expect(toast).toBeVisible();
  await expect(again).toBeFocused();
  await section.getByRole('button', { name: 'Dismiss' }).first().click();
  await expect(toast).toHaveCount(0);
});

test('a toast is said once, politely, by the Announcer', async ({ page }) => {
  const section = light(page, 'toast');
  await section.getByRole('button', { name: 'Dismiss' }).first().click();
  // Record what the polite region says from here on.
  await page.evaluate(() => {
    const region = document.querySelector('[role="status"]')!;
    const said: string[] = [];
    (window as unknown as { said: string[] }).said = said;
    new MutationObserver(() => said.push(region.textContent ?? '')).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await section.getByRole('button', { name: 'Show the toast again' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { said: string[] }).said))
    .toContain('Garden left this cast');
  await page.waitForTimeout(500);
  const said = await page.evaluate(() => (window as unknown as { said: string[] }).said);
  expect(said.filter((m) => m === 'Garden left this cast')).toHaveLength(1);
});

test('an Esc that hides a tooltip leaves the toast (and its Undo) alone', async ({ page }) => {
  const toast = light(page, 'toast').getByText('Garden left this cast');
  await expect(toast).toBeVisible();
  const trigger = light(page, 'tooltip').getByRole('button', { name: 'Settings' });
  await trigger.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const tip = light(page, 'tooltip').locator('[role="tooltip"]', { hasText: 'Settings' });
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(toast).toBeVisible();
});

test('a toast message is never cut off', async ({ page }) => {
  const text = light(page, 'toast').getByText(/^Cast to Bedroom ended/);
  const whole = await text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  expect(whole).toBe(true);
});

test('notice, line and toast actions show busy, then failed', async ({ page }) => {
  for (const id of ['notice', 'notice-line', 'toast']) {
    const section = light(page, id);
    await expect(section.locator('button[aria-busy="true"]').first()).toBeVisible();
    await expect(section.locator('button[data-status="failed"]').first()).toBeVisible({
      timeout: 15_000,
    });
  }
});

test('a disabled disclosure does not open', async ({ page }) => {
  const details = light(page, 'disclosure')
    .locator('details')
    .filter({
      has: page.locator('summary[aria-disabled="true"]'),
    });
  await details.locator('summary').click({ force: true });
  await expect(details).not.toHaveAttribute('open', '');
});

test('a row that needs another setting, or is locked, is aria-disabled', async ({ page }) => {
  const section = light(page, 'settings-row');
  const rows = section.getByRole('group', { name: 'Speaker head start' });
  // Narrow, disabled and locked rows, in each of the three cards.
  await expect(rows.and(page.locator('[aria-disabled="true"]'))).toHaveCount(6);
});

test('no settings label is overlapped or cut off, at any card width', async ({ page }) => {
  const cut = await light(page, 'settings-row')
    .locator('[data-setrow] > div > p:first-child')
    .evaluateAll((els) =>
      els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
    );
  expect(cut).toEqual([]);
});

test('the detail slider shows its value', async ({ page }) => {
  const section = light(page, 'settings-row');
  const slider = section.getByRole('slider', { name: 'Start no louder than' }).first();
  await expect(slider.locator('..')).toContainText('30');
});

test('at the popup width a short lead keeps to one row, and none is cut off', async ({ page }) => {
  const lines = await light(page, 'notice-line')
    .locator('[data-popup-lines] [class*="words"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        rows: el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
        cut: el.scrollWidth > el.clientWidth + 1,
      })),
    );
  expect(lines.length).toBe(3);
  expect(lines[0]!.rows).toBeLessThan(1.5);
  expect(lines[1]!.rows).toBeLessThan(1.5);
  expect(lines.filter((l) => l.cut)).toEqual([]);
});

test('a pressed disclosure summary stays still: it fills its line, so it does not scale', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const summary = light(page, 'disclosure').locator('summary').first();
  await summary.scrollIntoViewIfNeeded();
  const at = (): Promise<string> =>
    summary.evaluate((el) => {
      const r = (el.firstElementChild as HTMLElement).getBoundingClientRect();
      return `${r.left.toFixed(1)}:${r.width.toFixed(1)}`;
    });
  const rest = await at();
  const box = (await summary.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  const pressed = await at();
  await page.mouse.up();
  expect(pressed).toBe(rest);
});
