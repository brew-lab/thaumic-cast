// The lifecycle pass of the real-extension check: what happens around the extension rather than
// in its popup. A page that is controlled by a service worker and sends a Connection-Allowlist
// (as YouTube Music does) must still get the content scripts; the companion quitting and coming
// back mid-cast must be an ordinary event (no warnings, no errors); and reloading the extension
// with a tab open must leave the tab's orphaned content scripts quiet. With nothing answering,
// About and the popup's banner offer the desktop app's download. It starts and stops its
// own companion, so run.sh runs it once, after the popup passes, with BIN set to the companion
// test binary. Exit 1 on any failure. See README.md.
import { spawn } from 'node:child_process';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import * as lib from './lib.mjs';

/** Where the download goes (GITHUB_RELEASES_URL in @thaumic-cast/shared). */
const RELEASES = 'https://github.com/brew-lab/thaumic-cast/releases/latest';
/** Where it lands: GitHub sends /latest on to the newest release's page. */
const RELEASES_PAGES = 'https://github.com/brew-lab/thaumic-cast/releases/';
/** The download's words, in About and on the popup's banner. */
const DOWNLOAD = 'Download the companion';

/** The port of the page with a service worker and a Connection-Allowlist. */
const ALLOWLIST_PORT = lib.AUDIO_PORT + 1;
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
 * Starts the companion on the fake household.
 * @returns {Promise<import('node:child_process').ChildProcess>} Its process, once it listens
 */
async function startCompanion() {
  const args = ['testing::real_ext_companion::real_ext_companion', '--ignored', '--nocapture'];
  const c = spawn(process.env.BIN, [...args, '--exact'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  // It says it is ready on stderr.
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !out.includes('control on'); i++) await lib.sleep(250);
  if (!out.includes('control on')) {
    c.kill('SIGKILL');
    throw new Error('the companion did not start: ' + out.slice(-400));
  }
  return c;
}

/**
 * Stops the companion the way a quit or a crash does: at once, without closing its sockets.
 * @param {import('node:child_process').ChildProcess} c - Its process
 * @returns {Promise<void>} Resolves once it has exited
 */
async function stopCompanion(c) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  c.kill('SIGKILL');
  await new Promise((r) => c.once('exit', r));
}

/**
 * Serves a page that a service worker controls, sending an enforced Connection-Allowlist that
 * allows only its own origin, the way YouTube Music does.
 * @returns {http.Server} The server
 */
function serveAllowlistPage() {
  const sw = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));`;
  const page = `<!doctype html><title>Allowlist</title><h1>Allowlist</h1><script>
navigator.serviceWorker.register('/sw.js');
navigator.mediaSession.setActionHandler('play', () => {});
navigator.mediaSession.metadata = new MediaMetadata({ title: 'Allowlist' });
</script>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(sw);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.setHeader('Connection-Allowlist', '(response-origin)');
    res.end(page);
  });
  server.listen(ALLOWLIST_PORT, '127.0.0.1');
  return server;
}

/**
 * Collects warnings, errors and exceptions from every target of the extension and the test
 * tabs, and from their workers, over raw flat CDP sessions.
 */
class Problems {
  /**
   * Starts with nothing collected.
   * @param {object} env - What lib.launch() returned
   */
  constructor(env) {
    this.env = env;
    this.seen = new Set();
    /** @type {string[]} */
    this.all = [];
  }

  /**
   * Attaches to every target not yet attached: the service worker, the offscreen document
   * (with its workers) and the http tabs.
   * @returns {Promise<void>} Resolves once attached
   */
  async sweep() {
    for (const t of await this.env.targets()) {
      if (this.seen.has(t.id)) continue;
      const ours = t.url.includes(this.env.id) && t.type !== 'page';
      const tab = t.type === 'page' && t.url.startsWith('http://127.0.0.1');
      if (!ours && !tab) continue;
      this.seen.add(t.id);
      await this.attach(t, ours ? t.url.split('/').pop() : 'tab');
    }
  }

  /**
   * Listens to one target and the workers it starts.
   * @param {{ webSocketDebuggerUrl: string }} t - The target
   * @param {string} tag - Its name in the report
   * @returns {Promise<void>} Resolves once listening
   */
  async attach(t, tag) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    let id = 0;
    const send = (method, params = {}, sessionId) =>
      ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }));
    const tags = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const who = (msg.sessionId ? tags.get(msg.sessionId) : tag) ?? tag;
      const p = msg.params;
      if (msg.method === 'Target.attachedToTarget') {
        tags.set(p.sessionId, `${tag} > ${p.targetInfo.type}`);
        send('Runtime.enable', {}, p.sessionId);
        send('Log.enable', {}, p.sessionId);
        send('Runtime.runIfWaitingForDebugger', {}, p.sessionId);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        if (['error', 'warning', 'assert'].includes(p.type)) {
          const text = p.args.map((a) => a.value ?? a.description).join(' ');
          this.all.push(`${who}: console.${p.type} ${text}`);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        this.all.push(`${who}: uncaught ${d.exception?.description ?? d.text}`);
      } else if (msg.method === 'Log.entryAdded') {
        const e = p.entry;
        // Chromium's own line for a socket that could not connect while the companion is down;
        // reconnecting is the recovery, and no extension code can keep the browser from saying so.
        const refused = e.source === 'network' && /^WebSocket connection to .* failed/.test(e.text);
        if (['error', 'warning'].includes(e.level) && !refused) {
          this.all.push(`${who}: ${e.source} ${e.level} ${e.text}`);
        }
      }
    };
    send('Runtime.enable');
    send('Log.enable');
    send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  /**
   * Takes the problems seen since the last call.
   * @returns {string[]} Their lines, first line of each
   */
  take() {
    const out = this.all.map((l) => l.split('\n')[0]);
    this.all = [];
    return out;
  }
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
 * Waits for a tab that was not open before, on the releases page, and closes it.
 * @param {object} env - What lib.launch() returned
 * @param {Set<object>} before - The pages open before the click
 * @returns {Promise<string|undefined>} The new tab's URL, or undefined when none opened
 */
async function releasesTab(env, before) {
  let opened;
  for (let i = 0; i < 25 && !opened; i++) {
    opened = env.ctx.pages().find((x) => !before.has(x));
    if (!opened) await lib.sleep(200);
  }
  // Offline it stays on the releases URL, on an error page.
  for (let i = 0; i < 25 && opened && !opened.url().startsWith(RELEASES_PAGES); i++)
    await lib.sleep(200);
  const url = opened?.url();
  await opened?.close();
  return url;
}

/**
 * Saves an element alone, in each scheme, for the review sheet.
 * @param {import('./lib.mjs').Target} t - The page
 * @param {string} selector - The element
 * @param {string} name - The file name's start
 */
async function elementShots(t, selector, name) {
  for (const dark of [false, true]) {
    await t.scheme(dark);
    await lib.sleep(400);
    const r = await t.eval(
      `
      const e = document.querySelector(args.selector);
      e.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = e.getBoundingClientRect();
      return { x: r.x + scrollX - 8, y: r.y + scrollY - 8, w: r.width + 16, h: r.height + 16 };`,
      { selector },
    );
    const shot = await t.cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.w, height: r.h, scale: 1 },
    });
    writeFileSync(
      join(lib.SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`),
      Buffer.from(shot.data, 'base64'),
    );
  }
}

/**
 * About's Companion value, and whether it holds a Button.
 * @param {import('./lib.mjs').Target} o - The options page
 * @returns {Promise<{text: string|null, button: boolean}>} The value
 */
const companionValue = (o) =>
  o.eval(`
    const about = document.getElementById('about');
    const dd = [...about.querySelectorAll('dt')]
      .find((dt) => dt.innerText.trim() === 'Companion')?.nextElementSibling;
    return { text: dd?.innerText.trim() ?? null, button: !!dd?.querySelector('button') };`);

/**
 * Nothing answers (issue #109): About's readout and the popup's banner offer the desktop app's
 * download, each opening the releases page in a new tab; connected, About offers none.
 * @param {object} env - What lib.launch() returned
 * @param {() => Promise<void>} stop - Stops the companion
 */
async function downloadPass(env, stop) {
  const o = await env.options();
  await lib.sleep(1500);
  const connected = await companionValue(o);
  check(
    'connected, About offers no download',
    connected.text !== null && !connected.text.includes(DOWNLOAD),
    connected,
  );
  o.close();
  await env.ctx
    .pages()
    .find((x) => x.url().includes('/src/options/'))
    ?.close();

  // As in the issue: a fresh install with no companion anywhere, its onboarding skipped.
  await stop();
  const fresh = await lib.launch({ profile: 'lifecycle-download' });
  try {
    await nothingAnswers(fresh);
  } finally {
    await fresh.close();
  }
}

/**
 * The download with nothing answering, in a fresh profile.
 * @param {object} env - What lib.launch() returned
 */
async function nothingAnswers(env) {
  await env.audioTab();
  let p = await env.popup();
  await p.click('button', 'Skip');
  await lib.sleep(1500);
  let banner = '';
  for (let i = 0; i < 10 && !banner.includes('No desktop app or server answered'); i++) {
    p = await env.popup({ settle: 2000 });
    banner = await p.eval(`return document.querySelector('[role="region"]')?.innerText ?? ''`);
  }
  check(
    'nothing answering, the banner offers Try again and the download',
    banner.includes('Try again') && banner.includes(DOWNLOAD),
    banner,
  );
  const link = await p.eval(
    `
    const a = [...document.querySelectorAll('[role="region"] a')]
      .find((a) => a.innerText.includes(args.words));
    return a ? { href: a.href, target: a.target } : null;`,
    { words: DOWNLOAD },
  );
  check(
    "the banner's download is a link to the releases page, in a new tab",
    link?.href === RELEASES && link.target === '_blank',
    link,
  );
  for (const dark of [false, true]) {
    await p.scheme(dark);
    await lib.sleep(400);
    await p.shot(`download-popup-${dark ? 'dark' : 'light'}`);
  }
  await p.scheme(false);
  let before = new Set(env.ctx.pages());
  await p.click('[role="region"] a', DOWNLOAD);
  const fromPopup = await releasesTab(env, before);
  check(
    "the banner's download opens the releases page",
    Boolean(fromPopup?.startsWith(RELEASES_PAGES)),
    fromPopup,
  );
  p.close();

  const o = await env.options();
  let value;
  for (let i = 0; i < 20; i++) {
    value = await companionValue(o);
    if (value.text?.includes(DOWNLOAD)) break;
    await lib.sleep(300);
  }
  check(
    'nothing connected, About offers the download under its words',
    Boolean(value.text?.startsWith('Nothing connected.') && value.text.includes(DOWNLOAD)),
    value,
  );
  await elementShots(o, '#about', 'download-about');
  await o.scheme(false);
  before = new Set(env.ctx.pages());
  await o.click('#about dd button', DOWNLOAD);
  const fromAbout = await releasesTab(env, before);
  check(
    "About's download opens the releases page in a new tab",
    Boolean(fromAbout?.startsWith(RELEASES_PAGES)),
    fromAbout,
  );
  o.close();
  await env.ctx
    .pages()
    .find((x) => x.url().includes('/src/options/'))
    ?.close();
}

/**
 * The page's media session values reach the browser's own media session, which its media
 * controls, the OS overlay and the media keys read: the reader watches them without keeping
 * them. Read through MediaSession.prototype's getters, past the reader's accessors.
 * @param {import('@playwright/test').Page} tab - A page the reader runs in
 */
async function nativeSessionPass(tab) {
  const native = () =>
    tab.evaluate(() => {
      const get = (key) =>
        Object.getOwnPropertyDescriptor(MediaSession.prototype, key).get.call(
          navigator.mediaSession,
        );
      return { title: get('metadata')?.title ?? null, state: get('playbackState') };
    });
  const atLoad = await native();
  check(
    "the metadata the page set as it loaded reaches the browser's media session",
    atLoad.title === 'Test tone',
    atLoad,
  );
  await tab.evaluate(() => {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Set later', artist: 'Rig' });
    navigator.mediaSession.playbackState = 'playing';
  });
  const later = await native();
  check(
    "metadata and playbackState the page sets later reach the browser's media session",
    later.title === 'Set later' && later.state === 'playing',
    later,
  );
}

/**
 * Has the page register Next and Previous track handlers that count their calls.
 * @param {import('@playwright/test').Page} tab - The page
 * @returns {Promise<void>} Resolves once registered
 */
const countTrackCalls = (tab) =>
  tab.evaluate(() => {
    window.__trackCalls = [];
    for (const action of ['nexttrack', 'previoustrack']) {
      navigator.mediaSession.setActionHandler(action, () => window.__trackCalls.push(action));
    }
  });

/**
 * One press of Next or Previous track in the popup moves the page's media session one track:
 * the background sends one CONTROL_MEDIA and the page's handler runs once. The rig watches the
 * worker's chrome.tabs.sendMessage calls and lets each through.
 * @param {object} env - What lib.launch() returned
 * @param {import('@playwright/test').Page} tab - The cast's tab
 */
async function transportPass(env, tab) {
  await countTrackCalls(tab);
  await env.sw.evaluate(() => {
    const sent = (globalThis.__controlsSent = []);
    const real = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (tabId, message, ...rest) => {
      if (message?.type === 'CONTROL_MEDIA') sent.push(message.action);
      return real(tabId, message, ...rest);
    };
  });
  const p = await env.popup();
  for (const [label, action] of [
    ['Next track', 'nexttrack'],
    ['Previous track', 'previoustrack'],
  ]) {
    await until(() => p.eval(`return !!document.querySelector('button[aria-label="${label}"]')`));
    await tab.evaluate(() => (window.__trackCalls = []));
    await env.sw.evaluate(() => (globalThis.__controlsSent.length = 0));
    await p.click('button', label);
    await lib.sleep(1000);
    const calls = await tab.evaluate(() => window.__trackCalls);
    const sent = await env.sw.evaluate(() => [...globalThis.__controlsSent]);
    check(
      `one press of ${label} sends one ${action} and the page's handler runs once`,
      JSON.stringify(calls) === JSON.stringify([action]) &&
        JSON.stringify(sent) === JSON.stringify([action]),
      { calls, sent },
    );
  }
  p.close();
}

/**
 * Two copies of the extension in one browser (a store install beside an unpacked build) each
 * inject a media reader into the page, and every reader hears every bridge's control event:
 * one Next called the page's handler twice and skipped a track. Only the first reader serves.
 */
async function twoCopiesPass() {
  const copy = join(tmpdir(), 'thaumic-real-ext-second-copy');
  rmSync(copy, { recursive: true, force: true });
  cpSync(lib.EXT, copy, { recursive: true });
  const env = await lib.launch({ profile: 'lifecycle-two-copies', also: [copy] });
  try {
    const workers = await until(
      () =>
        env.ctx.serviceWorkers().filter((w) => w.url().includes('service-worker-loader')).length ===
          2 || undefined,
    );
    check('two copies of the extension load side by side', Boolean(workers));
    const tab = await env.audioTab();
    await countTrackCalls(tab);
    await lib.sleep(500);
    await env.sw.evaluate(async () => {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(t.id, { type: 'CONTROL_MEDIA', action: 'nexttrack' });
    });
    await lib.sleep(500);
    const calls = await tab.evaluate(() => window.__trackCalls);
    check(
      "with two copies installed, one nexttrack runs the page's handler once",
      JSON.stringify(calls) === JSON.stringify(['nexttrack']),
      calls,
    );
  } finally {
    await env.close();
    rmSync(copy, { recursive: true, force: true });
  }
}

if (!process.env.BIN) {
  console.error('BIN must name the thaumic-core test binary (run.sh sets it)');
  process.exit(2);
}
let companion = await startCompanion();
const tone = lib.serveTone();
const allowlist = serveAllowlistPage();
const env = await lib.launch({ profile: 'lifecycle' });
const problems = new Problems(env);
try {
  await problems.sweep();

  // ── A service-worker page with a Connection-Allowlist gets the content scripts ──
  // The allowlist covers every fetch the page makes. Content scripts the browser injects are
  // not fetches; a loader that import()s its module from a web-accessible URL is one, and was
  // blocked with "Unsafe attempt to load URL".
  const page = await env.ctx.newPage();
  await page.goto(`http://127.0.0.1:${ALLOWLIST_PORT}/watch?v=1`);
  await until(() => page.evaluate(() => !!navigator.serviceWorker.controller));
  await page.reload();
  await problems.sweep();
  await lib.sleep(1500);
  const hooked = await page.evaluate(
    () => Object.getOwnPropertyDescriptor(navigator.mediaSession, 'metadata') !== undefined,
  );
  check('on a page with a Connection-Allowlist the media reader runs', hooked);
  const allowlistProblems = problems.take();
  check(
    'on a page with a Connection-Allowlist nothing is blocked or logged',
    allowlistProblems.length === 0,
    allowlistProblems,
  );
  await page.close();

  // ── A cast, then the companion quits and comes back ────────────────────
  const tab = await env.audioTab();
  let p = await env.popup();
  for (let i = 0; i < 4; i++) {
    await p.click('button', 'Carry on').catch(() => {});
    await lib.sleep(1200);
  }
  await p.click('button', 'That').catch(() => {});
  await lib.sleep(1200);
  p = await env.popup();
  await p.clickRoom('Kitchen');
  await p.click('button', 'Cast to');
  const casting = await until(async () => (await p.text()).includes('Casting now'), 10000);
  check('a cast starts', Boolean(casting));
  p.close();
  await nativeSessionPass(tab);
  await transportPass(env, tab);
  await problems.sweep();
  await lib.sleep(2000);
  problems.take();

  await stopCompanion(companion);
  await lib.sleep(4000);
  companion = await startCompanion();
  await lib.sleep(8000);
  await problems.sweep();
  p = await env.popup();
  const back = await until(async () => (await p.text()).includes('Cast to'), 10000);
  check('after the companion comes back the popup offers Cast again', Boolean(back));
  check(
    'connected, the popup offers no download',
    !(await p.text()).includes(DOWNLOAD),
    await p.text(),
  );
  p.close();
  const restartProblems = problems.take();
  check(
    'the companion quitting and coming back logs no warnings or errors',
    restartProblems.length === 0,
    restartProblems,
  );

  // ── Nothing answers: About and the banner offer the download ──────────
  await downloadPass(env, () => stopCompanion(companion));
  companion = await startCompanion();
  await lib.sleep(4000);
  await problems.sweep();
  problems.take();

  // ── The extension reloads with the tab open ────────────────────────────
  // As an update or a reload of the unpacked extension does: the tab's content scripts are
  // orphaned and must stop quietly when the page next sends them metadata.
  const browserSession = await env.browser.newBrowserCDPSession();
  await browserSession.send('Extensions.loadUnpacked', { path: lib.EXT });
  await lib.sleep(2500);
  await problems.sweep();
  await tab.evaluate(() => {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'After the reload' });
    navigator.mediaSession.playbackState = 'paused';
  });
  await lib.sleep(1500);
  await tab.evaluate(() => {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'And again' });
  });
  await lib.sleep(1500);
  const reloadProblems = problems.take();
  check(
    'reloading the extension with a tab open throws nothing in the tab',
    reloadProblems.length === 0,
    reloadProblems,
  );

  // ── Two copies of the extension: one press is still one track ──────────
  await twoCopiesPass();
} catch (e) {
  check('the lifecycle pass finished', false, String(e.stack ?? e));
} finally {
  await env.close();
  tone.close();
  allowlist.close();
  await stopCompanion(companion);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed (lifecycle)`);
process.exit(failed ? 1 : 0);
