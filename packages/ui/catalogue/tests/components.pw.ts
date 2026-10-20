/*
 * Behaviour of the popup's components (DESIGN.md §5–§7, Phase 3), on the catalogue page in a
 * real browser: the start level, the room rows, the picker, the cast bar, the notice slot and
 * the tiles. The shell's scrolling and scroll padding are in popup.pw.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const light = (page: Page, id: string): Locator => page.locator(`#${id} [data-scheme="light"]`);

/**
 * The bounding box of an element, or a failure.
 * @param el - The element
 * @returns Its box
 */
async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?theme=light');
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
});

/* -------------------------------------------------------------- StartLevel */

test('the LevelButton opens the StartLine in place and keeps focus', async ({ page }) => {
  const section = light(page, 'start-level');
  const button = section.getByRole('button', {
    name: 'Living Room start level, 30, capped from 72',
  });
  await expect(button.first()).toHaveAttribute('aria-expanded', 'false');
  await button.first().focus();
  await page.keyboard.press('Enter');
  await expect(button.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(button.first()).toBeFocused();
  const slider = section.getByRole('slider', { name: 'Living Room start level' }).first();
  await expect(slider).toHaveAttribute('aria-valuetext', '30, capped from 72');
  await expect(slider).toHaveAccessibleDescription('Now 72; starts at your limit of 30');
});

test('a level set by hand wins and the caption says the level now', async ({ page }) => {
  const section = light(page, 'start-level');
  const slider = section.getByRole('slider', { name: 'Study start level' }).last();
  await slider.focus();
  await page.keyboard.press('ArrowDown');
  await expect(slider).toHaveAttribute('aria-valuetext', '17, now 18');
  await expect(slider).toHaveAccessibleDescription('Now 18; starts at 17');
});

test('"…" is a LevelButton that says why and opens at the limit; "Fixed" is text', async ({
  page,
}) => {
  const section = light(page, 'start-level');
  const bedroom = section.getByRole('button', {
    name: 'Bedroom start level, not known yet; starts no louder than 30',
  });
  await expect(bedroom).toHaveCount(1);
  await expect(bedroom).toHaveText('…');
  await bedroom.click();
  await expect(section.getByRole('slider', { name: 'Bedroom start level' })).toHaveValue('30');
  await expect(section.getByRole('button', { name: /^Port start level/ })).toHaveCount(0);
  await expect(section.getByText('Port, fixed level; turn the amplifier instead')).toHaveCount(1);
});

/* ------------------------------------------------------------ RoomRow pick */

test('the whole pick row is one checkbox named by its lines', async ({ page }) => {
  const section = light(page, 'room-row-pick');
  const row = section.locator('[data-room="RINCON_STUDY"]').first();
  const study = row.getByRole('checkbox');
  await expect(study).toHaveAccessibleName('Study , starts at 18');
  await expect(study).not.toBeChecked();
  // A press on the start number at the row's end toggles the row too.
  await row.getByText('18', { exact: true }).click();
  await expect(study).toBeChecked();
  const kitchen = section.getByRole('checkbox', { name: /^Kitchen Grouped with Patio/ });
  await expect(kitchen).toBeChecked();
  const garden = section.getByRole('checkbox', { name: 'Garden No answer' });
  await expect(garden).toBeDisabled();
});

test('a chosen room takes its StartLevel outside the label, and opening it moves nothing above', async ({
  page,
}) => {
  const row = light(page, 'room-row-pick').locator('[data-room="RINCON_LIVINGROOM"]').first();
  const name = row.getByText('Living Room', { exact: true });
  const button = row.getByRole('button', { name: /^Living Room start level/ });
  // Measured against the row, as the press may scroll the page.
  const at = async (el: Locator): Promise<number[]> => {
    const [b, r] = [await box(el), await box(row)];
    return [b.x - r.x, b.y - r.y, b.width, b.height];
  };
  await button.scrollIntoViewIfNeeded();
  const before = { name: await at(name), button: await at(button) };
  await button.click();
  await expect(row.getByRole('slider')).toBeVisible();
  expect(await at(name)).toEqual(before.name);
  expect(await at(button)).toEqual(before.button);
  // The checkbox's name does not include the StartLevel button's words.
  await expect(row.getByRole('checkbox')).toHaveAccessibleName('Living Room at 72 now');
});

test('the start line indents to the room name', async ({ page }) => {
  const row = light(page, 'room-row-pick').locator('[data-room="RINCON_KITCHEN"]').first();
  const name = await box(row.getByText('Kitchen', { exact: true }));
  const slider = await box(row.getByRole('slider'));
  expect(Math.abs(slider.x - name.x)).toBeLessThan(1);
});

/* ------------------------------------------------------------ RoomRow cast */

test('a cast row: mute, volume and Remove in order, and no Remove on the last room', async ({
  page,
}) => {
  const section = light(page, 'room-row-cast');
  const kitchen = section.getByRole('group', { name: 'Kitchen' });
  const names = await kitchen
    .locator('button, input')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(names).toEqual(['Mute Kitchen', 'Kitchen volume', 'Remove Kitchen']);
  const study = section.getByRole('group', { name: 'Study' }).first();
  await expect(study.getByRole('button', { name: 'Remove Study' })).toHaveCount(0);
});

test('mute keeps one name and says its state with aria-pressed', async ({ page }) => {
  const mute = light(page, 'room-row-cast').getByRole('button', { name: 'Mute Living Room' });
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
});

test('a joining row is inert, busy and named so', async ({ page }) => {
  const group = light(page, 'room-row-cast').getByRole('group', { name: 'Bedroom is joining…' });
  await expect(group).toHaveAttribute('aria-busy', 'true');
  // Mute and the slider keep their places, drawn disabled; Remove's column is kept empty.
  await expect(group.getByRole('button')).toHaveCount(1);
  await expect(group.getByRole('button')).toBeDisabled();
  await expect(group.getByRole('slider')).toBeDisabled();
  expect(await group.locator('[inert]').count()).toBe(1);
});

test('a failed room shows a row line with Try again and X, and keeps its Badge', async ({
  page,
}) => {
  const section = light(page, 'room-row-cast');
  await expect(section.getByText('Bedroom did not join')).toBeVisible();
  await expect(section.getByText('Did not join', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Try again' })).toHaveCount(2);
});

/* ------------------------------------------------------------ RoomRow list */

test('a RoomList is a labelled list of its rows, and nothing in it is focusable', async ({
  page,
}) => {
  const list = light(page, 'room-row-list').getByRole('list', { name: 'Rooms that answered' });
  await expect(list).toHaveCount(2);
  await expect(list.first().getByRole('listitem')).toHaveCount(4);
  await expect(list.first().locator('button, input, a, [tabindex]')).toHaveCount(0);
});

/* ------------------------------------------------------------- MediaHeader */

test('a tile head is one disclosure button named by its text', async ({ page }) => {
  const section = light(page, 'media-header');
  const head = section.getByRole('button', { name: 'Album title Kitchen + Living Room' });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
});

test('the band takes its colour from the artwork, and the red guard moves Stop off it', async ({
  page,
}) => {
  const section = light(page, 'media-header');
  const bg = async (name: string): Promise<string> =>
    section
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .first()
      .evaluate((el) => getComputedStyle(el.closest('[style*="--art-h"]')!).backgroundColor);
  expect(await bg('Video title Kitchen')).not.toEqual(await bg('Neon title'));
  const red = section.getByRole('button', { name: /^Film title TV Room/ });
  const band = red.locator('xpath=ancestor::*[contains(@style,"--art-h")][1]');
  await expect(band.getByRole('button', { name: 'Stop casting Film title' })).toHaveCount(0);
  await expect(
    band.locator('xpath=..').getByRole('button', { name: 'Stop casting Film title' }),
  ).toHaveCount(1);
});

test('the TabCard title is a heading only when there is no disclosure', async ({ page }) => {
  const section = light(page, 'media-header');
  const heading = section.getByRole('heading', { name: 'Video title', level: 3 });
  await expect(heading).toHaveAttribute('tabindex', '-1');
  await expect(section.getByRole('heading', { name: 'Album title' })).toHaveCount(0);
});

/* ------------------------------------------------------------- GroupVolume */

test('the master shows the mean and the fold summary lists the levels', async ({ page }) => {
  const section = light(page, 'group-volume');
  const master = section.getByRole('slider', { name: 'Kitchen + Living Room + TV Room volume' });
  await expect(master.first()).toHaveAttribute('aria-valuetext', '34');
  await expect(
    section.getByText('Kitchen 30 · Living Room muted · TV Room 25').first(),
  ).toBeAttached();
  await expect(section.getByText('Kitchen may cut out · Patio 46')).toBeVisible();
});

test('a lone room has no Remove, and each of several rooms has one', async ({ page }) => {
  const section = light(page, 'group-volume');
  const one = section.getByRole('group', { name: 'Kitchen' }).first();
  await expect(one.getByRole('button', { name: 'Remove Kitchen' })).toHaveCount(0);
  const open = section.locator('details[open]').first();
  await expect(open.getByRole('button', { name: /^Remove / })).toHaveCount(3);
});

test('Add a room opens the add list of pick rows, with no sets', async ({ page }) => {
  const section = light(page, 'group-volume');
  const add = section.getByRole('button', { name: 'Add a room' }).first();
  await expect(add).toHaveAttribute('aria-expanded', 'false');
  await add.click();
  await expect(add).toHaveAttribute('aria-expanded', 'true');
  const list = section.getByRole('group', { name: 'Add to this cast' }).first();
  await expect(list.getByRole('checkbox')).toHaveCount(2);
  await expect(add).toHaveAttribute('aria-controls', (await list.getAttribute('id')) ?? 'none');
});

test('a flush Button inside an open fold keeps its whole surface', async ({ page }) => {
  // "Add a room" reaches back past the text column by its pull; the fold clips only its
  // height, so the surface's inline-start edge is still painted and still takes a press.
  const section = light(page, 'group-volume');
  const add = section.locator('details[open]').getByRole('button', { name: 'Add a room' });
  await add.first().scrollIntoViewIfNeeded();
  const b = await box(add.first());
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null,
    { x: b.x + 2, y: b.y + b.height / 2 },
  );
  expect(hit).toContain('Add a room');
});

/* --------------------------------------------------------------- VideoSync */

test('Video sync is one name with its Badge, and Fine-tune holds the trim', async ({ page }) => {
  const section = light(page, 'video-sync');
  await expect(
    section.getByRole('switch', { name: 'Video sync In step', exact: true }),
  ).toBeChecked();
  const trim = section.getByRole('slider', { name: 'Fine-tune for Living Room' });
  await expect(trim).toHaveCount(1);
  await expect(trim).toHaveAttribute('aria-valuetext', 'Sound 120 ms earlier');
  await expect(section.locator('[aria-live], [role="alert"], [role="status"]')).toHaveCount(0);
});

test('Cannot sync says why with the Switch, offers Reload page only for a reload, and has no Fine-tune', async ({
  page,
}) => {
  const section = light(page, 'video-sync');
  const pcm = section.getByRole('switch', { name: 'Video sync Cannot sync', exact: true }).first();
  await expect(pcm).toHaveAccessibleDescription(/Only PCM casts keep good enough time/);
  const reload = section.getByRole('button', { name: 'Reload page' });
  // The VideoSync row is the nearest ancestor holding a Switch.
  const reloadRow = reload.locator('xpath=ancestor::div[.//*[@role="switch"]][1]');
  await expect(reloadRow).toContainText('This page was open before video sync was on.');
  await expect(reloadRow.getByRole('slider')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Reload page' })).toHaveCount(1);
  await expect(section.getByRole('slider')).toHaveCount(1);
});

test('Try again moves focus to the Switch and says the new phase once', async ({ page }) => {
  const section = light(page, 'video-sync');
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
  await section.getByRole('button', { name: 'Try again' }).click();
  const focused = section.locator('[role="switch"]:focus');
  await expect(focused).toHaveAccessibleName('Video sync Locking on…');
  await expect(section.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { said: string[] }).said))
    .toContain('Video sync. Locking on…');
  await page.waitForTimeout(500);
  const said = await page.evaluate(() => (window as unknown as { said: string[] }).said);
  expect(said.filter((m) => m.startsWith('Video sync.'))).toHaveLength(1);
});

/* ------------------------------------------- PopupHeader, CastBar, NoticeSlot */

test('the header is the h1, its status beside a dot, and Settings', async ({ page }) => {
  const section = light(page, 'popup-header');
  await expect(section.getByRole('heading', { level: 1, name: 'Thaumic Cast' })).toHaveCount(7);
  // Six plain, and one marked for an update.
  await expect(section.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(6);
  await expect(
    section.getByRole('button', { name: 'Settings, update available', exact: true }),
  ).toHaveCount(1);
  await expect(section.getByText(/^\d+$/)).toHaveCount(0);
  await expect(section.locator('[aria-live], [role="alert"], [role="status"]')).toHaveCount(0);
});

test('the CastBar keeps no empty line: with nothing to say it ends at Cast', async ({ page }) => {
  const section = light(page, 'cast-bar');
  const empty = section.getByRole('button', { name: 'Cast to 1 room' });
  const full = section.getByRole('button', { name: 'Cast to 4 rooms' });
  const [a, barA] = [await box(empty), await box(empty.locator('xpath=..'))];
  expect(Math.abs(barA.y + barA.height - (a.y + a.height))).toBeLessThan(1);
  await expect(empty.locator('xpath=..').locator('p')).toHaveCount(0);
  await expect(full.locator('xpath=..').locator('p')).toHaveCount(1);
});

test('add mode names Add with the cast, and a failure sits above Cast', async ({ page }) => {
  const section = light(page, 'cast-bar');
  await expect(section.getByRole('button', { name: 'Add 2 rooms to Album title' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const lead = await box(section.getByText('The cast did not start'));
  const cast = await box(section.getByRole('button', { name: 'Cast to 2 rooms' }).last());
  expect(lead.y).toBeLessThan(cast.y);
  await section.getByRole('button', { name: 'Dismiss' }).click();
  await expect(section.getByText('The cast did not start')).toHaveCount(0);
});

test('the slot draws its first item in full and the rest as lines', async ({ page }) => {
  const section = light(page, 'notice-slot');
  await expect(section.getByRole('region', { name: 'Kitchen may cut out soon' })).toHaveCount(1);
  await expect(
    section.getByRole('button', { name: 'Kitchen may cut out soon: open this cast' }),
  ).toHaveCount(1);
  await expect(section.locator('[aria-live], [role="alert"]')).toHaveCount(0);
});

/* -------------------------------------------------------------- RoomPicker */

test('a set replaces the choice and reads pressed while the choice equals it', async ({ page }) => {
  const picker = light(page, 'room-picker').getByRole('group', { name: 'Cast to' }).first();
  const last = picker.getByRole('button', { name: /^Last cast/ });
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  await picker.getByRole('button', { name: /^Everywhere/ }).click();
  await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(4);
  await expect(last).toHaveAttribute('aria-pressed', 'false');
});

test('the rooms fold from 8: shut shows only the chosen rooms', async ({ page }) => {
  const picker = light(page, 'room-picker').getByRole('group', { name: 'Cast to' }).nth(2);
  await expect(picker.getByText('3 of 14 chosen')).toBeVisible();
  await expect(picker.getByRole('checkbox')).toHaveCount(3);
  await expect(picker.getByRole('searchbox')).toHaveCount(0);
});

test('the search filters and never unticks, and counts the chosen rooms it hides', async ({
  page,
}) => {
  const picker = light(page, 'room-picker').getByRole('group', { name: 'Cast to' }).nth(3);
  const search = picker.getByRole('searchbox', { name: 'Find a room' });
  await expect(search).toHaveValue('room');
  await expect(
    picker.getByText('2 chosen rooms are hidden by the search. They stay chosen.'),
  ).toBeVisible();
  await search.fill('kit');
  await expect(picker.getByRole('checkbox')).toHaveCount(1);
  await expect(picker.getByRole('checkbox', { name: /^Kitchen/ })).toBeChecked();
  await search.press('Escape');
  await expect(picker.getByRole('checkbox')).toHaveCount(14);
  await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(3);
});

test('not connected, the fieldset is disabled and says why', async ({ page }) => {
  const section = light(page, 'room-picker');
  const off = section.locator('fieldset[disabled]');
  await expect(off).toHaveCount(1);
  await expect(off.getByText('Rooms are listed here once the companion answers.')).toBeVisible();
});

test('the save form names the set, and says when it has no name', async ({ page }) => {
  const section = light(page, 'room-picker');
  const field = section.getByRole('textbox', { name: 'Name this set' });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/A set needs a name\./);
});

/* ------------------------------------------------------- TabCard, CastTile */

test('the TabCard is a section named by its h2 title', async ({ page }) => {
  const section = light(page, 'tab-card');
  const card = section.getByRole('region', { name: 'Video title' });
  await expect(card.getByRole('heading', { level: 2, name: 'Video title' })).toBeVisible();
  await expect(card.getByRole('group', { name: 'Cast to' })).toBeVisible();
});

test('a single cast is open with no chevron; Stop is named by the title', async ({ page }) => {
  const tile = light(page, 'cast-tile').getByRole('region', { name: 'Video title' });
  await expect(tile.getByRole('button', { name: /^Video title/ })).toHaveCount(0);
  await expect(tile.getByRole('button', { name: 'Stop casting Video title' })).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Go to tab: Video title' })).toBeVisible();
});

test('a compact tile opens in place: the head and Stop stay the same elements', async ({
  page,
}) => {
  const tile = light(page, 'cast-tile').getByRole('region', { name: 'Mix title' });
  const head = tile.getByRole('button', { name: /^Mix title/ });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await head.evaluate((el) => el.setAttribute('data-test-same', ''));
  await tile
    .getByRole('button', { name: 'Stop casting Mix title' })
    .evaluate((el) => el.setAttribute('data-test-same', ''));
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(tile.locator('[data-test-same]')).toHaveCount(2);
  const body = await head.getAttribute('aria-controls');
  await expect(tile.locator(`[id="${body}"]`)).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Go to tab: Mix title' })).toBeVisible();
});

test('with no band, the head row sits at one spot open and compact', async ({ page }) => {
  const specimen = light(page, 'cast-tile').locator('[data-specimen="no-art"]');
  // Artwork start and Stop end, from the card's own edges.
  const insets = (title: string) =>
    specimen.getByRole('region', { name: title }).evaluate((card) => {
      const edge = card.getBoundingClientRect();
      const stop = card.querySelector('button[aria-label^="Stop casting"]')!;
      const art = card.querySelector('[class*="artwork"]')!;
      return {
        stop: Math.round(edge.right - stop.getBoundingClientRect().right),
        art: Math.round(art.getBoundingClientRect().left - edge.left),
      };
    });
  const open = await insets('Tone title');
  const compact = await insets('Hum title');
  expect(open).toEqual(compact);
  expect(open.stop).toBeGreaterThanOrEqual(12);
});

test('the open band bleeds to the card, and its head row sits where it does compact', async ({
  page,
}) => {
  const section = light(page, 'cast-tile');
  const insets = (title: string) =>
    section
      .getByRole('region', { name: title })
      .first()
      .evaluate((card) => {
        const edge = card.getBoundingClientRect();
        const line = parseFloat(getComputedStyle(card).borderTopWidth);
        const band = card.querySelector('[style*="--art-h"]')?.getBoundingClientRect();
        const stop = card.querySelector('button[aria-label^="Stop casting"]')!;
        const art = card.querySelector('[class*="artwork"]')!;
        return {
          band: band && [band.left - edge.left, band.top - edge.top, edge.right - band.right],
          line,
          stop: Math.round(edge.right - stop.getBoundingClientRect().right),
          art: Math.round(art.getBoundingClientRect().left - edge.left),
        };
      });
  const open = await insets('Album title');
  const compact = await insets('Mix title');
  expect(open.band).toEqual([open.line, open.line, open.line]);
  expect(compact.band).toBeUndefined();
  expect({ stop: open.stop, art: open.art }).toEqual({ stop: compact.stop, art: compact.art });
});

test('the slot line on a compact tile opens it', async ({ page }) => {
  const tile = light(page, 'cast-tile').getByRole('region', { name: 'Album title' }).last();
  await tile.getByRole('button', { name: 'Kitchen may cut out soon: open this cast' }).click();
  await expect(tile.getByRole('region', { name: 'Kitchen may cut out soon' })).toBeVisible();
});

/* ----------------------------------------------------------------- SetList */

test('a set renames in place, refuses an empty name and gives focus back', async ({ page }) => {
  const list = light(page, 'set-list').getByRole('list').first();
  await list.getByRole('button', { name: 'Rename Downstairs' }).click();
  const field = list.getByRole('textbox', { name: 'Name this set' });
  await expect(field).toBeFocused();
  await field.fill('');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(list.getByText('A set needs a name.')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.fill('Ground floor');
  await field.press('Enter');
  await expect(list.getByRole('button', { name: 'Rename Ground floor' })).toBeFocused();
  await expect(list.getByText('Downstairs')).toHaveCount(0);
});

test('Escape cancels Rename and gives focus back to it', async ({ page }) => {
  const list = light(page, 'set-list').getByRole('list').first();
  await list.getByRole('button', { name: 'Rename Downstairs' }).click();
  const field = list.getByRole('textbox', { name: 'Name this set' });
  await expect(field).toBeFocused();
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'Rename Downstairs' })).toBeFocused();
});

test('Remove takes a set out at once, and Undo puts it back where it was', async ({ page }) => {
  const section = light(page, 'set-list');
  const list = section.getByRole('list').first();
  const names = () =>
    list
      .locator('li')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).innerText.split('\n')[0]));
  await list.getByRole('button', { name: 'Remove Downstairs' }).click();
  expect(await names()).not.toContain('Downstairs');
  await expect(section.getByText('Downstairs removed.')).toBeVisible();
  await section.getByRole('button', { name: /^Undo/ }).click();
  expect((await names())[1]).toBe('Downstairs');
});

test('with no sets the list is its empty state', async ({ page }) => {
  const section = light(page, 'set-list');
  await expect(section.getByText('No sets yet')).toHaveCount(1);
  await expect(section.getByRole('list')).toHaveCount(1);
});
