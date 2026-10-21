// The lifecycle pass of the real-extension check: what happens around the extension rather than
// in its popup. A page that is controlled by a service worker and sends a Connection-Allowlist
// (as YouTube Music does) must still get the content scripts; the companion quitting and coming
// back mid-cast must be an ordinary event (no warnings, no errors); and reloading the extension
// with a tab open must leave the tab's orphaned content scripts quiet. It starts and stops its
// own companion, so run.sh runs it once, after the popup passes, with BIN set to the companion
// test binary. Exit 1 on any failure. See README.md.
import { spawn } from 'node:child_process';
import http from 'node:http';
import * as lib from './lib.mjs';

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
  if (c.exitCode !== null) return;
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
  p.close();
  const restartProblems = problems.take();
  check(
    'the companion quitting and coming back logs no warnings or errors',
    restartProblems.length === 0,
    restartProblems,
  );

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
