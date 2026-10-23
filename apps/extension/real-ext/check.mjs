// The scripted real-extension pass: the built extension in real Chromium, its real toolbar
// popup, against the real companion on the fake household (run.sh starts both). It walks the
// popup through what reviews of the screenshot harness and the catalogue missed, checks each
// outcome, and saves a screenshot per step. Exit 1 on any failure. See README.md.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lib from './lib.mjs';
import { optionsPass } from './options.mjs';
import { roomsPass } from './rooms.mjs';

const scale = Number(process.env.SCALE ?? 1);
const dark = process.env.SCHEME === 'dark';
const tag = `${scale === 1 ? '100' : Math.round(scale * 100)}-${dark ? 'dark' : 'light'}`;
const results = [];

/**
 * Records one check.
 * @param {string} name - What was checked
 * @param {boolean} ok - Whether it held
 * @param {unknown} [detail] - What was seen, printed on failure
 */
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      saw: ${JSON.stringify(detail)}`}`,
  );
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
    await lib.sleep(250);
  }
  return last;
}

/**
 * Saves a screenshot named for this step and this run's scale and scheme.
 * @param {import('./lib.mjs').Target} target - The page
 * @param {string} step - The step's name
 * @returns {Promise<string>} The file
 */
const shot = (target, step) => target.shot(`${step}-${tag}`);

/**
 * Where the CastBar's polite line sits against its button (Cast, or Add in add mode).
 * @param {import('./lib.mjs').Target} target - The popup
 * @returns {Promise<{line: boolean, above?: boolean, l?: number[], c?: number[]}>} The spot
 */
const lineSpot = (target) =>
  target.eval(`const bar = document.querySelector('[data-sticky-bar]');
    const btn = bar && [...bar.querySelectorAll('button')]
      .filter((b) => /Cast|Add \\d/.test(b.innerText)).at(-1);
    const castbar = btn?.closest('[data-sticky-bar] > *');
    const ps = castbar ? [...castbar.querySelectorAll(':scope > p')] : [];
    if (!ps.length) return { line: false };
    const l = ps[0].getBoundingClientRect(), c = btn.getBoundingClientRect();
    // Above in the page, and before Cast in the reading order, so its place never depends on
    // whether the scroller scrolls.
    const before = Boolean(ps[0].compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { line: true, above: l.bottom <= c.top + 0.5 && before, before,
      l: [l.top, l.bottom], c: [c.top, c.bottom] }`);

/**
 * Every cast row's Slider, its inline start and end, its state and whether it has Remove.
 * @param {import('./lib.mjs').Target} target - The popup
 * @returns {Promise<{name: string, busy: boolean, remove: boolean, l: number, r: number}[]>} The rows
 */
const rowColumns = (target) =>
  target.eval(`return [...document.querySelectorAll('[role=group][aria-label]')]
    .map((g) => [g, g.querySelector('input[type=range]')]).filter(([, i]) => i)
    .map(([g, i]) => { const r = i.getBoundingClientRect();
      return { name: g.getAttribute('aria-label'), busy: g.getAttribute('aria-busy') === 'true',
        remove: !!g.querySelector('button[aria-label^="Remove"]'), l: r.left, r: r.right }; })`);

/**
 * Whether every row's Slider starts and ends at one place.
 * @param {{l: number, r: number}[]} rows - The rows
 * @returns {boolean} They line up
 */
const lined = (rows) =>
  Array.isArray(rows) &&
  rows.length > 1 &&
  rows.every((x) => Math.abs(x.l - rows[0].l) <= 0.5 && Math.abs(x.r - rows[0].r) <= 0.5);

/**
 * Where an open tile's Stop sits: from the card's top and end, whether its middle is the head
 * row's (the artwork's), and whether it is on the band.
 * @param {import('./lib.mjs').Target} target - The popup
 * @returns {Promise<{top: number, end: number, row: boolean, onBand: boolean, red: boolean} | null>} The spot
 */
const stopSpot = (target) =>
  target.eval(`const stop = document.querySelector('section button[aria-label^="Stop"]');
    const card = stop?.closest('section');
    const art = card?.querySelector('[class*="artwork"]');
    const band = card?.querySelector('[style*="--art-h"]');
    if (!stop || !art || !band) return null;
    const c = card.getBoundingClientRect(), s = stop.getBoundingClientRect();
    const a = art.getBoundingClientRect(), b = band.getBoundingClientRect();
    return { top: Math.round(s.top - c.top), end: Math.round(c.right - s.right),
      row: Math.abs(s.top + s.height / 2 - (a.top + a.height / 2)) <= 1,
      onBand: s.top >= b.top && s.bottom <= b.bottom && s.right <= b.right,
      red: band.matches('[class*="_red-guard_"]') }`);

const tone = lib.serveTone();
const env = await lib.launch({ profile: `check-${tag}`, scale });
const problems = [];

/**
 * Records every toolbar icon the background sets, and whether Chrome took it. Chrome has no
 * getter for the action's icon and the toolbar is not in a screenshot, so the rig watches the
 * calls the service worker makes and lets each one through to the real chrome.action.setIcon.
 * @returns {Promise<void>} Resolves once watching
 */
const watchIcons = () =>
  env.sw.evaluate(() => {
    if (globalThis.__iconCalls) return;
    const calls = (globalThis.__iconCalls = []);
    const real = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = (details) => {
      const call = { p16: details.path?.['16'] ?? null, ok: null };
      calls.push(call);
      return real(details).then(
        () => void (call.ok = true),
        (e) => {
          call.ok = String(e?.message ?? e);
          throw e;
        },
      );
    };
  });

/**
 * The 16 px file the background sets: the dark set on a dark toolbar, else the manifest icon
 * and its lit twin.
 * @param {boolean} lit - A cast is running
 * @param {boolean} darkIcon - The dark toolbar's ink
 * @returns {string} The file
 */
const iconFile = (lit, darkIcon) =>
  darkIcon
    ? `icons/action-dark-${lit ? 'lit' : 'idle'}-16.png`
    : `icons/action${lit ? '-lit' : ''}-16.png`;

/**
 * Waits until the last icon set is the one for this state and theme, and Chrome took it.
 * @param {boolean} lit - A cast is running
 * @param {boolean} darkIcon - The dark toolbar's ink
 * @returns {Promise<object|null>} The last call seen
 */
const iconIs = async (lit, darkIcon) => {
  const want = iconFile(lit, darkIcon);
  let last = null;
  await until(async () => {
    last = await env.sw.evaluate(() => globalThis.__iconCalls?.at(-1) ?? null);
    return last?.p16 === want && last.ok === true;
  });
  return last;
};
const iconOk = (last, lit, darkIcon) => last?.p16 === iconFile(lit, darkIcon) && last.ok === true;

try {
  await watchIcons();
  // The household: Bathroom + Office grouped and playing; Office's own level is 23, below
  // the start cap, so joining a cast never changes it; its first RenderingControl event is
  // dropped, as the subscribe race drops it on real speakers.
  await lib.control('/play_music?room=Bathroom');
  await lib.control('/volume?room=Office&v=23');
  await lib.control('/knobs?initial_rc=0');

  const tab = await env.audioTab();
  let p = await env.popup({ dark });

  // ── Onboarding ────────────────────────────────────────────────────────
  await shot(p, '01-onboarding');
  const ground = await p.eval(`return [getComputedStyle(document.documentElement).backgroundColor,
    getComputedStyle(document.body).backgroundColor]`);
  check(
    'the root paints the ground, so its gutters are not white',
    ground[0] === ground[1],
    ground,
  );
  const onboardingFit = await p.eval(`const h = document.documentElement, b = document.body;
    return { clip: getComputedStyle(h).overflowY === 'clip', sh: h.scrollHeight, ch: h.clientHeight,
      bsh: b.scrollHeight, bch: b.clientHeight, max: innerHeight }`);
  check(
    'the onboarding does not scroll in the popup it sized',
    (onboardingFit.clip || onboardingFit.sh <= onboardingFit.ch) &&
      (onboardingFit.bsh <= onboardingFit.bch || onboardingFit.max >= 600),
    onboardingFit,
  );
  const onboardingRow = await p.eval(`const b = document.body.getBoundingClientRect();
    const go = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Carry on');
    const row = go.parentElement.getBoundingClientRect();
    return { vw: innerWidth, body: [b.left, b.right], start: row.left, end: innerWidth - row.right }`);
  check(
    'the onboarding fills the popup and sits between equal margins',
    onboardingRow.body[0] === 0 &&
      Math.abs(onboardingRow.body[1] - onboardingRow.vw) < 1 &&
      Math.abs(onboardingRow.start - onboardingRow.end) < 1,
    onboardingRow,
  );
  // The onboarding is the main popup's frame (L-wizard): one block size on every step, its
  // header row as tall as the PopupHeader, the step in a Card on the main popup's card edges
  // with its parts on the cards' content edge, and Skip and Carry on in a bar with the Cast
  // bar's box. Measured on every step and state, compared with the main popup below.
  const onbGeo = (state) =>
    p.eval(
      `const box = (e) => { const b = e.getBoundingClientRect();
        return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height }; };
      const dialog = document.querySelector('[role=dialog]');
      const shell = dialog.querySelector('[data-scroller]');
      // A frame that is not a PopupShell with its step in a Card fails the checks below.
      const main = shell?.querySelector('main');
      if (!main || !main.firstElementChild?.querySelector('h2')) {
        return { state: args.state, missing: true, vh: innerHeight,
          h: Math.round(box(dialog).h) };
      }
      const head = shell.firstElementChild;
      const card = main.firstElementChild, cs = getComputedStyle(card);
      const c = box(card);
      const cin = { l: c.l + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
        r: c.r - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) };
      const step = card.querySelector('h2').closest('div:has(> div > div > h2)');
      const parts = [step.children[0], ...step.children[1].children].map((e) => ({
        what: e.tagName + ':' + e.textContent.trim().slice(0, 24), ...box(e) }));
      const bar = shell.querySelector('[data-sticky-bar]'), bs = getComputedStyle(bar);
      const buttons = [...bar.querySelectorAll('button')];
      const go = buttons.find((b) => /Carry on|That/.test(b.innerText));
      const skip = buttons.find((b) => b.innerText.includes('Skip'));
      // Skip is flush: its words, not its box, sit on the edge.
      const words = document.createRange();
      words.selectNodeContents(skip);
      const back = head.querySelector('button');
      const ind = box(head.querySelector('[role=progressbar]'));
      return { state: args.state, vh: innerHeight, h: Math.round(box(dialog).h),
        head: box(head), back: back ? box(back) : null, ind: (ind.l + ind.r) / 2, card: c, cin, parts,
        bar: { ...box(bar), pt: bs.paddingTop, pb: bs.paddingBottom, bg: bs.backgroundColor },
        go: box(go), skip: box(words), skipBox: box(skip),
        disc: step.children[0].children.length > 1 ? box(step.children[0].firstElementChild) : null,
        title: box(card.querySelector('h2')) }`,
      { state },
    );
  const frames = [await onbGeo('welcome')];
  await p.click('button', 'Carry on');
  await until(async () => (await p.text()).includes('answered'));
  await lib.sleep(800);
  frames.push(await onbGeo('companion found'));
  await shot(p, '01b-onboarding-companion');
  // No companion at the address: the not-found state, then the address given by hand.
  await env.sw.evaluate(() =>
    chrome.storage.local.get('extensionSettings').then((r) =>
      chrome.storage.local.set({
        extensionSettings: {
          ...r.extensionSettings,
          useAutoDiscover: false,
          serverUrl: 'http://127.0.0.1:1',
        },
      }),
    ),
  );
  await lib.sleep(1500);
  p = await env.popup({ dark });
  await p.click('button', 'Carry on');
  const notFound = await until(async () => (await p.text()).includes('Look again'), 30000);
  check('with nothing at the address the companion step says so', Boolean(notFound));
  await lib.sleep(800);
  frames.push(await onbGeo('companion not found'));
  await shot(p, '01c-onboarding-not-found');
  await p.click('summary', 'Enter the address yourself');
  await lib.sleep(800);
  frames.push(await onbGeo('companion manual address'));
  await p.eval(`document.querySelector('[role=dialog] input').focus()`);
  await p.type('http://127.0.0.1:49400');
  await shot(p, '01d-onboarding-manual');
  await p.click('button', 'Connect');
  const manual = await until(async () => !(await p.text()).includes('Look again'), 15000);
  check('the address given by hand connects', Boolean(manual), await p.text());
  await lib.sleep(800);
  frames.push(await onbGeo('companion connected by hand'));
  await shot(p, '01e-onboarding-manual-connected');
  await p.click('button', 'Carry on');
  const speakers = await until(async () => {
    const text = await p.text();
    return text.includes('answered') && text.includes('Office') && text;
  }, 10000);
  await shot(p, '02-onboarding-speakers');
  check(
    'onboarding lists each room and counts rooms',
    /6 rooms answered/.test(speakers) && /\nOffice\n/.test(speakers) && !speakers.includes('+1'),
    speakers,
  );
  frames.push(await onbGeo('speakers'));
  await p.click('button', 'Carry on').catch(() => {});
  await lib.sleep(800);
  frames.push(await onbGeo('ready'));
  await shot(p, '02b-onboarding-ready');
  check(
    'the onboarding popup keeps one block size on every step',
    frames.every((f) => f.vh === frames[0].vh && f.h === frames[0].h),
    frames.map((f) => [f.state, f.vh, f.h]),
  );
  await p.click('button', 'That').catch(() => {});
  await lib.sleep(1500);
  // Back to finding the companion by itself, for the rest of the walk.
  await env.sw.evaluate(() =>
    chrome.storage.local.get('extensionSettings').then((r) =>
      chrome.storage.local.set({
        extensionSettings: { ...r.extensionSettings, useAutoDiscover: true, serverUrl: null },
      }),
    ),
  );
  await lib.sleep(1500);

  // ── The main popup ────────────────────────────────────────────────────
  p = await env.popup({ dark });
  await shot(p, '03-main');
  const m = await p.eval(lib.METRICS);
  const shell = m.scrollers.find((s) => s.overflowY === 'auto');
  check(
    'header and main share one column',
    m.header && m.main && m.header.x === m.main.x && m.header.w === m.main.w,
    { header: m.header, main: m.main },
  );
  // The main popup's reference: its header, its first card and that card's content edge
  // (where the TabCard's MediaHeader starts), its bar and Cast.
  const ref = await p.eval(`const box = (e) => { const b = e.getBoundingClientRect();
      return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height }; };
    const card = document.querySelector('main').firstElementChild;
    const media = box(card.querySelector('[class*="_media_"]'));
    const bar = document.querySelector('[data-sticky-bar]'), bs = getComputedStyle(bar);
    const cast = [...bar.querySelectorAll('button')].find((b) => b.innerText.includes('Cast'));
    return { head: box(document.querySelector('header')), card: box(card),
      cin: { l: media.l, r: media.r },
      bar: { ...box(bar), pt: bs.paddingTop, pb: bs.paddingBottom, bg: bs.backgroundColor },
      cast: box(cast) }`);
  // The live dot is for sound going out to speakers (§11 call 94): this tab plays, but it is
  // not casting, so its TabCard shows none.
  const tabLive = await p.eval(`const card = document.querySelector('main').firstElementChild;
    return card.querySelectorAll('[class*="_live_"]').length`);
  check('the TabCard shows no live dot while this tab is not casting', tabLive === 0, tabLive);
  const near = (a, b) => Math.abs(a - b) <= 0.5;
  const off = (test) =>
    frames
      .filter((f) => {
        try {
          return !test(f);
        } catch {
          return true;
        }
      })
      .map((f) => f.state);
  const cardOff = off(
    (f) => near(f.card.l, ref.card.l) && near(f.card.r, ref.card.r) && near(f.card.t, ref.card.t),
  );
  check(
    "every onboarding step's Card takes the main popup's card edges and starts where it does",
    cardOff.length === 0,
    { cardOff, ref: ref.card, frames: frames.map((f) => [f.state, f.card]) },
  );
  const edgeOff = frames.flatMap((f) =>
    (f.missing
      ? [{ what: 'no Card', l: NaN, r: NaN }]
      : [{ what: 'card content', l: f.cin.l, r: f.cin.r }, ...f.parts]
    )
      .filter((x) => !near(x.l, ref.cin.l) || !near(x.r, ref.cin.r))
      .map((x) => [f.state, x.what, x.l, x.r]),
  );
  check(
    "every onboarding step's header and body sit on the main popup's content edge",
    edgeOff.length === 0,
    { edgeOff, ref: ref.cin },
  );
  const headOff = off(
    (f) =>
      near(f.head.l, ref.head.l) &&
      near(f.head.r, ref.head.r) &&
      near(f.head.t, ref.head.t) &&
      near(f.head.h, ref.head.h) &&
      near(f.ind, (f.head.l + f.head.r) / 2) &&
      (f.back === null || near(f.back.l, ref.head.l)),
  );
  check(
    "the onboarding's Back and step indicator sit in a row the PopupHeader's size",
    headOff.length === 0 && frames.slice(1).every((f) => f.back !== null),
    { headOff, ref: ref.head, frames: frames.map((f) => [f.state, f.head, f.back, f.ind]) },
  );
  const discOff = off((f) => f.disc === null || Math.abs(f.disc.t - f.title.t) <= 1);
  check(
    "every onboarding step's disc starts with its title, however the title wraps",
    discOff.length === 0,
    { discOff, frames: frames.map((f) => [f.state, f.disc?.t, f.title.t, f.title.h]) },
  );
  const barOff = off(
    (f) =>
      near(f.bar.l, ref.bar.l) &&
      near(f.bar.r, ref.bar.r) &&
      near(f.bar.h, ref.bar.h) &&
      f.bar.pt === ref.bar.pt &&
      f.bar.pb === ref.bar.pb &&
      f.bar.bg === ref.bar.bg &&
      near(f.go.r, ref.cast.r) &&
      near(f.skip.l, ref.cin.l) &&
      // Skip's 4 px focus ring stays inside the bar's edge, clear of the popup's.
      f.skipBox.l - 4 >= ref.bar.l + 0.5,
  );
  check(
    "the onboarding's Skip and Carry on bar has the Cast bar's box and edges, Skip's words on the text edge",
    barOff.length === 0,
    {
      barOff,
      ref: { bar: ref.bar, cast: ref.cast },
      frames: frames.map((f) => [f.state, f.bar, f.go, f.skip]),
    },
  );
  check(
    'the content sits between equal margins',
    shell && Math.abs(m.main.x - shell.x - (shell.right - m.main.right)) < 1,
    { shell, main: m.main },
  );
  check(
    'the shell reserves its gutter on both edges',
    shell?.gutter === 'stable both-edges',
    shell,
  );
  const thin = await p.eval(
    `return getComputedStyle(document.querySelector('[data-scroller] [data-scroller]')).scrollbarWidth`,
  );
  check('scrollbars are thin', thin === 'thin', thin);
  check(
    'the document never scrolls past the popup',
    m.html.overflowY === 'clip' || m.html.sh <= m.html.ch,
    m.html,
  );
  const barSlots = await p.eval(`const bar = document.querySelector('[data-sticky-bar]');
    const cast = [...bar.querySelectorAll('button')].find((b) => b.innerText.includes('Cast'));
    const ps = [...bar.querySelectorAll('p')];
    const end = bar.getBoundingClientRect().bottom - parseFloat(getComputedStyle(bar).paddingBottom);
    return { empty: ps.filter((x) => !x.innerText.trim()).length, lines: ps.length,
      gap: Math.round(end - cast.getBoundingClientRect().bottom) }`);
  check(
    'the CastBar keeps no empty line under Cast',
    barSlots.empty === 0 && (barSlots.lines > 0 || barSlots.gap === 0),
    barSlots,
  );
  const chosen = await p.eval(`return [...document.querySelectorAll('input[type=checkbox]:checked')]
    .map((c) => c.closest('label')?.innerText.split('\\n')[0].trim())`);
  check('the first choice is a free room alone in its group', chosen.join() === 'Bedroom', chosen);

  // ── A room row takes the octagon on press and on focus, as every pressable does ──
  const rowShape = `const l = [...document.querySelectorAll('label')]
      .find((x) => x.innerText.split('\\n')[0].trim() === 'Living Room');
    const cs = getComputedStyle(l);
    return cs.getPropertyValue('corner-top-left-shape').trim() || 'none';`;
  const row = await p.eval(`const l = [...document.querySelectorAll('label')]
      .find((x) => x.innerText.split('\\n')[0].trim() === 'Living Room');
    l.scrollIntoView({ block: 'nearest' });
    const r = l.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`);
  const restShape = await p.eval(rowShape);
  await p.mouse('mouseMoved', row.x, row.y);
  await p.mouse('mousePressed', row.x, row.y);
  await lib.sleep(400);
  const pressShape = await p.eval(rowShape);
  await shot(p, '03b-row-pressed');
  // Let go off the row, so the press does not tick it.
  await p.mouse('mouseMoved', 2, 2);
  await p.mouse('mouseReleased', 2, 2);
  await lib.sleep(500);
  const focusShape = await p.eval(`const l = [...document.querySelectorAll('label')]
      .find((x) => x.innerText.split('\\n')[0].trim() === 'Living Room');
    l.querySelector('input').focus({ focusVisible: true });
    await new Promise((r) => setTimeout(r, 400));
    const shape = getComputedStyle(l).getPropertyValue('corner-top-left-shape').trim() || 'none';
    l.querySelector('input').blur();
    return shape`);
  check(
    'a room row rests round and takes the octagon on press and on focus',
    restShape !== pressShape &&
      /superellipse\(0\)|bevel/.test(pressShape) &&
      /superellipse\(0\)|bevel/.test(focusShape),
    { restShape, pressShape, focusShape },
  );
  const stillOff = await p.eval(`return [...document.querySelectorAll('label')]
    .find((x) => x.innerText.split('\\n')[0].trim() === 'Living Room').querySelector('input').checked`);
  check('a press let go off the row does not tick it', stillOff === false, stillOff);

  // ── In a short popup the CastBar's line sits above Cast too ───────────
  // The popup is shorter than its tallest here (no sets yet), so it grows downward, here as
  // far as its tallest.
  // The press let go off the row above left a text selection: clear it for the shots.
  const shortH = await p.eval(`getSelection().removeAllRanges(); return innerHeight`);
  // Each frame's Cast top from the click on: the line and the save offer open in place, so
  // Cast eases down with the popup rather than dropping in one frame.
  await p.eval(`window.__castY = []; const t0 = performance.now();
    const f = () => { const b = [...document.querySelectorAll('[data-sticky-bar] button')]
        .find((x) => x.innerText.includes('Cast'));
      window.__castY.push(b.getBoundingClientRect().top);
      if (performance.now() - t0 < 1200) requestAnimationFrame(f); };
    requestAnimationFrame(f);`);
  await p.clickRoom('Office');
  const shortLine = await until(async () => {
    const spot = await lineSpot(p);
    return spot.line && spot;
  }, 3000);
  await lib.sleep(600);
  await shot(p, '03c-castbar-line-short');
  const castY = await p.eval(`return window.__castY`);
  const castMoved = castY.at(-1) - castY[0];
  const castStep = Math.max(...castY.slice(1).map((y, i) => Math.abs(y - castY[i])));
  check(
    'in a short popup Cast eases down as the line opens, never dropping in one frame',
    castMoved > 8 && castStep <= castMoved * 0.4,
    { castMoved, castStep, frames: castY.length },
  );
  check(
    'in a short popup the CastBar line sits above Cast',
    shortH < 600 && shortLine?.line && shortLine.above,
    { shortH, shortLine },
  );
  await p.clickRoom('Office');
  await lib.sleep(600);

  // ── Saving a set (one row, one selected) ──────────────────────────────
  await p.clickRoom('Kitchen');
  await p.clickRoom('Study');
  await p.click('button', 'Save these rooms as a set');
  await lib.sleep(300);
  await p.type('guff');
  await p.key('Enter');
  // Enter saved it; a second submit (Save, if the form were still open) must not add it twice.
  await p.click('form button[type=submit]', 'Save').catch(() => {});
  await lib.sleep(800);
  await shot(p, '04-set-saved');
  const sets = await p.eval(`return [...document.querySelectorAll('button[aria-pressed]')]
    .map((b) => b.innerText.split('\\n')[0].trim() + (b.getAttribute('aria-pressed') === 'true' ? '*' : ''))`);
  check('a new set is listed once', sets.filter((s) => s.startsWith('guff')).length === 1, sets);
  check('exactly one set row is selected', sets.filter((s) => s.endsWith('*')).length === 1, sets);

  // ── The CastBar's line sits above Cast, in every state ────────────────
  // It opens in place above Cast. A popup at its tallest grows the bar upward, so Cast
  // stays put; a shorter popup grows downward, Cast easing down with the line.
  const barNow = () =>
    p.eval(`const b = [...document.querySelectorAll('[data-sticky-bar] button')]
      .find((x) => x.innerText.includes('Cast'));
    const s = document.querySelector('[data-scroller]');
    return { y: Math.round(b.getBoundingClientRect().top), h: innerHeight,
      max: s.scrollHeight > s.clientHeight || innerHeight >= 600,
      line: document.querySelectorAll('[data-sticky-bar] p').length }`);
  const before = await barNow();
  // Each frame's line height from the click on: it must open from 0, not snap to its words.
  await p.eval(`window.__lineH = []; const t0 = performance.now();
    const f = () => { const l = document.querySelector('[data-sticky-bar] p');
      window.__lineH.push(l ? l.getBoundingClientRect().height : 0);
      if (performance.now() - t0 < 1500) requestAnimationFrame(f); };
    requestAnimationFrame(f);`);
  await p.clickRoom('Office');
  await until(async () => (await barNow()).line > 0, 3000);
  await lib.sleep(1000);
  const withLine = await barNow();
  const lineH = await p.eval(`return window.__lineH`);
  const opened = lineH.filter((h) => h > 0);
  const fullH = Math.max(...lineH);
  check(
    'the CastBar line eases open from 0 rather than snapping',
    opened.length >= 4 &&
      opened[0] < fullH / 2 &&
      opened.filter((h) => h < fullH - 0.5).length >= 3,
    { first: opened.slice(0, 8).map((h) => Math.round(h * 10) / 10), fullH },
  );
  const shortSpot = await lineSpot(p);
  await shot(p, '04b-castbar-line');
  await p.clickRoom('Office');
  await lib.sleep(600);
  const after = await barNow();
  check(
    'at full height the CastBar line sits above Cast',
    shortSpot.line && shortSpot.above,
    shortSpot,
  );
  check(
    'Cast stays put at full height as the line comes, and goes back when it goes',
    withLine.line > 0 &&
      (!before.max || Math.abs(withLine.y - before.y) <= 1) &&
      Math.abs(after.y - before.y) <= 1,
    { before, withLine, after },
  );

  // ── The toolbar icon follows the theme the offscreen document reports ──
  // The offscreen document reports prefers-color-scheme; emulate the other scheme there and
  // then this run's, so the icon is set for both.
  const offscreen = await env.offscreen();
  await offscreen.scheme(!dark);
  const otherIdle = await iconIs(false, !dark);
  await offscreen.scheme(dark);
  const ownIdle = await iconIs(false, dark);
  check(
    "with no cast the toolbar icon is the outline, in each toolbar's ink",
    iconOk(otherIdle, false, !dark) && iconOk(ownIdle, false, dark),
    { otherIdle, ownIdle },
  );

  // ── Casting, then adding a grouped room ───────────────────────────────
  await p.clickRoom('Bedroom');
  await p.clickRoom('Study');
  await p.click('button', 'Cast to');
  await until(async () => (await p.text()).includes('Casting now'));
  await shot(p, '05-casting');
  const litIcon = await iconIs(true, dark);
  check('while a cast runs the toolbar icon is lit', iconOk(litIcon, true, dark), litIcon);
  await offscreen.scheme(!dark);
  const otherLit = await iconIs(true, !dark);
  await offscreen.scheme(dark);
  const ownLit = await iconIs(true, dark);
  check(
    'a lit toolbar icon follows a change of theme',
    iconOk(otherLit, true, !dark) && iconOk(ownLit, true, dark),
    { otherLit, ownLit },
  );
  const stopInset = await p.eval(`const stop = document.querySelector('button[aria-label^="Stop"]');
    const card = stop.closest('section');
    return Math.round(card.getBoundingClientRect().right - stop.getBoundingClientRect().right)`);
  check('the open tile keeps Stop inside the card, as compact', stopInset >= 12, stopInset);
  const otherBandStop = await stopSpot(p);
  const goHere = await p.eval(`return [...document.querySelectorAll('button')]
    .filter((b) => (b.getAttribute('aria-label') || b.innerText).startsWith('Go to tab')).length`);
  check("on the cast's own tab its tile has no Go to tab", goHere === 0, goHere);
  const bleed = await p.eval(`const band = document.querySelector('section [style*="--art-h"]');
    if (!band) return null;
    const card = band.closest('section'), c = card.getBoundingClientRect(), cs = getComputedStyle(card);
    const b = band.getBoundingClientRect(), edge = parseFloat(cs.borderTopWidth);
    return { start: b.left - c.left - edge, top: b.top - c.top - edge, end: c.right - edge - b.right }`);
  check(
    "the open tile's band bleeds to the card's top and sides",
    bleed !== null && [bleed.start, bleed.top, bleed.end].every((d) => Math.abs(d) < 0.5),
    bleed,
  );

  await p.click('button', 'Add a room');
  await lib.sleep(500);
  const addEdge = await p.eval(`const b = [...document.querySelectorAll('button')]
      .find((x) => x.innerText.trim() === 'Add a room');
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.left + 1, r.top + r.height / 2)?.closest('button') === b`);
  check('Add a room is whole at its start edge', addEdge === true, addEdge);
  await shot(p, '06-add-mode');
  await p.clickRoom('Office');
  const addSpot = await until(async () => {
    const spot = await lineSpot(p);
    return spot.line && spot;
  }, 3000);
  await lib.sleep(400);
  await shot(p, '06b-add-mode-line');
  check('in add mode the line sits above Add', addSpot?.line && addSpot.above, addSpot);
  await p.click('button', 'Add 1 room');
  const office = await until(async () => {
    const r = (await p.ranges()).find((x) => x.startsWith('Office volume'));
    return r === 'Office volume=23' && r;
  }, 8000);
  await shot(p, '07-office-joined');
  check(
    'an added room shows its level with no event from it',
    office === 'Office volume=23',
    await p.ranges(),
  );

  // ── A second tab ──────────────────────────────────────────────────────
  const tab2 = await env.audioTab(await env.ctx.newPage());
  const p2 = await env.popup({ dark });
  await shot(p2, '08-second-tab');
  const goThere = await p2.eval(`return [...document.querySelectorAll('button')]
    .filter((b) => (b.getAttribute('aria-label') || b.innerText).startsWith('Go to tab')).length`);
  check("from another tab, the cast's tile has Go to tab", goThere === 1, goThere);
  const chosen2 =
    await p2.eval(`return [...document.querySelectorAll('input[type=checkbox]:checked')]
    .map((c) => c.closest('label')?.innerText.split('\\n')[0].trim())`);
  check(
    'a second tab does not preselect rooms another cast holds',
    !chosen2.includes('Kitchen') && !chosen2.includes('Office'),
    chosen2,
  );
  // With a cast running (the popup at its tallest), a choice's line still sits above Cast.
  const castBefore =
    await p2.eval(`return Math.round([...document.querySelectorAll('[data-sticky-bar] button')]
    .find((x) => x.innerText.includes('Cast')).getBoundingClientRect().top)`);
  await p2.clickRoom('Bathroom');
  const tabSpot = await until(async () => {
    const spot = await lineSpot(p2);
    return spot.line && spot;
  }, 3000);
  await lib.sleep(600);
  await shot(p2, '08b-second-tab-line');
  const castAfter =
    await p2.eval(`return Math.round([...document.querySelectorAll('[data-sticky-bar] button')]
    .find((x) => x.innerText.includes('Cast')).getBoundingClientRect().top)`);
  check(
    'with a cast running, the line sits above Cast and Cast stays put',
    tabSpot?.line && tabSpot.above && Math.abs(castAfter - castBefore) <= 1,
    { tabSpot, castBefore, castAfter },
  );
  await p2.clickRoom('Bathroom');
  await lib.sleep(400);
  problems.push(...p2.problems);
  p2.close();
  await tab2.close();
  await tab.bringToFront();

  // ── A speaker drops off the network, and is removed ───────────────────
  p = await env.popup({ dark });
  await lib.control('/vanish?room=Office');
  const gone = await until(async () => {
    const text = await p.text();
    return text.includes('Office is not answering') && text.includes('Not answering');
  }, 8000);
  await shot(p, '09-office-gone');
  check('a speaker gone from the household is said on its cast', gone === true, await p.text());

  if (await p.eval(`return document.querySelector('details')?.open === false`)) {
    await p.click('summary', '2 rooms');
    await lib.sleep(400);
  }
  await p.click('button[aria-label^="Remove Office"]');
  const barBg = await until(() =>
    p.eval(`const bar = document.querySelector('[data-sticky-bar]');
      return bar && [getComputedStyle(bar).backgroundColor, getComputedStyle(document.body).backgroundColor]`),
  );
  await shot(p, '10-undo-toast');
  check('a Toast with no bar sits on the ground', barBg && barBg[0] === barBg[1], barBg);

  await p.click('button[aria-label^="Stop"]');
  await lib.sleep(1500);
  const outIcon = await iconIs(false, dark);
  check('once the cast stops the toolbar icon goes out', iconOk(outIcon, false, dark), outIcon);
  problems.push(...p.problems);
  offscreen.close();
  p.close();

  // ── Joining rows line up with the room playing alone ──────────────────
  // One room plays, without Remove (Stop ends it); two are added and answer slowly, so they
  // stay Joining…. Every row's Slider must start and end at one place.
  p = await env.popup({ dark });
  const ticked = await p.eval(`return [...document.querySelectorAll('input[type=checkbox]:checked')]
    .map((c) => c.closest('label').innerText.split('\\n')[0].trim())`);
  for (const name of ticked) await p.clickRoom(name);
  await p.clickRoom('Living Room');
  await p.click('button', 'Cast to');
  await until(async () => (await p.text()).includes('Casting now'));
  // A cast's only room keeps no empty Remove slot (§11 call 94): checked against the master
  // below, which runs the card's full width.
  const lone = await until(async () => {
    const rows = await rowColumns(p);
    return rows.length === 1 && rows[0];
  });
  await shot(p, '09a-one-room');
  await p.click('button', 'Add a room');
  await lib.sleep(500);
  await p.clickRoom('Kitchen');
  await p.clickRoom('Study');
  await lib.control('/slow?room=Kitchen&action=SetAVTransportURI&ms=6000');
  await lib.control('/slow?room=Study&action=SetAVTransportURI&ms=6000');
  await p.click('button', 'Add 2 rooms');
  const joiningRows = await until(async () => {
    await p.eval(`const d = document.querySelector('details');
      if (d && !d.open) d.querySelector('summary').click()`);
    const rows = await rowColumns(p);
    return (
      rows.filter((r) => r.busy).length === 2 && rows.some((r) => !r.busy && !r.remove) && rows
    );
  }, 5000);
  await lib.sleep(400);
  await shot(p, '09b-joining-rows');
  check(
    "every cast row's slider starts and ends at one place, joining or alone without Remove",
    lined(joiningRows),
    joiningRows,
  );
  await lib.control('/slow?room=Kitchen&action=SetAVTransportURI&ms=0');
  await lib.control('/slow?room=Study&action=SetAVTransportURI&ms=0');
  const joinedRows = await until(async () => {
    const rows = await rowColumns(p);
    return rows.length === 3 && rows.every((r) => !r.busy && r.remove) && rows;
  }, 12000);
  check(
    'once joined, with Remove on every row, the sliders still line up',
    lined(joinedRows),
    joinedRows,
  );
  // The master above the fold runs the card's full width (§11 call 94): it starts where the
  // rooms' sliders do and ends past them, as it has no Remove slot to keep.
  const masterCol = await p.eval(`const row = document.querySelector('[role=group][aria-label]');
    const card = row?.closest('section, article, [class*="_card_"]');
    const m = card && [...card.querySelectorAll('input[type=range]')]
      .find((i) => !i.closest('[role=group][aria-label]'));
    const r = m?.getBoundingClientRect();
    return r ? { l: r.left, r: r.right } : null`);
  const firstRow = Array.isArray(joinedRows) ? joinedRows[0] : null;
  check(
    "the master's slider starts where the rooms' do and runs past their end, the full width",
    masterCol !== null &&
      firstRow !== null &&
      Math.abs(masterCol.l - firstRow.l) <= 0.5 &&
      masterCol.r - firstRow.r >= 24,
    { masterCol, row: firstRow },
  );
  check(
    "a cast's only room has its slider run the full width, as the master's does",
    Boolean(lone) &&
      masterCol !== null &&
      firstRow !== null &&
      Math.abs(lone.l - firstRow.l) <= 0.5 &&
      Math.abs(lone.r - masterCol.r) <= 0.5,
    { lone, masterCol, row: firstRow },
  );
  await p.click('button[aria-label^="Stop"]');
  await lib.sleep(1500);
  problems.push(...p.problems);
  p.close();

  // ── One room on a red band: Stop stays in the head row ────────────────
  // A red artwork sets the red guard. Stop once moved under the band, onto its own line, so
  // a one-room cast of "Titanium" had it there and a two-room cast beside the title (§11
  // call 94). It sits at one spot on every band.
  await env.audioTab(tab, '?red');
  p = await env.popup({ dark });
  for (const name of await p.eval(`return [...document.querySelectorAll('input[type=checkbox]:checked')]
    .map((c) => c.closest('label').innerText.split('\\n')[0].trim())`))
    await p.clickRoom(name);
  await p.clickRoom('Living Room');
  await p.click('button', 'Cast to');
  const redStop = await until(async () => {
    const spot = (await p.text()).includes('Casting now') && (await stopSpot(p));
    return spot?.red && spot;
  }, 8000);
  await lib.sleep(400);
  await shot(p, '09c-one-room-red-band');
  check(
    'on a red band Stop stays in the head row, at the spot it has on another band',
    Boolean(redStop?.red && redStop.row && redStop.onBand) &&
      otherBandStop !== null &&
      redStop.top === otherBandStop.top &&
      redStop.end === otherBandStop.end,
    { redStop, otherBandStop },
  );

  // ── A new track's band fades to its colour (§11 call 99) ──────────────
  // The owner saw the band jump when the artwork changed. The page plays a new track with the
  // teal artwork; the band, sampled every frame, must pass through colours that are neither end
  // over about --dur-change, never moving most of the way in one frame.
  await p.eval(`const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = (c) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = c; probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data]; };
    const band = document.querySelector('section [style*="--art-h"]');
    const title = band.querySelector('[id$="-title"]');
    window.__band = { frames: [], done: false };
    const t0 = performance.now();
    const tick = () => {
      const t = performance.now() - t0;
      window.__band.frames.push({ t, bg: rgba(getComputedStyle(band).backgroundColor),
        ink: rgba(getComputedStyle(title).color) });
      if (t < 5000) requestAnimationFrame(tick); else window.__band.done = true;
    };
    requestAnimationFrame(tick);
    return true`);
  await lib.sleep(300);
  await tab.evaluate(() => {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Test tone',
      artist: 'Real-extension rig',
      artwork: [{ src: location.origin + '/art.png', sizes: '96x96', type: 'image/png' }],
    });
  });
  await until(() => p.eval('return window.__band.done'), 8000);
  const fade = await p.eval(`const f = window.__band.frames;
    const apart = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const first = f[0], last = f.at(-1);
    const moved = f.filter((x) => apart(x.bg, first.bg) > 1 && apart(x.bg, last.bg) > 1);
    const steps = f.slice(1).map((x, i) => apart(x.bg, f[i].bg));
    const dur = getComputedStyle(document.documentElement).getPropertyValue('--dur-change').trim();
    return { span: apart(first.bg, last.bg), between: moved.length,
      took: moved.length ? Math.round(moved.at(-1).t - moved[0].t) : 0,
      maxStep: Math.max(...steps), inkMoved: f.some((x) => apart(x.ink, first.ink) > 1 && apart(x.ink, last.ink) > 1),
      dur, title: document.querySelector('section [id$="-title"]').textContent }`);
  await shot(p, '09d-band-after-track-change');
  check(
    "a new track's band fades to its colour, the title's ink with it, over --dur-change",
    fade?.title === 'Test tone' &&
      fade.span > 20 &&
      fade.between >= 4 &&
      fade.took >= 100 &&
      fade.took <= 450 &&
      fade.maxStep < fade.span * 0.6 &&
      fade.inkMoved,
    fade,
  );
  await p.click('button[aria-label^="Stop"]');
  await lib.sleep(1500);
  problems.push(...p.problems);
  p.close();
  await env.audioTab(tab);

  // ── Every room in one cast: nothing left to add ───────────────────────
  p = await env.popup({ dark });
  // Every room the household has now (Office dropped off the network above).
  const everywhere = await p.eval(`return [...document.querySelectorAll('button')]
    .find((b) => b.innerText.startsWith('Everywhere')).innerText.match(/(\\d+) rooms/)[0]`);
  await p.click('button', 'Everywhere');
  // The line comes in above Cast and moves it down in a short popup: let it settle.
  await lib.sleep(600);
  await p.click('button', 'Cast to');
  await until(
    async () => (await p.text()).includes(`Casting now`) && (await p.text()).includes(everywhere),
    10000,
  );
  const addButtons = () =>
    p.eval(`return [...document.querySelectorAll('button')]
      .filter((b) => b.innerText.trim() === 'Add a room').length`);
  await shot(p, '10b-everywhere');
  check('a cast in every room offers no Add a room', (await addButtons()) === 0, await p.text());
  if (await p.eval(`return document.querySelector('details')?.open === false`)) {
    await p.click('summary', everywhere);
    await lib.sleep(400);
  }
  await p.click('button[aria-label^="Remove Study"]');
  const back = await until(async () => (await addButtons()) === 1, 6000);
  check('a room leaving it brings Add a room back', back === true, await p.text());
  await p.click('button', 'Add a room');
  await lib.sleep(500);
  await p.clickRoom('Study');
  await p.click('button', 'Add 1 room');
  const shut = await until(
    async () =>
      (await addButtons()) === 0 &&
      !(await p.text()).includes('Cancel') &&
      (await p.text()).includes(everywhere),
    8000,
  );
  await shot(p, '10c-everywhere-again');
  check('adding the last room shuts add mode and Add a room goes', shut === true, await p.text());
  await p.click('button[aria-label^="Stop"]');
  await lib.sleep(1500);
  problems.push(...p.problems);
  p.close();

  // ── Settings while a cast plays: the next-cast Notice (DESIGN.md §11 call 103) ──
  // Bespoke PCM first, so Smoothing is on the page, then a cast. The Notice shows only while
  // a setting that reaches the stream differs from what the cast started with: Smoothing
  // changed brings it, changed back takes it away, Theme never brings it, a reload mid-cast
  // keeps it, and the cast stopping takes it away.
  const nc = await env.options();
  await nc.scheme(dark);
  const ncPage = env.ctx.pages().find((x) => x.url().includes('/src/options/'));
  // A probe during a reload finds no context; it counts as not ready yet.
  const ncReady = () =>
    until(() =>
      nc
        .eval(`return !!document.querySelector('input[name=audioMode]:checked')`)
        .catch(() => false),
    );
  await ncReady();
  const nextCastShown = () =>
    nc.eval(
      `return [...document.querySelectorAll('[data-notice]')].some((n) =>
        n.innerText.includes('Changes apply from the next cast'))`,
    );
  const selectValue = (id) =>
    nc.eval(
      `const s = document.getElementById(args.id);
      return s ? { value: s.value, options: [...s.options].map((o) => o.value) } : null`,
      { id },
    );
  const choose = async (id, value) => {
    await nc.eval(
      `const s = document.getElementById(args.id);
      s.value = args.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));`,
      { id, value },
    );
    await lib.sleep(600);
  };
  const modeBefore = await nc.eval(
    `return document.querySelector('input[name=audioMode]:checked').closest('label').innerText.split('\\n')[0]`,
  );
  await nc.click('label', 'Bespoke');
  await lib.sleep(600);
  const codecBefore = (await selectValue('audio-codec'))?.value;
  await choose('audio-codec', 'pcm');
  if (await nc.eval(`return document.querySelector('details')?.open === false`)) {
    await nc.click('summary', 'Advanced');
    await lib.sleep(400);
  }
  const smoothing = await selectValue('audio-smoothing');
  check('the next-cast pass has Smoothing to change', Boolean(smoothing), smoothing);
  check('no next-cast Notice without a cast', (await nextCastShown()) === false);

  await tab.bringToFront();
  const pc = await env.popup({ dark });
  await pc.clickRoom('Kitchen');
  await pc.click('button', 'Cast to');
  const ncCasting = await until(async () => (await pc.text()).includes('Casting now'), 8000);
  check('the next-cast pass starts a cast', Boolean(ncCasting), await pc.text());
  problems.push(...pc.problems);
  pc.close();
  await ncPage?.bringToFront();
  await lib.sleep(1000);
  check('no next-cast Notice while the settings match the cast', (await nextCastShown()) === false);

  const otherSmoothing = smoothing?.options.find((v) => v !== smoothing.value);
  await choose('audio-smoothing', otherSmoothing);
  const ncShown = await until(nextCastShown, 3000);
  await nc.eval(
    `[...document.querySelectorAll('main > section')].find((s) => s.querySelector('h2').innerText === 'Audio')
      .scrollIntoView({ block: 'start', behavior: 'instant' })`,
  );
  await shot(nc, '10d-next-cast-notice');
  check('changing Smoothing mid-cast shows the next-cast Notice', ncShown === true);
  // The Audio section with the Notice, in each scheme, for review.
  for (const scheme of [false, true]) {
    await nc.scheme(scheme);
    await lib.sleep(400);
    const box = await nc.eval(`const s = [...document.querySelectorAll('main > section')]
        .find((x) => x.querySelector('h2').innerText === 'Audio');
      const r = s.getBoundingClientRect();
      return { x: r.x, y: r.y + scrollY, width: r.width, height: Math.min(r.height, 520) }`);
    const r = await nc.cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 1 },
      captureBeyondViewport: true,
    });
    writeFileSync(
      join(lib.SHOTS, `10d-next-cast-${scheme ? 'dark' : 'light'}-${tag}.png`),
      Buffer.from(r.data, 'base64'),
    );
  }
  await nc.scheme(dark);

  await choose('audio-smoothing', smoothing?.value);
  const ncGone = await until(async () => (await nextCastShown()) === false, 3000);
  check('changing Smoothing back takes the next-cast Notice away', ncGone === true);

  await nc.click('[role="radiogroup"] label', 'Light');
  await lib.sleep(800);
  check('changing Theme mid-cast shows no next-cast Notice', (await nextCastShown()) === false);
  await nc.click('[role="radiogroup"] label', 'Auto');
  await lib.sleep(400);

  await choose('audio-smoothing', otherSmoothing);
  // Reloaded through CDP: a reload from inside the page drops the context its call runs in.
  await nc.cdp.send('Page.reload');
  await lib.sleep(1200);
  await ncReady();
  const ncReloaded = await until(nextCastShown, 4000);
  check('an options page opened mid-cast still shows the next-cast Notice', ncReloaded === true);

  // Stopped as the popup's Stop stops it: one STOP_CAST per running cast.
  await nc.eval(`const { casts } = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_CASTS' });
    for (const c of casts) await chrome.runtime.sendMessage({ type: 'STOP_CAST', payload: { tabId: c.tabId } });`);
  const ncStopped = await until(async () => (await nextCastShown()) === false, 4000);
  check('the cast stopping takes the next-cast Notice away', ncStopped === true);

  // Back as the rest of the walk expects it.
  await choose('audio-smoothing', smoothing?.value);
  if (codecBefore) await choose('audio-codec', codecBefore);
  await nc.click('label', modeBefore);
  await lib.sleep(600);
  problems.push(...nc.problems);
  nc.close();
  await ncPage?.close();
  await tab.bringToFront();

  // ── Settings › Saved sets: rename, remove at once, Undo ───────────────
  const o = await env.options();
  await o.scheme(dark);
  const optionsPage = env.ctx.pages().find((x) => x.url().includes('/src/options/'));
  await optionsPage?.bringToFront();
  const setsText = () =>
    o.eval(`return [...document.querySelectorAll('section')]
      .find((s) => s.innerText.startsWith('Saved sets'))?.innerText ?? ''`);
  const listed = await until(async () => (await setsText()).includes('guff') && (await setsText()));
  check(
    'Settings lists the saved set with its room count',
    /guff\n\d rooms/.test(listed || ''),
    listed,
  );
  await o.click('button[aria-label="Rename guff"]');
  const editing = await until(
    () => o.eval(`return document.activeElement?.tagName === 'INPUT'`),
    3000,
  );
  check(
    'Rename opens the name field in place, with focus in it',
    editing === true,
    await setsText(),
  );
  // The name is selected, so typing replaces it; an empty name is refused first.
  await o.key('Backspace');
  await o.key('Enter');
  await lib.sleep(400);
  const refused = await setsText();
  check('an empty set name is refused in place', refused.includes('A set needs a name.'), refused);
  await o.type('Upstairs');
  await o.key('Enter');
  await lib.sleep(600);
  const renamed = await o.eval(`return document.activeElement.getAttribute('aria-label')`);
  check(
    'a renamed set keeps its row, and focus goes back to its Rename',
    /Upstairs\n\d rooms/.test(await setsText()) && renamed === 'Rename Upstairs',
    { text: await setsText(), focus: renamed },
  );
  await o.click('button[aria-label="Remove Upstairs"]');
  const toast = await until(async () => {
    const text = await o.text();
    return text.includes('Upstairs removed.') && text.includes('Undo') && text;
  });
  await o.eval(`[...document.querySelectorAll('section')]
    .find((s) => s.innerText.startsWith('Saved sets'))
    ?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await shot(o, '10d-sets-removed');
  check(
    'Remove takes the set out at once and the Toast offers Undo',
    Boolean(toast) && (await setsText()).includes('No sets yet'),
    await o.text(),
  );
  await o.click('button', 'Undo');
  const undone = await until(async () => /Upstairs\n\d rooms/.test(await setsText()));
  check(
    'Undo puts the set back, and the Toast goes',
    undone === true &&
      (await o.eval(`return document.querySelector('[data-sticky-bar]').innerText.trim() === ''`)),
    await o.text(),
  );

  // Escape cancels Rename, and focus goes back to Rename.
  await o.click('button[aria-label="Rename Upstairs"]');
  await until(() => o.eval(`return document.activeElement?.tagName === 'INPUT'`), 3000);
  await o.key('Escape');
  await lib.sleep(400);
  const escaped =
    await o.eval(`return { input: !!document.querySelector('section input[type=text], section input:not([type])'),
    focus: document.activeElement.getAttribute('aria-label') }`);
  check(
    'Escape cancels Rename, and focus goes back to Rename',
    escaped.focus === 'Rename Upstairs' && !(await setsText()).includes('Name this set'),
    escaped,
  );

  // A long name wraps in place: Rename and Remove stay beside it, as on a short one.
  const longName = 'Downstairs with a much longer name than anyone would type';
  await o.click('button[aria-label="Rename Upstairs"]');
  await until(() => o.eval(`return document.activeElement?.tagName === 'INPUT'`), 3000);
  await o.type(longName);
  await o.key('Enter');
  await until(async () => (await setsText()).includes(longName), 3000);
  const longRow = await o.eval(
    `const btn = [...document.querySelectorAll('button[aria-label]')].find(
      (b) => b.getAttribute('aria-label') === 'Remove ' + args.longName);
    const row = btn.closest('li'), name = row.querySelector('span span');
    const b = btn.getBoundingClientRect(), t = name.getBoundingClientRect(), r = row.getBoundingClientRect();
    return { beside: b.top < t.bottom, inside: t.right <= r.right + 0.5, rowW: Math.round(r.width) }`,
    { longName },
  );
  await shot(o, '10e-sets-long-name');
  check(
    'a long set name wraps beside Rename and Remove in Settings',
    longRow.beside && longRow.inside,
    longRow,
  );
  problems.push(...o.problems);
  o.close();
  await optionsPage?.close();
  await tab.bringToFront();

  // The same name in the popup wraps in its row and never widens the popup.
  p = await env.popup({ dark });
  await until(() => p.eval(`return !!document.querySelector('button[aria-pressed]')`), 4000);
  const wide = await p.eval(`const s = document.querySelector('[data-scroller]');
    const row = [...document.querySelectorAll('button[aria-pressed]')]
      .find((b) => b.innerText.includes('Downstairs'));
    row?.scrollIntoView({ block: 'nearest' });
    const card = row?.getBoundingClientRect();
    return { sw: s.scrollWidth, cw: s.clientWidth, row: !!row,
      inside: card ? card.right <= s.getBoundingClientRect().right : null }`);
  await shot(p, '10f-popup-long-set');
  check(
    'a long set name never widens the popup',
    wide.row && wide.sw <= wide.cw && wide.inside,
    wide,
  );
  problems.push(...p.problems);
  p.close();

  // ── Rooms joining and leaving casts, over and over (rooms.mjs) ────────
  problems.push(...(await roomsPass(env, { check, shot, dark })));

  // ── The options page's layout at three windows (options.mjs) ──────────
  // Last: after it closes its tab, the toolbar popup finds no active window to open over.
  problems.push(...(await optionsPass(env, { check, shot, dark, scale })));
} catch (e) {
  check('the walk finished', false, String(e.stack ?? e));
} finally {
  await env.close();
  tone.close();
}

check('no console errors or exceptions', problems.length === 0, problems);
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed} passed, ${failed} failed (${tag}); shots in ${lib.SHOTS}`,
);
process.exit(failed ? 1 : 0);
