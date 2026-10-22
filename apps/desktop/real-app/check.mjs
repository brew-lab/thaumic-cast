// The scripted real-app pass: the desktop frontend's production build in Playwright's WebKit
// (the desktop's engine on macOS and Linux) or Chromium (WebView2 on Windows), its Tauri
// commands answered by the real core on the fake household (run.sh starts both). It walks
// onboarding, Speakers (with real casts), Stop all casts, Server, Settings, Not found and the
// rail at the default window, a narrow one (under 45rem) and a wide one, checks each outcome,
// and saves a screenshot per step. A check named in expected-fail.json may fail (XFAIL); if it
// passes (XPASS) the run fails, so the list only shrinks. Exit 1 on any failure.
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import * as lib from './lib.mjs';

const engine = process.env.ENGINE === 'webkit' ? 'webkit' : 'chromium';
const scale = Number(process.env.SCALE ?? 1);
const scheme = process.env.SCHEME === 'dark' ? 'dark' : 'light';
const tag = `${engine}-${scale === 1 ? '100' : Math.round(scale * 100)}-${scheme}`;
const EXPECTED_FAIL = new Set(
  JSON.parse(readFileSync(new URL('./expected-fail.json', import.meta.url), 'utf8')),
);
const results = [];

/** The windows, in CSS px: the default (L-desktop), a narrow one and a wide one. */
const SIZES = {
  default: { width: 840, height: 640 },
  narrow: { width: 600, height: 640 },
  wide: { width: 1280, height: 800 },
};

/**
 * Records one check.
 * @param {string} name - What was checked; the key in expected-fail.json
 * @param {boolean} ok - Whether it held
 * @param {unknown} [detail] - What was seen, printed on failure
 */
function check(name, ok, detail) {
  const expected = EXPECTED_FAIL.has(name);
  const word = ok ? (expected ? 'XPASS' : 'PASS') : expected ? 'XFAIL' : 'FAIL';
  results.push({ name, word });
  const seen = ok && !expected ? '' : `\n      saw: ${JSON.stringify(detail)}`;
  console.log(`${word.padEnd(5)}  ${name}${seen}`);
}

/**
 * Polls until `probe` returns something truthy, or the time is up.
 * @param {() => Promise<unknown>} probe - What to ask
 * @param {number} [ms] - How long to wait
 * @returns {Promise<unknown>} The last answer
 */
async function until(probe, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await lib.sleep(200);
  }
  return last;
}

/**
 * The casts running on the real core.
 * @returns {Promise<object[]>} Its playback sessions
 */
const sessions = () => lib.ipc('get_playback_sessions');

/**
 * Starts a cast to rooms and waits for the app to show it.
 * @param {import('./lib.mjs').App} app - The app
 * @param {string} rooms - Comma-separated room names
 * @returns {Promise<string>} The stream id
 */
async function cast(app, rooms) {
  const id = (await lib.control(`/cast?rooms=${encodeURIComponent(rooms)}&codec=pcm`)).trim();
  await until(async () => (await roomCards(app)).some((c) => /casting/i.test(c.badge)));
  return id;
}

/**
 * Stops every cast on the core directly (cleanup between steps).
 * @returns {Promise<void>} Resolves once nothing casts
 */
async function stopEverything() {
  await lib.ipc('clear_all_streams');
  await until(async () => (await sessions()).length === 0);
}

/**
 * The layout facts every view shares: the scrollers, the rail and the document.
 * @param {import('./lib.mjs').App} app - The app
 * @returns {Promise<object>} The facts
 */
const shellFacts = (app) =>
  app.page.evaluate(() => {
    const px = (expr) => {
      const probe = document.createElement('div');
      probe.style.inlineSize = expr;
      probe.style.position = 'absolute';
      document.body.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return Math.round(w);
    };
    const scrollers = [...document.querySelectorAll('body *')]
      .filter((e) => e.getClientRects().length > 0)
      .filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY))
      .map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
    const nav = document.querySelector('nav');
    const rail = nav?.closest('aside, [data-rail]') ?? nav;
    return {
      scrollers,
      documentScrolls:
        document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rail: rail ? Math.round(rail.getBoundingClientRect().width) : null,
      railNarrow: px('var(--rail-narrow)'),
      railWide: px('var(--rail-wide)'),
      h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()),
    };
  });

/**
 * Checks the shell at this window: one scroller, nothing wider than the window, and the rail
 * narrow under 45rem and wide from it.
 * @param {import('./lib.mjs').App} app - The app
 * @param {string} view - The view's name, for the check names
 * @param {string} size - The window's name
 * @param {{rail?: boolean}} [o] - Whether the view has the rail
 * @returns {Promise<object>} The facts
 */
async function checkShell(app, view, size, { rail = true } = {}) {
  const f = await shellFacts(app);
  check(
    `${view} (${size}): exactly one scroller and the document does not scroll`,
    f.scrollers.length === 1 && !f.documentScrolls,
    f,
  );
  check(`${view} (${size}): nothing is wider than the window`, f.overflowX <= 0, f.overflowX);
  if (rail) {
    const want = SIZES[size].width >= 720 ? f.railWide : f.railNarrow;
    check(
      `${view} (${size}): the rail is ${SIZES[size].width >= 720 ? 'wide' : 'narrow'}`,
      Math.abs(f.rail - want) <= 1,
      f,
    );
  }
  return f;
}

/**
 * Runs axe on the page as it is, in this run's scheme.
 * @param {import('./lib.mjs').App} app - The app
 * @param {string} what - What is on screen, for the check name
 */
async function checkAxe(app, what) {
  const results = await new AxeBuilder({ page: app.page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  );
  check(`axe finds nothing on ${what}`, summary.length === 0, summary);
}

/**
 * The room cards on the Speakers view, in order: each card is the largest box round a room's
 * heading that holds no other room's heading.
 * @param {import('./lib.mjs').App} app - The app
 * @returns {Promise<object[]>} Per card: the name, Badge, sub line and their boxes
 */
const roomCards = (app) =>
  app.page.evaluate((rooms) => {
    const main = document.querySelector('main') ?? document.body;
    const heads = [...main.querySelectorAll('h2, h3')].filter((h) =>
      rooms.includes(h.innerText.trim()),
    );
    const box = (e) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
    };
    return heads.map((h) => {
      let card = h;
      while (
        card.parentElement &&
        card.parentElement !== main &&
        heads.filter((o) => card.parentElement.contains(o)).length === 1
      ) {
        card = card.parentElement;
      }
      const badge = card.querySelector('[class*="badge"]');
      const sub = [...card.querySelectorAll('p')].find((p) => !p.closest('[class*="copy"]'));
      // 6ch in the name's face, or the name's own width on one line when that is less.
      const probe = (css, text = '') => {
        const span = document.createElement('span');
        span.style.cssText = `position:absolute;white-space:nowrap;${css}`;
        span.textContent = text;
        h.append(span);
        const w = span.getBoundingClientRect().width;
        span.remove();
        return w;
      };
      const ch = Math.min(probe('inline-size:6ch'), probe('', h.innerText.trim()));
      const lh = parseFloat(getComputedStyle(sub ?? h).lineHeight) || 20;
      return {
        name: h.innerText.trim(),
        level: h.tagName,
        badge: badge?.innerText.trim() ?? '',
        sub: sub?.innerText.trim() ?? '',
        nameBox: box(h),
        badgeBox: box(badge),
        subBox: box(sub),
        subLines: sub ? Math.round(sub.getBoundingClientRect().height / lh) : 0,
        subCut: sub ? sub.scrollWidth > sub.clientWidth + 1 : false,
        sixCh: ch,
        meter: Boolean(card.querySelector('meter, [role="meter"]')),
        meterText:
          card.querySelector('meter, [role="meter"]')?.getAttribute('aria-valuetext') ?? '',
        copy: [...card.querySelectorAll('button')].map((b) => b.innerText.trim()),
        text: card.innerText,
      };
    });
  }, lib.ROOMS);

/**
 * Checks each card's head: the name at least 6ch wide and never under the Badge, and the sub
 * line on one line, never cut off.
 * @param {object[]} cards - From roomCards
 * @param {string} size - The window's name
 */
function checkCardHeads(cards, size) {
  const narrowName = cards.filter((c) => c.nameBox.w + 0.5 < c.sixCh);
  check(
    `Speakers (${size}): every room name box is at least 6ch (or the whole name)`,
    narrowName.length === 0,
    narrowName.map((c) => [c.name, c.nameBox.w, c.sixCh]),
  );
  const overlap = cards.filter((c) => {
    const a = c.nameBox;
    const b = c.badgeBox;
    return b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  });
  check(
    `Speakers (${size}): no Badge overlaps its room name`,
    overlap.length === 0,
    overlap.map((c) => c.name),
  );
  const badSub = cards.filter((c) => c.subLines !== 1 || c.subCut);
  check(
    `Speakers (${size}): every sub line is one line and not cut off`,
    badSub.length === 0,
    badSub.map((c) => [c.name, c.sub, c.subLines, c.subCut]),
  );
}

/**
 * The open dialog, if any, and where focus is.
 * @param {import('./lib.mjs').App} app - The app
 * @returns {Promise<object>} The facts
 */
const dialogFacts = (app) =>
  app.page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    const a = document.activeElement;
    return {
      open: Boolean(d),
      title: d?.querySelector('h2, h1')?.innerText.trim() ?? null,
      focus: (a?.getAttribute('aria-label') || a?.innerText || a?.tagName || '').trim(),
      buttons: d ? [...d.querySelectorAll('button')].map((b) => b.innerText.trim()) : [],
    };
  });

/**
 * Where focus is: whether it sits in the page's main area and on a focusable control.
 * @param {import('./lib.mjs').App} app - The app
 * @returns {Promise<object>} The facts
 */
const focusFacts = (app) =>
  app.page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? null,
      name: (a?.getAttribute('aria-label') || a?.innerText || '').trim().slice(0, 60),
      inMain: Boolean(a?.closest('main')),
      control: Boolean(a && a !== document.body && a.matches('button, a[href], input, select')),
    };
  });

/**
 * The toast row and focus: whether a toast shows, its words, and whether it sits outside the
 * scroller and clear of the focused control.
 * @param {import('./lib.mjs').App} app - The app
 * @returns {Promise<object>} The facts
 */
const toastFacts = (app) =>
  app.page.evaluate(() => {
    const t =
      document.querySelector('[data-toast-row] > *') ?? document.querySelector('[class*="toast"]');
    const r = t?.getBoundingClientRect();
    const a = document.activeElement;
    const ar = a && a !== document.body ? a.getBoundingClientRect() : null;
    const scroller = document.querySelector('[data-scroller]');
    return {
      shown: Boolean(t && r.height > 0),
      text: t?.innerText.trim() ?? '',
      outsideScroller: t ? !scroller?.contains(t) : null,
      clearOfFocus: !t || !ar || ar.bottom <= r.top + 0.5 || ar.top >= r.bottom - 0.5,
    };
  });

/**
 * A button by its visible words or name.
 * @param {import('./lib.mjs').App} app - The app
 * @param {string | RegExp} name - Its accessible name
 * @returns {import('@playwright/test').Locator} The button
 */
const button = (app, name) =>
  app.page.getByRole('button', { name, exact: typeof name === 'string' });

/**
 * Runs one part of the walk; if it throws, that is a failed check and the walk goes on.
 * @param {string} name - The part
 * @param {() => Promise<void>} fn - The part's steps
 */
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`the ${name} walk finished`, false, String(e.stack ?? e));
  }
}

// ── The walk ────────────────────────────────────────────────────────────────

const server = lib.serve();
const problems = [];
/** @type {import('./lib.mjs').App | null} */
let app = null;

/**
 * Opens the app afresh, closing the last one and keeping its problems.
 * @param {string} size - The window's name
 * @param {object} [o] - Passed to lib.open
 * @returns {Promise<import('./lib.mjs').App>} The app
 */
async function openApp(size, o = {}) {
  if (app) {
    problems.push(...app.problems);
    await app.close();
  }
  app = await lib.open({ engine, scale, scheme, size: SIZES[size], ...o });
  return app;
}

try {
  // ── Onboarding, every step, at the default and the narrow window ──────────
  await section('Onboarding', async () => {
    for (const size of ['default', 'narrow']) {
      const a = await openApp(size, { onboarded: false });
      await a.goto('/');
      const rooms = lib.ROOMS.length;
      for (let step = 1; step <= 5; step++) {
        const last = step === 5;
        const next = button(a, last ? "That'll do" : 'Carry on');
        await next.waitFor({ timeout: 8000 });
        if (step === 3) {
          await until(() => a.page.evaluate(() => /answered/.test(document.body.innerText)));
        }
        await a.page.waitForTimeout(150);
        await a.shot(`01-onboarding-${step}-${size}-${tag}`);
        const foot = await a.page.evaluate(() => {
          const box = (b) => {
            const r = b?.getBoundingClientRect();
            return r
              ? { t: Math.round(r.top), b: Math.round(r.bottom), l: r.left, r: r.right }
              : null;
          };
          const byText = (t) =>
            [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === t);
          const skip = byText('Skip the formalities');
          const back = byText('Back');
          const next = byText('Carry on') ?? byText("That'll do");
          const rule = [...document.querySelectorAll('hr, [role="separator"]')].find(
            (h) => h.getBoundingClientRect().bottom <= (next?.getBoundingClientRect().top ?? 0),
          );
          const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
          return {
            skip: box(skip),
            back: box(back),
            next: box(next),
            rule: Boolean(rule),
            modal: Boolean(dialog),
            vh: innerHeight,
            text: document.body.innerText,
          };
        });
        check(
          `onboarding step ${step} (${size}): ${last ? "That'll do" : 'Carry on'} is in view without scrolling`,
          foot.next !== null && foot.next.b <= foot.vh,
          { next: foot.next, vh: foot.vh },
        );
        const row = [foot.skip, foot.back, foot.next].filter(Boolean);
        const mid = (b) => (b.t + b.b) / 2;
        check(
          `onboarding step ${step} (${size}): Skip, Back and Carry on sit on one line`,
          row.every((b) => Math.abs(mid(b) - mid(foot.next)) <= 2),
          row,
        );
        check(
          `onboarding step ${step} (${size}): Back is there from step 2 only`,
          Boolean(foot.back) === step > 1,
          foot.back,
        );
        check(`onboarding step ${step} (${size}): a rule sits above the footer`, foot.rule, foot);
        check(
          `onboarding step ${step} (${size}): the full form is not a modal dialog`,
          !foot.modal,
          foot.modal,
        );
        if (step === 1) await checkShell(a, 'onboarding', size, { rail: false });
        if (step === 3) {
          check(
            `onboarding (${size}): the speakers step counts rooms`,
            foot.text.includes(`${rooms} rooms answered.`),
            foot.text.match(/\d+ \w+ answered\.?/)?.[0],
          );
          check(
            `onboarding (${size}): the speakers step lists each room with its group`,
            foot.text.includes('Grouped with Bathroom') && foot.text.includes('Study'),
            foot.text,
          );
          if (size === 'default') await checkAxe(a, 'the onboarding speakers step');
        }
        if (step === 5) {
          // Tabbing to Launch at login from the top: the pinned footer never covers it.
          await a.page.evaluate(() => {
            document.querySelector('[data-scroller]').scrollTop = 0;
            document.activeElement?.blur();
          });
          let sw = null;
          for (let i = 0; i < 20 && !sw; i++) {
            await a.page.keyboard.press('Tab');
            sw = await a.page.evaluate(() => {
              const el = document.activeElement;
              if (el?.getAttribute('role') !== 'switch') return null;
              const r = el.getBoundingClientRect();
              const hr = [...document.querySelectorAll('hr, [role="separator"]')].at(-1);
              return { b: Math.round(r.bottom), rule: Math.round(hr.getBoundingClientRect().top) };
            });
          }
          check(
            `onboarding (${size}): a focused control is never under the pinned footer`,
            Boolean(sw) && sw.b <= sw.rule,
            sw,
          );
          check(
            `onboarding (${size}): the ready step counts rooms`,
            foot.text.includes(`Rooms: ${rooms} answered`),
            foot.text.match(/\w+: \d+ answered/)?.[0],
          );
        }
        await next.click();
      }
      const landed = await until(() =>
        a.page.evaluate(() => document.querySelector('h1')?.innerText.trim() === 'Speakers'),
      );
      check(`onboarding (${size}): That'll do lands on Speakers`, Boolean(landed));
    }
  });
  // ── Speakers, with nothing cast and then with casts, at every window ──────
  await section('Speakers', async () => {
    await stopEverything();
    for (const size of ['default', 'narrow', 'wide']) {
      const a = await openApp(size);
      await a.goto('/');
      await until(async () => (await roomCards(a)).length > 0);
      await a.shot(`02-speakers-idle-${size}-${tag}`);
      let cards = await roomCards(a);
      check(
        `Speakers (${size}): one card per room`,
        cards.length === lib.ROOMS.length,
        cards.map((c) => c.name),
      );
      check(
        `Speakers (${size}): a grouped room says who it is grouped with`,
        // Office starts grouped with Bathroom; after a cast it may lead Kitchen's group instead.
        cards.some((c) => {
          const other = /^Grouped with (.+)$/.exec(c.sub)?.[1];
          return (
            c.name === 'Office' &&
            cards.some((o) => o.name === other && o.sub === `Grouped with ${c.name}`)
          );
        }),
        cards.map((c) => [c.name, c.sub]),
      );
      check(
        `Speakers (${size}): Stop all casts is hidden while nothing casts`,
        (await button(a, 'Stop all casts').count()) === 0,
      );
      await checkShell(a, 'Speakers', size);
      checkCardHeads(cards, size);

      await cast(a, 'Kitchen,Office');
      await a.page.waitForTimeout(400);
      await a.shot(`03-speakers-casting-${size}-${tag}`);
      cards = await roomCards(a);
      check(
        `Speakers (${size}): casting rooms come first`,
        cards
          .slice(0, 2)
          .map((c) => c.name)
          .join() === 'Kitchen,Office',
        cards.map((c) => [c.name, c.badge]),
      );
      check(
        `Speakers (${size}): both rooms of the cast say Casting`,
        cards.filter((c) => /casting/i.test(c.badge)).length === 2,
        cards.map((c) => [c.name, c.badge]),
      );
      checkCardHeads(cards, size);
      check(
        `Speakers (${size}): Stop all casts shows while something casts`,
        (await button(a, 'Stop all casts').count()) === 1,
      );
      if (size === 'default') {
        await checkAxe(a, 'Speakers while casting');

        // Copy URL: Chromium copies; WebKit's clipboard refuses, and the URL is revealed.
        const [session] = (await sessions()).filter((s) => s.role === 'coordinator');
        const url = `http://127.0.0.1:${process.env.REALEXT_PORT ?? 49410}/stream/${session.streamId}/listen.wav`;
        // The Copy URL in Kitchen's card (the first card holding a Copy URL, as Kitchen casts
        // first).
        const copyButton = a.page.getByRole('button', { name: /^Copy URL/ }).first();
        if ((await copyButton.count()) > 0) await copyButton.click();
        await a.page.waitForTimeout(400);
        const copied =
          engine === 'chromium'
            ? await a.page.evaluate(() => navigator.clipboard.readText().catch((e) => String(e)))
            : null;
        const shown = (await roomCards(a)).find((c) => c.name === 'Kitchen') ?? { text: '' };
        const revealed = await a.page.evaluate(
          (u) =>
            [...document.querySelectorAll('input, [class*="value"]')].some(
              (e) => (e.value ?? e.innerText) === u,
            ),
          url,
        );
        check(
          engine === 'chromium'
            ? 'Copy URL copies the cast URL'
            : 'Copy URL copies the cast URL or reveals it when the clipboard refuses',
          engine === 'chromium' ? copied === url : revealed || /Copied/.test(shown.text),
          { copied, revealed, url, card: shown.text },
        );
        await a.shot(`04-speakers-copied-${tag}`);

        // Stop all casts asks first in a Dialog: Cancel has focus, Esc cancels and focus goes
        // back to the button; Stop ends every cast and the toast row says so.
        const opener = button(a, 'Stop all casts');
        await opener.focus();
        await opener.press('Enter');
        await a.page.waitForTimeout(300);
        let d = await dialogFacts(a);
        check('Stop all casts opens a Dialog', d.open, d);
        if (d.open) {
          await a.shot(`05-stop-all-dialog-${tag}`);
          check('the Dialog starts on Cancel', d.focus === 'Cancel', d);
          await checkAxe(a, 'the Stop all casts Dialog');
          await a.page.keyboard.press('Escape');
          await a.page.waitForTimeout(300);
          d = await dialogFacts(a);
          check(
            'Esc closes the Dialog and nothing stops',
            !d.open && (await sessions()).length > 0,
            d,
          );
          check('focus goes back to Stop all casts', d.focus === 'Stop all casts', d);
          await opener.click();
          await a.page.waitForTimeout(300);
          await a.page
            .locator('dialog[open]')
            .getByRole('button', { name: /^Stop$/ })
            .click();
        } else {
          // Today's app stops at once.
          check('the Dialog starts on Cancel', false, d);
          check('Esc closes the Dialog and nothing stops', false, d);
          check('focus goes back to Stop all casts', false, d);
        }
        const stopped = await until(async () => (await sessions()).length === 0, 5000);
        check('Stop all casts ends every cast', Boolean(stopped), await sessions());
        // The opener goes once nothing casts, so focus moves on; it must land on a control.
        await a.page.waitForTimeout(400);
        const landed = await focusFacts(a);
        check(
          'after Stop all casts, focus lands on a control in the page, not the body',
          landed.inMain && landed.control,
          landed,
        );
        await a.page.waitForTimeout(400);
        const t = await toastFacts(a);
        await a.shot(`06-stop-all-toast-${tag}`);
        check('the toast row says what stopped', t.shown && t.text.includes('Stopped 1 cast.'), t);
        check(
          'the toast sits outside the scroller, clear of focus',
          t.outsideScroller === true && t.clearOfFocus,
          t,
        );
        check(
          'Stop all casts goes once nothing casts',
          (await until(async () => (await button(a, 'Stop all casts').count()) === 0, 3000)) ===
            true,
        );

        // The Toast goes on the next action (M-toast).
        await button(a, 'Ask again').click();
        await a.page.waitForTimeout(300);
        check('the toast goes on the next action (Ask again)', !(await toastFacts(a)).shown);

        // A room the Sonos app groups under a casting room plays our cast too (the core casts
        // on the coordinator only): it says Casting, never "In use".
        await cast(a, 'Bathroom');
        await lib.control('/regroup?member=Office&coordinator=Bathroom');
        const office = await until(async () =>
          (await roomCards(a)).find((c) => c.name === 'Office' && /casting/i.test(c.badge)),
        );
        await a.shot(`06b-speakers-grouped-member-${tag}`);
        check(
          'a room grouped under a casting coordinator says Casting, not In use',
          Boolean(office),
          (await roomCards(a)).map((c) => [c.name, c.sub, c.badge]),
        );
        await stopEverything();
      } else {
        await stopEverything();
      }
    }
  });
  // ── Server ────────────────────────────────────────────────────────────────
  await section('Server', async () => {
    for (const size of ['default', 'narrow']) {
      const a = await openApp(size);
      await a.goto('/server');
      await button(a, 'Disconnect extensions').waitFor();
      await a.page.waitForTimeout(300);
      await a.shot(`07-server-${size}-${tag}`);
      await checkShell(a, 'Server', size);
      const widths = await a.page.evaluate(() =>
        ['Restart Thaumic Cast', 'Disconnect extensions', 'Stop all casts'].map((n) => {
          const b = [...document.querySelectorAll('main button')].find(
            (e) => (e.getAttribute('aria-label') || e.innerText.trim()) === n,
          );
          return b ? Math.round(b.getBoundingClientRect().width * 10) / 10 : null;
        }),
      );
      check(
        `Server (${size}): Restart, Disconnect and Stop are one width`,
        widths.every((w) => w !== null && Math.abs(w - widths[0]) <= 1),
        widths,
      );
      const stop = a.page.locator('main').getByRole('button', { name: 'Stop all casts' });
      check(`Server (${size}): Stop is disabled while nothing casts`, await stop.isDisabled());
      if (size === 'default') {
        await checkAxe(a, 'Server');
        // Copy address: the shown address never changes (owner: it stays host:port), while
        // the clipboard takes the URL a browser or a player can open (§11 call 94).
        const shownAddress = () =>
          a.page.evaluate(() => {
            const v = document.querySelector('main dl span.mono[tabindex="-1"]');
            return v ? v.textContent : null;
          });
        const before = await shownAddress();
        const during = [];
        await a.page
          .getByRole('button', { name: /^Copy address/ })
          .first()
          .click();
        for (let i = 0; i < 8; i++) {
          during.push(await shownAddress());
          await a.page.waitForTimeout(60);
        }
        const copiedAddress =
          engine === 'chromium'
            ? await a.page.evaluate(() => navigator.clipboard.readText().catch((e) => String(e)))
            : null;
        await a.page.waitForTimeout(2400);
        const after = await shownAddress();
        check(
          'Copy address leaves the shown address as it was, before, during and after the copy',
          /^[\d.]+:\d+$/.test(before ?? '') &&
            during.every((v) => v === before) &&
            after === before,
          { before, during, after },
        );
        if (engine === 'chromium')
          check(
            'Copy address copies the http:// URL of the shown address',
            copiedAddress === `http://${before}`,
            { copiedAddress, before },
          );
        await button(a, 'Disconnect extensions').click();
        await a.page.waitForTimeout(300);
        const d = await dialogFacts(a);
        check(
          'Disconnect extensions opens a Dialog',
          d.open && d.title === 'Disconnect extensions',
          d,
        );
        if (d.open) {
          await a.shot(`08-server-disconnect-dialog-${tag}`);
          await a.page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
        }
        await cast(a, 'Study');
        await a.goto('/server');
        await until(async () => !(await stop.isDisabled()));
        await stop.click();
        await a.page.waitForTimeout(300);
        const d2 = await dialogFacts(a);
        check(
          "Server's Stop asks first, as Speakers' does",
          d2.open && d2.title === 'Stop all casts',
          d2,
        );
        if (d2.open)
          await a.page
            .locator('dialog[open]')
            .getByRole('button', { name: /^Stop$/ })
            .click();
        await until(async () => (await sessions()).length === 0, 5000);
        // Stop is disabled once nothing casts, so focus cannot go back to it.
        await until(() => stop.isDisabled(), 3000);
        await a.page.waitForTimeout(400);
        const landed = await focusFacts(a);
        check(
          "after the Server's Stop, focus lands on a control in the page, not the body",
          landed.inMain && landed.control,
          landed,
        );
        await stopEverything();
      }
    }
  });
  // ── Settings ──────────────────────────────────────────────────────────────
  await section('Settings', async () => {
    for (const size of ['default', 'narrow', 'wide']) {
      const a = await openApp(size);
      await a.goto('/settings');
      await a.page.getByRole('heading', { name: 'About' }).waitFor();
      await a.page.waitForTimeout(300);
      await a.shot(`09-settings-${size}-${tag}`);
      await checkShell(a, 'Settings', size);
      const sections = await a.page.evaluate(() => {
        const px = (v) => parseFloat(v) || 0;
        return [...document.querySelectorAll('main section')].map((s) => {
          const grid =
            s.querySelector('[data-settings-grid="section"]') ??
            s.querySelector('[data-settings-grid]');
          const items = grid ? [...grid.children] : [];
          const ends = [...s.querySelectorAll('button[role="switch"], select')]
            .filter((c) => !c.closest('details'))
            .map((c) => Math.round(c.getBoundingClientRect().right * 10) / 10);
          return {
            title: s.querySelector('h2')?.innerText.trim(),
            ends,
            rules: items.map((c, i) => ({
              i,
              what: c.hasAttribute('data-notice') ? 'notice' : c.tagName.toLowerCase(),
              rule: px(getComputedStyle(c).borderBlockStartWidth),
            })),
          };
        });
      });
      const uneven = sections.filter(
        (s) => s.ends.length > 1 && Math.max(...s.ends) - Math.min(...s.ends) > 1,
      );
      check(
        `Settings (${size}): every section's controls end on one edge`,
        uneven.length === 0,
        uneven,
      );
      const badRules = sections.flatMap((s) =>
        s.rules
          .filter((r, i) => {
            const prev = s.rules[i - 1];
            const plain =
              i === 0 ||
              r.what === 'notice' ||
              r.what === 'p' ||
              prev?.what === 'notice' ||
              prev?.what === 'h3';
            return plain ? r.rule !== 0 : r.rule === 0;
          })
          .map((r) => `${s.title} #${r.i} ${r.what} ${r.rule}`),
      );
      check(
        `Settings (${size}): a rule parts each item from the one before, and only there`,
        badRules.length === 0,
        badRules,
      );
      if (size === 'default') {
        await checkAxe(a, 'Settings');
        // Show diagnostics needs speaker monitoring; with it, a casting card shows its reserve.
        const monitor = a.page.getByRole('switch', { name: /^Speaker monitoring/ });
        if (await monitor.isChecked()) await monitor.click();
        await a.page.waitForTimeout(200);
        const diag = a.page.getByRole('switch', { name: /Show diagnostics/ });
        const has = (await diag.count()) === 1;
        check(
          'Show diagnostics is disabled while speaker monitoring is off',
          has && (await diag.isDisabled()),
        );
        await monitor.click();
        await a.page.waitForTimeout(200);
        if (has && !(await diag.isDisabled())) {
          if (!(await diag.isChecked())) await diag.click();
        }
        await a.shot(`10-settings-diagnostics-${tag}`);
        await a.goto('/');
        await cast(a, 'Kitchen');
        await lib.control('/health?room=Kitchen&reserve=380&floor=150&target=1000');
        const meter = await until(
          async () => (await roomCards(a)).find((c) => c.name === 'Kitchen' && c.meter),
          4000,
        );
        await a.shot(`11-speakers-meter-${tag}`);
        check(
          'with diagnostics on, a casting card shows its reserve Meter',
          Boolean(meter),
          (await roomCards(a)).find((c) => c.name === 'Kitchen'),
        );
        await stopEverything();
      }
    }
  });
  // ── Not found ─────────────────────────────────────────────────────────────
  await section('Not found', async () => {
    for (const size of ['default', 'narrow']) {
      const a = await openApp(size);
      await a.goto('/nope');
      await a.page.waitForTimeout(300);
      await a.shot(`12-not-found-${size}-${tag}`);
      const f = await checkShell(a, 'Not found', size);
      check(
        `Not found (${size}): its title is the page heading`,
        f.h1.join() === 'There is no page here',
        f.h1,
      );
      const back = a.page.getByRole('link', { name: 'Back to Speakers' });
      check(`Not found (${size}): Back to Speakers is a link`, (await back.count()) === 1);
      if (size === 'default') {
        await checkAxe(a, 'Not found');
        await back.click();
        const home = await until(() =>
          a.page.evaluate(() => document.querySelector('h1')?.innerText.trim() === 'Speakers'),
        );
        check('Back to Speakers goes to Speakers', Boolean(home));
      }
    }
  });
} catch (e) {
  check('the walk finished', false, String(e.stack ?? e));
} finally {
  if (app) {
    problems.push(...app.problems);
    await app.close();
  }
  server.closeAllConnections();
  server.close();
}

check('no console errors, failed requests or exceptions', problems.length === 0, problems);
const failed = results.filter((r) => r.word === 'FAIL' || r.word === 'XPASS');
const xfail = results.filter((r) => r.word === 'XFAIL').length;
console.log(
  `\n${results.length - failed.length - xfail} passed, ${xfail} expected to fail, ${failed.length} failed (${tag}); shots in ${lib.SHOTS}`,
);
process.exit(failed.length ? 1 : 0);
