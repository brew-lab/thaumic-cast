/*
 * Artwork's loading on its own (`?frame=artwork`), in Chromium and WebKit: a picture that loads
 * before the effects run is shown, on a first draw and on hydration; a new picture waits for its
 * own load; and one that failed is tried again whenever it comes back.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Opens the frame.
 * @param page - The page
 * @param art - The pictures its changing case steps through
 */
async function open(page: Page, art = 'a'): Promise<void> {
  await page.goto(`/?frame=artwork&theme=light&art=${art}`);
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
}

/**
 * Answers a picture's address with the pixel.
 * @param route - The request
 * @returns When it is answered
 */
const pixel = (route: Route): Promise<void> =>
  route.fulfill({
    contentType: 'image/png',
    body: PIXEL,
    headers: { 'cache-control': 'no-store' },
  });

const changing = (page: Page) => page.locator('[data-case="changing"]');
const next = (page: Page) => changing(page).getByRole('button', { name: 'Next picture' });

for (const name of ['fast', 'hydrated']) {
  test(`a picture that loads before the effects run is shown (${name})`, async ({ page }) => {
    await open(page);
    const picture = page.locator(`[data-case="${name}"] img`);
    await expect(picture).toHaveAttribute('data-loaded', '');
    await expect(picture).toHaveCSS('opacity', '1');
    await expect(page.locator(`[data-case="${name}"] [data-covered]`)).toHaveCount(1);
  });
}

test('a new picture on the same element waits for its own load', async ({ page }) => {
  await page.route('**/artwork-test/a.png', pixel);
  let answerB = (): void => {};
  const bHeld = new Promise<void>((resolve) => (answerB = resolve));
  await page.route('**/artwork-test/b.png', async (route) => {
    await bHeld;
    await pixel(route);
  });

  await open(page, 'a,b');
  const picture = changing(page).locator('img');
  await expect(picture).toHaveAttribute('data-loaded', '');
  await picture.evaluate((el) => el.setAttribute('data-same-element', ''));

  await next(page).click();
  await expect(picture).toHaveAttribute('src', /b\.png$/);
  await expect(picture).toHaveAttribute('data-same-element', '');
  await expect(picture).not.toHaveAttribute('data-loaded', '');
  await expect(changing(page).locator('[data-covered]')).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(picture).not.toHaveAttribute('data-loaded', '');

  answerB();
  await expect(picture).toHaveAttribute('data-loaded', '');
});

const RETRIES = [
  { how: 'after another that loaded', art: 'a,b,a', answerB: true },
  { how: 'after another still on its way', art: 'a,b,a', answerB: false },
  { how: 'after no picture at all', art: 'a,,a', answerB: true },
];

for (const { how, art, answerB } of RETRIES) {
  test(`a picture that failed is tried again ${how}`, async ({ page }) => {
    let aRequests = 0;
    await page.route('**/artwork-test/a.png', (route) => {
      aRequests += 1;
      return aRequests === 1 ? route.fulfill({ status: 500 }) : pixel(route);
    });
    await page.route('**/artwork-test/b.png', async (route) => {
      if (answerB) await pixel(route);
    });

    await open(page, art);
    const picture = changing(page).locator('img');

    // It fails: the image goes and the placeholder stays.
    await expect(picture).toHaveCount(0);
    await expect(changing(page).locator('[data-covered]')).toHaveCount(0);

    await next(page).click();
    if (answerB && art === 'a,b,a') await expect(picture).toHaveAttribute('data-loaded', '');

    // It comes back: asked for again, and this time it arrives.
    await next(page).click();
    await expect.poll(() => aRequests).toBe(2);
    await expect(picture).toHaveAttribute('data-loaded', '');
    await expect(changing(page).locator('[data-covered]')).toHaveCount(1);
  });
}
