/*
 * Behaviour of the atoms (DESIGN.md §4), on the catalogue page in a real browser: the
 * keyboard, the click-to-set slider (WCAG 2.5.7), the async Button and the Tooltip timing.
 */
import { expect, test, type Page } from '@playwright/test';

const light = (page: Page, id: string) => page.locator(`#${id} [data-scheme="light"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('/?theme=light');
  await expect(page.locator('main > section').first()).toBeVisible();
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
  const sw = light(page, 'switch').getByRole('switch', { name: 'Sync video', exact: true });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await light(page, 'switch').getByText('Sync video').click();
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
  const trigger = scheme.getByRole('button', { name: 'Measure video sync again' });
  await trigger.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const tip = scheme.locator('[role="tooltip"]').first();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});
