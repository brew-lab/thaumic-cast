// The options page pass of the real-extension check: the built options page, against the real
// companion, at a wide, a medium and a narrow window. It checks the page's layout as shipped:
// one content column and one scroller, the sections in the drawing's order, a rule between
// items and none under a heading or round a Notice, every row's control on one edge per
// section, Theme's control on its line from a 25rem card, Quality two by two from Economical,
// Start no louder than first in Finer points, the readouts (Audio's and About's) ruled with
// every value on the end edge, Bespoke with Advanced open (rules inside, controls and the
// readout's values on the card's end edge, every row's help on one edge, the wide row's too),
// nothing moving when a setting saves, the Toast's bar sticky with the focused control never
// under it, a Notice in a section keeping its own padding, About's Check for updates (the
// releases page unpacked, each answer of a stand-in store), and #about landing on About. Run
// from check.mjs; the run's scale and scheme come from it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lib from './lib.mjs';

/** The sections, in the drawing's order (Language is hidden while there is one language). */
const ORDER = ['Appearance', 'Companion', 'Audio', 'Finer points', 'Saved sets', 'About'];

/** The windows the page is checked at, in CSS px. */
const WIDTHS = [1200, 600, 400];

/**
 * Everything the layout checks read, in one pass over the page.
 * @param {import('./lib.mjs').Target} o - The options page
 * @returns {Promise<object>} The facts
 */
const layout = (o) =>
  o.eval(`
    const px = (v) => parseFloat(v) || 0;
    const main = document.querySelector('main');
    const sections = [...main.querySelectorAll(':scope > section')];
    const scrollers = [...document.querySelectorAll('body *')].filter((e) => {
      const y = getComputedStyle(e).overflowY;
      return (y === 'auto' || y === 'scroll') && e.scrollHeight > e.clientHeight + 1;
    }).map((e) => e.tagName + '.' + e.className);
    const per = sections.map((s) => {
      const r = s.getBoundingClientRect();
      const cs = getComputedStyle(s);
      const edge = r.right - px(cs.paddingInlineEnd) - px(cs.borderInlineEndWidth);
      const grid = s.querySelector('[data-settings-grid="section"]');
      const head = grid.previousElementSibling;
      const items = [...grid.children].map((c) => ({
        what: c.hasAttribute('data-notice') ? 'notice' : c.tagName.toLowerCase(),
        rule: px(getComputedStyle(c).borderBlockStartWidth),
      }));
      // Every narrow row's control (a Switch's track, a Select) and where it ends.
      const ends = [...grid.querySelectorAll(':scope > [data-setrow]')]
        .filter((row) => row.getAttribute('data-width') !== 'wide')
        .map((row) => row.querySelector('button[role="switch"], select'))
        .filter(Boolean)
        .map((c) => Math.round(c.getBoundingClientRect().right * 10) / 10);
      // Each wide row: where its name and its control (a SegmentedControl, a Select) sit.
      const wide = [...grid.querySelectorAll(':scope > [data-setrow][data-width="wide"]')]
        .map((row) => {
          const l = row.querySelector('p')?.getBoundingClientRect();
          const c = row.querySelector('[role="radiogroup"], select')?.getBoundingClientRect();
          return l && c ? {
            name: row.querySelector('p').innerText.trim(),
            right: Math.round(c.right * 10) / 10,
            oneLine: c.top < l.bottom && c.bottom > l.top,
          } : null;
        }).filter(Boolean);
      return {
        title: s.querySelector('h2')?.innerText.trim(),
        wide,
        left: Math.round(r.left), right: Math.round(r.right), edge: Math.round(edge * 10) / 10,
        headRule: px(getComputedStyle(head).borderBlockEndWidth),
        tracks: getComputedStyle(grid).display === 'grid'
          ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
        items, ends,
        first: grid.firstElementChild?.innerText.split('\\n')[0].trim(),
        radios: [...s.querySelectorAll('fieldset input[type=radio]')]
          .map((i) => Math.round(i.getBoundingClientRect().left)),
        choices: [...s.querySelectorAll('fieldset input[type=radio]')]
          .map((i) => i.closest('label')?.innerText.split('\\n')[0].split(' (')[0].trim()),
      };
    });
    return {
      vw: innerWidth,
      column: Math.round(main.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scrollers, sections: per,
    };`);

/**
 * The items of a section whose rule is wrong: one after the first takes a rule, except a
 * Notice, the item after a Notice or a subheading, and help (a paragraph).
 * @param {{what: string, rule: number}[]} items - The section's items
 * @returns {object[]} The wrong ones
 */
function wrongRules(items) {
  return items
    .map((item, i) => {
      const prev = items[i - 1];
      const plain =
        i === 0 ||
        item.what === 'notice' ||
        item.what === 'p' ||
        prev.what === 'notice' ||
        prev.what === 'h3';
      return { i, ...item, ok: plain ? item.rule === 0 : item.rule > 0 };
    })
    .filter((r) => !r.ok);
}

/**
 * The readouts (M-dl) in a section: per row, whether it is ruled, where its value ends against
 * the card's end edge, and whether term and value share a line and could.
 * @param {import('./lib.mjs').Target} o - The options page
 * @param {string} title - The section's name
 * @returns {Promise<object>} The facts
 */
const readouts = (o, title) =>
  o.eval(
    `
    const px = (v) => parseFloat(v) || 0;
    const s = [...document.querySelectorAll('main > section')]
      .find((x) => x.querySelector('h2').innerText === args.title);
    const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
    const edge = r.right - px(cs.paddingInlineEnd) - px(cs.borderInlineEndWidth);
    return [...s.querySelectorAll('dl')].map((dl) => {
      const box = dl.getBoundingClientRect();
      return {
        overflow: dl.scrollWidth - dl.clientWidth,
        rows: [...dl.querySelectorAll(':scope > div')].map((pair, i) => {
          const dt = pair.querySelector('dt'), dd = pair.querySelector('dd');
          const t = dt.getBoundingClientRect(), v = dd.getBoundingClientRect();
          const probe = dd.cloneNode(true);
          probe.style.cssText = 'position:absolute;inline-size:max-content;white-space:nowrap';
          pair.append(probe);
          const natural = probe.getBoundingClientRect().width;
          probe.remove();
          const gap = px(getComputedStyle(pair).columnGap);
          return {
            term: dt.innerText,
            ruled: px(getComputedStyle(pair).borderBlockStartWidth) === (i === 0 ? 0 : 1),
            end: Math.round(Math.abs(v.right - edge) * 10) / 10,
            inside: v.left >= box.left - 0.5,
            oneLine: v.top < t.bottom - 1,
            fits: t.width + gap + natural <= box.width + 0.5,
          };
        }),
      };
    });`,
    { title },
  );

/**
 * The readout rows that break M-dl: not ruled, off the card's end edge, out of the list, or
 * wrapped though they fit (or on one line though they do not).
 * @param {object[]} lists - What readouts() read
 * @returns {object[]} The wrong rows, with the list's overflow
 */
const wrongReadout = (lists) =>
  lists.flatMap((l) =>
    l.rows
      .filter((row) => !row.ruled || row.end > 1 || !row.inside || row.oneLine !== row.fits)
      .concat(l.overflow > 0 ? [{ overflow: l.overflow }] : []),
  );

/**
 * Sets the window's CSS width (the run's scale stays the device scale).
 * @param {import('./lib.mjs').Target} o - The options page
 * @param {number} width - CSS px
 * @param {number} scale - The device scale
 * @param {number} [height] - CSS px
 */
async function resize(o, width, scale, height = 900) {
  await o.cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  await lib.sleep(700);
}

/**
 * Clicks the Switch of the row named `name`, the way a user does.
 * @param {import('./lib.mjs').Target} o - The options page
 * @param {string} name - The row's name
 */
async function clickSwitch(o, name) {
  const at = await o.eval(
    `
    const sw = [...document.querySelectorAll('button[role=switch]')]
      .find((b) => b.closest('[data-setrow]').innerText.trim().startsWith(args.name));
    sw.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = sw.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
    { name },
  );
  await o.clickAt(at);
}

/** Where Check for updates sends an unpacked copy (GITHUB_RELEASES_URL in @thaumic-cast/shared). */
const RELEASES = 'https://github.com/brew-lab/thaumic-cast/releases';

/**
 * Reads About's Updates row: its name, help, note, Button and where the Button ends against
 * the card's end edge.
 * @param {import('./lib.mjs').Target} o - The options page
 * @returns {Promise<object|null>} The row's facts, or null when it is missing
 */
const updatesRow = (o) =>
  o.eval(`
    const about = document.getElementById('about');
    const row = [...about.querySelectorAll('[data-setrow]')]
      .find((r) => r.querySelector('p')?.innerText.trim() === 'Updates');
    if (!row) return null;
    const b = row.querySelector('button');
    const ps = [...row.querySelectorAll(':scope > p')].map((p) => p.innerText.trim());
    const cs = getComputedStyle(about);
    const edge = about.getBoundingClientRect().right - parseFloat(cs.paddingInlineEnd)
      - parseFloat(cs.borderInlineEndWidth);
    return {
      button: b.innerText.trim(), disabled: b.disabled, help: ps[0], note: ps[1] ?? null,
      described: (b.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).length,
      endGap: Math.round((edge - b.getBoundingClientRect().right) * 10) / 10,
      rule: parseFloat(getComputedStyle(row).borderBlockStartWidth),
    };`);

/**
 * Saves About alone, in each scheme, for the review sheet.
 * @param {import('./lib.mjs').Target} o - The options page
 * @param {string} name - The state's name
 * @param {boolean} dark - The run's scheme, put back afterwards
 */
async function aboutShots(o, name, dark) {
  for (const scheme of [false, true]) {
    await o.scheme(scheme);
    await lib.sleep(300);
    const r = await o.eval(`
      const a = document.getElementById('about');
      a.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = a.getBoundingClientRect();
      return { x: r.x + scrollX - 8, y: r.y + scrollY - 8, w: r.width + 16, h: r.height + 16 };`);
    const shot = await o.cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 },
    });
    writeFileSync(
      join(lib.SHOTS, `updates-${name}-${scheme ? 'dark' : 'light'}.png`),
      Buffer.from(shot.data, 'base64'),
    );
  }
  await o.scheme(dark);
}

/**
 * About's Check for updates. The rig loads the extension unpacked, so the row opens the
 * releases page. A store install is then stood in for: before the page loads, the manifest
 * gains an update_url and requestUpdateCheck answers from a list (nothing newer, throttled,
 * then 9.9.9), and the row must say each. Restart is never pressed: it would reload the
 * extension under the rest of the run.
 * @param {object} env - What lib.launch() returned
 * @param {import('./lib.mjs').Target} o - The options page
 * @param {object} t - The check's helpers
 * @param {(name: string, ok: boolean, detail?: unknown) => void} t.check - Records a check
 * @param {boolean} t.dark - The run's scheme
 */
async function updatesPass(env, o, { check, dark }) {
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      if ((await o.eval(`return document.querySelectorAll('main > section').length`)) >= 6) break;
      await lib.sleep(200);
    }
  };
  const manual = await updatesRow(o);
  check(
    'options: an unpacked copy offers Check for updates, opening the releases page',
    manual?.button === 'Check for updates' &&
      manual.help === 'Opens the releases page. A copy loaded by hand never updates itself.' &&
      manual.note === null &&
      manual.described === 1 &&
      manual.rule > 0 &&
      Math.abs(manual.endGap) < 1,
    manual,
  );
  await aboutShots(o, 'manual', dark);
  const before = new Set(env.ctx.pages());
  await o.click('#about button', 'Check for updates');
  let opened;
  for (let i = 0; i < 25 && !opened; i++) {
    opened = env.ctx.pages().find((p) => !before.has(p));
    if (!opened) await lib.sleep(200);
  }
  // The tab opens on the releases URL; offline it stays there on an error page.
  for (let i = 0; i < 25 && opened && !opened.url().startsWith(RELEASES); i++) await lib.sleep(200);
  check(
    'options: Check for updates opens the releases page in a new tab',
    Boolean(opened?.url().startsWith(RELEASES)),
    opened?.url(),
  );
  await opened?.close();
  const page = env.ctx.pages().find((x) => x.url().includes('/src/options/'));
  await page?.bringToFront();

  // ── Stand in for a store install ──
  const { identifier } = await o.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const manifest = chrome.runtime.getManifest();
      const answers = [
        { status: 'no_update' },
        { status: 'throttled' },
        { status: 'update_available', version: '9.9.9' },
      ];
      chrome.runtime.getManifest = () => ({
        ...manifest,
        update_url: 'https://clients2.google.com/service/update2/crx',
      });
      chrome.runtime.requestUpdateCheck = async () => answers.shift() ?? { status: 'no_update' };`,
  });
  await o.cdp.send('Page.reload');
  await lib.sleep(800);
  await settle();
  const store = await updatesRow(o);
  check(
    'options: a store install offers Check for updates, asking the store',
    store?.button === 'Check for updates' &&
      store.help === 'Your browser updates the extension by itself. This checks now.' &&
      store.note === null,
    store,
  );
  for (const want of ['This is the latest version.', 'Checked a moment ago. Try again later.']) {
    await o.click('#about button', 'Check for updates');
    await lib.sleep(1400);
    const row = await updatesRow(o);
    check(`options: a store check says "${want}"`, row?.note === want, row);
  }
  await o.click('#about button', 'Check for updates');
  await lib.sleep(1400);
  const ready = await updatesRow(o);
  const casting = await o.eval(
    `return (await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_CASTS' }))?.casts?.length ?? 0`,
  );
  check(
    'options: a version found offers Restart the extension, held while a cast runs',
    ready?.button === 'Restart the extension' &&
      ready.described === 2 &&
      (casting
        ? ready.disabled && ready.note === 'A newer version is ready. Restart once the casts end.'
        : !ready.disabled && ready.note === 'Version 9.9.9 is ready.') &&
      Math.abs(ready.endGap) < 1,
    { ready, casting },
  );
  await aboutShots(o, 'store-ready', dark);
  await o.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await o.cdp.send('Page.reload');
  await lib.sleep(800);
  await settle();
}

/**
 * Runs the options page pass.
 * @param {object} env - What lib.launch() returned
 * @param {object} t - The check's helpers
 * @param {(name: string, ok: boolean, detail?: unknown) => void} t.check - Records a check
 * @param {(target: object, step: string) => Promise<string>} t.shot - Saves a screenshot
 * @param {boolean} t.dark - Dark, else light
 * @param {number} t.scale - The device scale
 * @returns {Promise<string[]>} Console problems the page logged
 */
export async function optionsPass(env, { check, shot, dark, scale }) {
  const o = await env.options();
  await o.scheme(dark);
  const page = env.ctx.pages().find((x) => x.url().includes('/src/options/'));
  await page?.bringToFront();
  const ready = async () =>
    (await o.eval(`return document.querySelectorAll('main > section').length`)) >= ORDER.length;
  for (let i = 0; i < 30 && !(await ready()); i++) await lib.sleep(200);

  // ── The layout at every window ─────────────────────────────────────────
  for (const width of WIDTHS) {
    await resize(o, width, scale);
    const f = await layout(o);
    const tag = `${width}`;
    check(
      `options ${tag}: the sections in the drawing's order, Language hidden`,
      JSON.stringify(f.sections.map((s) => s.title)) === JSON.stringify(ORDER),
      f.sections.map((s) => s.title),
    );
    check(
      `options ${tag}: one content column, at most 40rem, nothing wider than the window`,
      new Set(f.sections.map((s) => `${s.left}:${s.right}`)).size === 1 &&
        f.column <= 640 &&
        f.overflow <= 0,
      { column: f.column, overflow: f.overflow, edges: f.sections.map((s) => [s.left, s.right]) },
    );
    check(
      `options ${tag}: the document is the one scroller`,
      f.scrollers.length === 0,
      f.scrollers,
    );
    const rules = f.sections
      .map((s) => ({ title: s.title, head: s.headRule, wrong: wrongRules(s.items) }))
      .filter((s) => s.head !== 0 || s.wrong.length);
    check(
      `options ${tag}: a rule between items, none under a heading or round a Notice`,
      rules.length === 0,
      rules,
    );
    // From a 25rem card the rows share one control edge, the card's end edge (the page's
    // column never reaches the 45rem help track); under it each row still ends on that edge.
    const edges = f.sections
      .filter((s) => s.ends.length)
      .map((s) => ({ title: s.title, edge: s.edge, ends: s.ends }))
      .filter((s) => s.ends.some((e) => Math.abs(e - s.edge) > 1));
    check(
      `options ${tag}: every row's control ends on the card's end edge`,
      edges.length === 0,
      edges,
    );
    const audio = f.sections.find((s) => s.title === 'Audio');
    const columns = new Set(audio?.radios ?? []).size;
    const want = audio && audio.tracks ? 2 : 1;
    check(
      `options ${tag}: Quality reads ${want === 2 ? 'two by two' : 'in one column'}`,
      audio?.radios.length === 4 && columns === want && (width < 600 || want === 2),
      { radios: audio?.radios, tracks: audio?.tracks },
    );
    check(
      `options ${tag}: Quality runs from Economical to Luxurious, then Bespoke`,
      audio?.choices.join() === 'Economical,Sensible,Luxurious,Bespoke',
      audio?.choices,
    );
    // From a 25rem card Theme's control sits on its name's line, on the card's end edge, as
    // the drawing has it; in a compact card it stacks under the help.
    const appearance = f.sections.find((s) => s.title === 'Appearance');
    const theme = appearance?.wide.find((w) => w.name === 'Theme');
    check(
      `options ${tag}: Theme's control ${appearance?.tracks ? 'sits on its line, on the end edge' : 'stacks under its help'}`,
      Boolean(theme) &&
        (appearance.tracks
          ? theme.oneLine && Math.abs(theme.right - appearance.edge) <= 1
          : !theme.oneLine),
      { theme, edge: appearance?.edge, tracks: appearance?.tracks },
    );
    const finer = f.sections.find((s) => s.title === 'Finer points');
    check(
      `options ${tag}: Start no louder than comes first in Finer points`,
      finer?.first === 'Start no louder than',
      finer?.first,
    );
    // The readouts are ruled rows with every value on the card's end edge, term and value on
    // one line whenever they fit (M-dl, §11 call 96): Luxurious's "For the next tab cast",
    // and About.
    for (const title of ['Audio', 'About']) {
      const lists = await readouts(o, title);
      const wrong = wrongReadout(lists);
      check(
        `options ${tag}: ${title}'s readout is ruled rows, every value on the end edge`,
        lists.length === 1 && lists[0].rows.length >= 2 && wrong.length === 0,
        { rows: lists.map((l) => l.rows.length), wrong },
      );
      if (title === 'Audio' && width >= 600) {
        const split = lists[0]?.rows.filter((row) => !row.oneLine).map((row) => row.term);
        check(
          `options ${tag}: every row of the Audio readout is on one line`,
          split?.length === 0,
          split,
        );
      }
    }
    const h = await o.eval('return document.documentElement.scrollHeight');
    await resize(o, width, scale, h);
    await shot(o, `11-options-${tag}`);
    await resize(o, width, scale);
  }

  // ── Bespoke, with Advanced open ────────────────────────────────────────
  await resize(o, 600, scale);
  const mode = await o.eval(
    `return document.querySelector('input[name=audioMode]:checked')?.closest('label')?.innerText.split('\\n')[0] ?? null`,
  );
  await o.click('label', 'Bespoke');
  await lib.sleep(800);
  await o.click('summary', 'Advanced');
  await lib.sleep(800);
  // Inside Advanced, each row's control (its drawn box) and help: the wide Select for falling
  // behind among the narrow ones. Its help must end where theirs do.
  const advancedRowsSrc = `const advancedRows = (panel) =>
    [...panel.querySelectorAll(':scope > [data-setrow]')].map((row) => {
      const c = row.querySelector('select').parentElement.getBoundingClientRect();
      return {
        width: row.dataset.width,
        start: Math.round(c.left),
        end: Math.round(c.right),
        help: Math.round(row.querySelector('p[id$="-help"]')?.getBoundingClientRect().right ?? 0),
      };
    });`;
  const bespoke = await o.eval(`
    ${advancedRowsSrc}
    const px = (v) => parseFloat(v) || 0;
    const s = [...document.querySelectorAll('main > section')].find((x) => x.querySelector('h2').innerText === 'Audio');
    const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
    const edge = r.right - px(cs.paddingInlineEnd) - px(cs.borderInlineEndWidth);
    const details = s.querySelector('details');
    const panel = details?.querySelector('summary + *');
    const rows = [...s.querySelectorAll('[data-setrow]:not([data-width=wide]) select')];
    return {
      open: !!details?.open,
      h3: s.querySelector('[data-settings-grid] > h3')?.innerText,
      selects: rows.length,
      ends: rows.map((c) => Math.round(c.getBoundingClientRect().right * 10) / 10),
      edge: Math.round(edge * 10) / 10,
      panelRules: panel ? [...panel.children].map((c) => px(getComputedStyle(c).borderBlockStartWidth)) : [],
      inner: panel ? advancedRows(panel) : [],
    };`);
  // Bespoke's readout rows sit among the Select rows: their values end where the Selects do.
  const bespokeReadout = await readouts(o, 'Audio');
  const bespokeWrong = wrongReadout(bespokeReadout);
  check(
    "options Bespoke: the readout's values end on the Selects' end edge, ruled like the rows",
    bespokeReadout.length === 1 &&
      bespokeReadout[0].rows.length >= 3 &&
      bespokeWrong.length === 0 &&
      bespoke.ends.every((e) => Math.abs(e - bespoke.edge) <= 1),
    { wrong: bespokeWrong, ends: bespoke.ends, edge: bespoke.edge },
  );
  await o.eval(
    `document.querySelector('details[open]')?.scrollIntoView({ block: 'center', behavior: 'instant' })`,
  );
  await shot(o, '11-options-bespoke');
  check(
    'options Bespoke: the Selects under a subheading, Advanced open, every control on the card edge',
    bespoke.open &&
      bespoke.selects >= 4 &&
      bespoke.ends.every((e) => Math.abs(e - bespoke.edge) <= 1),
    bespoke,
  );
  check(
    'options Bespoke: rows inside Advanced are ruled, with none under its summary',
    bespoke.panelRules.length >= 2 &&
      bespoke.panelRules[0] === 0 &&
      bespoke.panelRules.slice(1).every((r) => r > 0),
    bespoke.panelRules,
  );
  // The owner's report: the wide row's help ran to the card's end while the narrow rows' help
  // ended before the control column. At the 1200 and 600 px windows every row's help ends on
  // one edge, before every narrow control, and every control ends on the card's end edge.
  for (const width of [1200, 600]) {
    await resize(o, width, scale);
    await lib.sleep(300);
    const adv = await o.eval(`
      ${advancedRowsSrc}
      const px = (v) => parseFloat(v) || 0;
      const s = [...document.querySelectorAll('main > section')].find((x) => x.querySelector('h2').innerText === 'Audio');
      const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
      return {
        edge: Math.round(r.right - px(cs.paddingInlineEnd) - px(cs.borderInlineEndWidth)),
        rows: advancedRows(s.querySelector('details summary + *')),
      };`);
    const helps = adv.rows.map((r) => r.help);
    const narrowStart = Math.min(...adv.rows.filter((r) => r.width !== 'wide').map((r) => r.start));
    check(
      `options Bespoke ${width}: every row in Advanced, the wide one too, ends its help on one edge`,
      adv.rows.length >= 3 &&
        adv.rows.some((r) => r.width === 'wide') &&
        Math.max(...helps) - Math.min(...helps) <= 1 &&
        helps.every((h) => h < narrowStart) &&
        adv.rows.every((r) => Math.abs(r.end - adv.edge) <= 1),
      adv,
    );
  }
  await resize(o, 600, scale);
  if (mode) await o.click('label', mode);
  await lib.sleep(600);

  // ── A Notice in a section keeps its own padding ────────────────────────
  // "Enter the address" with nothing saved shows a warning Notice between the choice and the
  // field. Every Notice in a section keeps its own padding (the section's rule reset once
  // took its top padding; a dismissible one's end is narrower by design), its glyph sits
  // inside that padding on the first line, it is the section's gap from its neighbours with
  // no rule, and it spans the fields' inline edges.
  await o.click('label', 'Enter the address');
  await lib.sleep(800);
  const notices = await o.eval(`
    const px = (v) => parseFloat(v) || 0;
    return [...document.querySelectorAll('[data-settings-grid="section"] > [data-notice]')].map((n) => {
      const grid = n.parentElement, cs = getComputedStyle(n), r = n.getBoundingClientRect();
      const g = n.firstElementChild.getBoundingClientRect(), gr = grid.getBoundingClientRect();
      const words = n.querySelector('p').getBoundingClientRect();
      const prev = n.previousElementSibling?.getBoundingClientRect();
      const next = n.nextElementSibling?.getBoundingClientRect();
      const r1 = (v) => Math.round(v * 10) / 10;
      return {
        text: n.innerText.slice(0, 40),
        pad: [cs.paddingBlockStart, cs.paddingInlineEnd, cs.paddingBlockEnd, cs.paddingInlineStart].map(px),
        glyph: { start: r1(g.left - r.left), top: r1(g.top - r.top), line: r1(words.top - r.top) },
        gap: px(getComputedStyle(grid).rowGap),
        above: prev ? r1(r.top - prev.bottom) : null,
        below: next ? r1(next.top - r.bottom) : null,
        edges: [r1(r.left - gr.left), r1(gr.right - r.right)],
      };
    });`);
  await o.eval(
    `document.querySelector('[data-settings-grid] > [data-notice]')?.scrollIntoView({ block: 'center', behavior: 'instant' })`,
  );
  await shot(o, '11-options-address-missing');
  const badNotices = notices.filter(
    (n) =>
      n.pad[0] <= 0 ||
      n.pad[0] !== n.pad[2] ||
      n.pad[1] <= 0 ||
      n.pad[3] <= 0 ||
      n.glyph.start !== n.pad[3] ||
      n.glyph.top !== n.pad[0] ||
      n.glyph.line !== n.pad[0] ||
      (n.above !== null && n.above !== n.gap) ||
      (n.below !== null && n.below !== n.gap) ||
      n.edges.some((e) => e !== 0),
  );
  check(
    'options: a Notice in a section keeps its padding, its glyph inside it, the gap round it',
    notices.some((n) => n.text.startsWith('No server address')) && badNotices.length === 0,
    notices,
  );
  await o.click('label', 'Find it automatically');
  await lib.sleep(600);

  // ── Nothing moves when a setting saves ─────────────────────────────────
  const tops = () =>
    o.eval(`return [...document.querySelectorAll('main > :not([data-sticky-bar])')].map((e) =>
      Math.round(e.getBoundingClientRect().top + scrollY))`);
  const before = await tops();
  await clickSwitch(o, 'Video sync');
  await lib.sleep(800);
  const saved = await tops();
  await clickSwitch(o, 'Video sync');
  await lib.sleep(800);
  check(
    'options: a setting saves without moving anything on the page',
    JSON.stringify(before) === JSON.stringify(saved) &&
      !(await o.text()).includes('were not saved'),
    { before, saved },
  );

  // ── The Toast's bar: sticky, 0 tall without a Toast, never over focus ──
  await resize(o, 400, scale, 640);
  const bar = () =>
    o.eval(`const b = document.querySelector('[data-sticky-bar]').getBoundingClientRect();
      return { h: b.height, top: b.top, bottom: b.bottom, vh: innerHeight,
        pad: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBlockEnd) }`);
  const empty = await bar();
  const removable = await o.eval(
    `return [...document.querySelectorAll('button[aria-label^="Remove "]')].map((b) => b.getAttribute('aria-label'))`,
  );
  check('options: the bar is mounted and 0 tall without a Toast', empty.h === 0, empty);
  if (removable.length) {
    await o.click(`button[aria-label="${removable[0]}"]`);
    await lib.sleep(600);
    const shown = await bar();
    // A control the scroll leaves under the bar: focusing it must bring it clear of the bar.
    const under = await o.eval(`
      const bar = document.querySelector('[data-sticky-bar]').getBoundingClientRect();
      const sw = [...document.querySelectorAll('button[role=switch]')][0];
      scrollTo({ top: sw.getBoundingClientRect().top + scrollY - bar.top + 4, behavior: 'instant' });
      const at = sw.getBoundingClientRect();
      sw.focus();
      await new Promise((r) => setTimeout(r, 400));
      const now = sw.getBoundingClientRect(), b = document.querySelector('[data-sticky-bar]').getBoundingClientRect();
      return { wasUnder: at.bottom > bar.top, bottom: now.bottom, barTop: b.top };`);
    await shot(o, '11-options-toast');
    check(
      'options: the Toast sticks to the window end and the end padding follows it (2.4.11)',
      shown.h > 0 &&
        Math.abs(shown.bottom - shown.vh) < 1 &&
        Math.abs(shown.pad - (shown.h + 8)) < 1,
      shown,
    );
    check(
      'options: a focused control is never under the Toast',
      under.wasUnder && under.bottom <= under.barTop + 0.5,
      under,
    );
    await o.click('button', 'Undo');
    await lib.sleep(800);
    const gone = await bar();
    check('options: after Undo the bar is 0 tall again', gone.h === 0, gone);
  } else {
    check('options: a saved set to remove for the Toast', false, 'no saved set');
  }

  // ── About's Check for updates ──────────────────────────────────────────
  await resize(o, 600, scale);
  await updatesPass(env, o, { check, dark });

  // ── The popup's marked Settings opens About ────────────────────────────
  await resize(o, 600, scale, 640);
  await o.eval(`scrollTo({ top: 0, behavior: 'instant' }); location.hash = 'about'`);
  await lib.sleep(900);
  const about = await o.eval(
    `const r = document.getElementById('about').getBoundingClientRect();
    const end = scrollY + innerHeight >= document.documentElement.scrollHeight - 1;
    return { top: r.top, bottom: r.bottom, vh: innerHeight, end }`,
  );
  // At its scroll padding from the top, or as near as the page's end lets it come, in view.
  check(
    'options: #about brings About into view, clear of the top',
    about.top >= 0 && about.bottom <= about.vh && (about.top < 60 || about.end),
    about,
  );
  await o.eval(`history.replaceState(null, '', location.pathname)`);

  const problems = [...o.problems];
  o.close();
  await page?.close();
  return problems;
}
