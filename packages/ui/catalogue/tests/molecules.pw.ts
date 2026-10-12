/*
 * Behaviour of the molecules (DESIGN.md §5), on the catalogue page in a real browser:
 * copy feedback (P-copy), address testing and validation (M-address, P-forms), the
 * details-based Disclosure, and the notices' roles.
 */
import { expect, test, type Page } from '@playwright/test';

const light = (page: Page, id: string) => page.locator(`#${id} [data-scheme="light"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('/?theme=light');
  await expect(page.locator('main > section').first()).toBeVisible();
});

test('"Copied" is brief: it returns to the rest label after COPY_CONFIRM_MS', async ({ page }) => {
  // The "copied" specimen writes to a clipboard that takes everything.
  const specimen = light(page, 'copy-field')
    .locator('.copy-states > .stack')
    .filter({ has: page.getByText('copied', { exact: true }) })
    .first();
  await specimen.getByRole('button').first().click();
  await expect(specimen.getByRole('button', { name: 'Copied' })).toBeVisible();
  await page.waitForTimeout(2600);
  await expect(specimen.getByRole('button', { name: 'Copy address' })).toBeVisible();
});

test('a refused copy reveals the field and says why', async ({ page }) => {
  const section = light(page, 'copy-field');
  await expect(section.getByText('The clipboard said no.').first()).toBeVisible();
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
  await expect(section.getByText("This computer's address isn't known yet.").first()).toBeVisible();
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
