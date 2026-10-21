// The real-extension rig: launches Chromium with the built extension unpacked, opens the
// real toolbar popup with chrome.action.openPopup() and drives it over raw CDP (Playwright
// does not expose an action popup as a page). See README.md.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The built extension (`bun run build` in apps/extension). */
export const EXT = resolve(process.env.REALEXT_EXT ?? join(HERE, '..', 'dist'));
/** Where screenshots go. */
export const SHOTS = resolve(process.env.REALEXT_SHOTS ?? join(HERE, 'shots'));
/** The fake household's control API (real_ext_companion in thaumic-core). */
export const CONTROL = 'http://127.0.0.1:49499';
/** The port the page that plays a tone is served on. */
export const AUDIO_PORT = 8765;

/**
 * Waits.
 * @param {number} ms - How long
 * @returns {Promise<void>} Resolves after `ms`
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The ID Chromium gives an unpacked extension: the SHA-256 of its absolute path, the first
 * 32 hex digits spelled a to p. Tab capture needs it allowlisted before launch.
 * @param {string} path - The extension's directory
 * @returns {string} The extension ID
 */
export function unpackedId(path) {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * Calls the fake household's control API.
 * @param {string} path - For example `/volume?room=Office&v=20`
 * @returns {Promise<string>} The reply
 */
export async function control(path) {
  const read = path.startsWith('/state') || path.startsWith('/log');
  const res = await fetch(CONTROL + path, { method: read ? 'GET' : 'POST' });
  return res.text();
}

const TONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test tone</title></head>
<body><h1>Test tone</h1><button id="play">Play</button><audio id="a" loop></audio><script>
function wav(sec = 10, f = 330) {
  const sr = 44100, n = sr * sec, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * i / sr) * 3000, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
const a = document.getElementById('a'); a.src = wav();
document.getElementById('play').onclick = () => a.play(); a.play().catch(() => {});
navigator.mediaSession.metadata = new MediaMetadata({ title: 'Test tone', artist: 'Real-extension rig',
  artwork: [{ src: location.origin + '/art.png', sizes: '96x96', type: 'image/png' }] });
</script></body></html>`;

/**
 * The tone's artwork, so an open tile draws its artwork-seeded band: a 96 px PNG, teal with a
 * gold disc (the popup decodes artwork with createImageBitmap, which takes no SVG).
 * @returns {Buffer} The PNG
 */
function artPng() {
  const size = 96;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const inDisc = (x - 48) ** 2 + (y - 48) ** 2 < 28 ** 2;
      row.push(...(inDisc ? [0xe8, 0xc5, 0x47] : [0x2f, 0x7d, 0x6d]));
    }
    rows.push(Buffer.from(row));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const ART = artPng();

/**
 * Serves a page that plays a tone, so a tab has audio to capture, and its artwork.
 * @returns {http.Server} The server, to close when done
 */
export function serveTone() {
  const server = http.createServer((req, res) => {
    if (req.url === '/art.png') {
      res.setHeader('content-type', 'image/png');
      res.setHeader('access-control-allow-origin', '*');
      res.end(ART);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(TONE_PAGE);
  });
  server.listen(AUDIO_PORT, '127.0.0.1');
  return server;
}

/** A CDP session on one target, over its WebSocket. */
class Cdp {
  /**
   * Wraps an open socket.
   * @param {WebSocket} ws - The target's debugger socket
   */
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    });
  }

  /**
   * Connects to a target.
   * @param {string} url - Its webSocketDebuggerUrl
   * @returns {Promise<Cdp>} The session
   */
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });
    return new Cdp(ws);
  }

  /**
   * Sends a CDP command.
   * @param {string} method - The command
   * @param {object} [params] - Its parameters
   * @returns {Promise<any>} Its result
   */
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

/** An extension page (the popup, the options page) driven over CDP. */
export class Target {
  /**
   * Wraps a session.
   * @param {Cdp} cdp - The page's session
   */
  constructor(cdp) {
    this.cdp = cdp;
    /** Console errors, warnings and exceptions the page logged. */
    this.problems = [];
  }

  /**
   * Turns on the domains the rig uses and starts collecting console problems.
   * @returns {Promise<Target>} This target
   */
  async init() {
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');
    this.cdp.ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (
        msg.method === 'Runtime.consoleAPICalled' &&
        ['error', 'assert'].includes(msg.params.type)
      ) {
        this.problems.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.problems.push(d.exception?.description ?? d.text);
      }
    });
    return this;
  }

  /**
   * Runs the body of an async function in the page. Values reach it as `args`, a CDP call
   * argument, so none is ever spliced into the source.
   * @param {string} body - The function body; `return` gives the value back
   * @param {Record<string, unknown>} [args] - Values the body reads as `args.<name>`
   * @returns {Promise<any>} What it returned
   */
  async eval(body, args = {}) {
    const { result: global } = await this.cdp.send('Runtime.evaluate', {
      expression: 'globalThis',
    });
    const r = await this.cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: `async function (args) { ${body} }`,
      objectId: global.objectId,
      arguments: [{ value: args }],
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    await this.cdp.send('Runtime.releaseObject', { objectId: global.objectId });
    if (r.exceptionDetails) {
      throw new Error(
        'eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
      );
    }
    return r.result.value;
  }

  /**
   * Saves a screenshot to SHOTS.
   * @param {string} name - The file name, without .png
   * @returns {Promise<string>} The file's path
   */
  async shot(name) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  /**
   * Emulates the colour scheme.
   * @param {boolean} dark - Dark, else light
   * @returns {Promise<void>} Resolves once set
   */
  async scheme(dark) {
    await this.cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
    });
  }

  /**
   * Sends one mouse event.
   * @param {string} type - mouseMoved, mousePressed or mouseReleased
   * @param {number} x - CSS pixels from the viewport's start
   * @param {number} y - CSS pixels from the viewport's top
   * @returns {Promise<void>} Resolves once sent
   */
  async mouse(type, x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }

  /**
   * Clicks a point the way a user does.
   * @param {{x: number, y: number}} at - The point
   * @returns {Promise<void>} Resolves a moment after the click
   */
  async clickAt({ x, y }) {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
    await sleep(250);
  }

  /**
   * Clicks the first element matching `selector` whose text or label includes `text`.
   * @param {string} selector - A CSS selector
   * @param {string} [text] - Text it must include
   * @returns {Promise<void>} Resolves a moment after the click
   */
  async click(selector, text = '') {
    const at = await this.eval(
      `
      const e = [...document.querySelectorAll(args.selector)].find((e) =>
        (e.innerText || e.getAttribute('aria-label') || '').includes(args.text));
      if (!e) return null;
      // Instant: the page scrolls smoothly, and a box read mid-scroll misses the element.
      e.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
      { selector, text },
    );
    if (!at) throw new Error(`click: no ${selector} with "${text}"`);
    await this.clickAt(at);
  }

  /**
   * Clicks the room row whose name is exactly `name`.
   * @param {string} name - The room
   * @returns {Promise<void>} Resolves a moment after the click
   */
  async clickRoom(name) {
    const at = await this.eval(
      `
      const l = [...document.querySelectorAll('label')].find((l) =>
        l.innerText.split('\\n')[0].trim() === args.name);
      if (!l) return null;
      l.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r = l.getBoundingClientRect();
      return { x: r.x + 24, y: r.y + r.height / 2 };`,
      { name },
    );
    if (!at) throw new Error(`no room ${name}`);
    await this.clickAt(at);
  }

  /**
   * Presses a key.
   * @param {string} key - The key, for example Enter
   * @returns {Promise<void>} Resolves once sent
   */
  async key(key) {
    // The virtual key code (and Enter's text) is what makes Chromium act on the key: submit a
    // form, delete, move focus. Without it the event reaches only key listeners.
    const codes = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ' ': 32, Delete: 46 };
    const vk = codes[key];
    const extra = vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {};
    const code = key === ' ' ? 'Space' : key;
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: key === 'Enter' ? 'keyDown' : 'rawKeyDown',
      key,
      code,
      ...(key === 'Enter' ? { text: '\r' } : {}),
      ...extra,
    });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, ...extra });
  }

  /**
   * Types text into the focused field.
   * @param {string} text - The text
   * @returns {Promise<void>} Resolves once typed
   */
  async type(text) {
    await this.cdp.send('Input.insertText', { text });
  }

  /**
   * Every range input, as `label=value`, `(disabled)` when disabled.
   * @returns {Promise<string[]>} One entry per slider
   */
  ranges() {
    return this.eval(`return [...document.querySelectorAll('input[type=range]')].map((r) =>
      r.getAttribute('aria-label') + '=' + r.value + (r.disabled ? '(disabled)' : ''));`);
  }

  /**
   * The page's visible text.
   * @returns {Promise<string>} document.body.innerText
   */
  text() {
    return this.eval('return document.body.innerText');
  }

  /** Closes the session. */
  close() {
    this.cdp.ws.close();
  }
}

/**
 * Launches Chromium with the extension and returns handles to drive it.
 * @param {object} [options] - Launch options
 * @param {string} [options.profile] - Profile name; its directory is under the temp dir
 * @param {number} [options.scale] - Device scale factor (1.25 for 125 %)
 * @param {boolean} [options.fresh] - Start from an empty profile
 * @returns {Promise<object>} The browser, its context, the service worker and helpers
 */
export async function launch({ profile = 'check', scale = 1, fresh = true } = {}) {
  const dir = join(tmpdir(), `thaumic-real-ext-${profile}`);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  const port = 9333 + Math.floor(Math.random() * 500);
  const cp = spawn(
    process.env.CHROME ?? chromium.executablePath(),
    [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      `--force-device-scale-factor=${scale}`,
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--allowlisted-extension-id=${unpackedId(EXT)}`,
      '--auto-accept-this-tab-capture',
      // Lets CDP's Extensions.loadUnpacked reload the extension in place, as an update does.
      '--enable-unsafe-extension-debugging',
      '--window-size=1200,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    await sleep(250);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  }
  if (!browser) throw new Error('Chromium did not start');
  const ctx = browser.contexts()[0];
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker-loader'));
    if (!sw) await sleep(250);
  }
  if (!sw) throw new Error('the extension did not load from ' + EXT);
  const id = sw.url().split('/')[2];
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json();

  const env = { browser, ctx, sw, id, port, targets };
  /**
   * Opens the tone page in a tab and plays it.
   * @param {object} [page] - A Playwright page to reuse; a new tab otherwise
   * @returns {Promise<object>} The page
   */
  env.audioTab = async (page) => {
    const p = page ?? (ctx.pages().find((x) => x.url() === 'about:blank') || (await ctx.newPage()));
    await p.goto(`http://127.0.0.1:${AUDIO_PORT}/`);
    await p.bringToFront();
    await p.click('#play').catch(() => {});
    return p;
  };
  /**
   * Attaches to the first page target whose URL includes `part`.
   * @param {string} part - Part of its URL
   * @returns {Promise<Target>} The target
   */
  env.attach = async (part) => {
    for (let i = 0; i < 30; i++) {
      const t = (await targets()).find((x) => x.type === 'page' && x.url.includes(part));
      if (t) return new Target(await Cdp.connect(t.webSocketDebuggerUrl)).init();
      await sleep(200);
    }
    throw new Error('no target ' + part);
  };
  /**
   * Opens the real toolbar popup over the active tab and attaches to it.
   * @param {object} [opts] - Options
   * @param {boolean} [opts.dark] - Colour scheme to emulate
   * @param {number} [opts.settle] - How long to wait for it to render, in ms
   * @returns {Promise<Target>} The popup
   */
  env.popup = async ({ dark, settle = 1200 } = {}) => {
    for (const t of (await targets()).filter((x) => x.url.includes('/src/popup/index.html'))) {
      await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
    }
    await sleep(400);
    let result;
    for (let i = 0; i < 5 && result !== 'ok'; i++) {
      result = await sw.evaluate(() =>
        chrome.action.openPopup().then(
          () => 'ok',
          (e) => e.message,
        ),
      );
      if (result !== 'ok') {
        await ctx
          .pages()
          .filter((x) => x.url().startsWith('http'))
          .at(-1)
          ?.bringToFront();
        await sleep(500);
      }
    }
    if (result !== 'ok') throw new Error('openPopup: ' + result);
    const popup = await env.attach('/src/popup/index.html');
    if (dark !== undefined) await popup.scheme(dark);
    await sleep(settle);
    return popup;
  };
  /**
   * Opens the options page in a tab and attaches to it.
   * @returns {Promise<Target>} The options page
   */
  env.options = async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/src/options/index.html`);
    await sleep(800);
    return env.attach('/src/options/index.html');
  };
  /**
   * Closes the browser.
   * @returns {Promise<void>} Resolves once closed
   */
  env.close = async () => {
    await browser.close().catch(() => {});
    cp.kill();
  };
  return env;
}

/**
 * Layout facts of a page that review checks lean on: the root, the page scrollers, header and
 * main boxes, and the colour painted in the root's gutters.
 */
export const METRICS = `
const box = (e) => {
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, cw: e.clientWidth,
    sw: e.scrollWidth, ch: e.clientHeight, sh: e.scrollHeight, gutter: cs.scrollbarGutter,
    bg: cs.backgroundColor, overflowY: cs.overflowY };
};
return {
  vw: innerWidth, vh: innerHeight,
  html: box(document.documentElement),
  scrollers: [...document.querySelectorAll('[data-scroller]')].map(box),
  header: box(document.querySelector('header')),
  main: box(document.querySelector('main')),
};`;
