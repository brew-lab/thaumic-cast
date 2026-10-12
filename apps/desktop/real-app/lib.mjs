// The real-app rig: serves the desktop frontend's production build with the Tauri app's CSP,
// passes /ipc/* through to the real core (real_desktop_companion in thaumic-core), and opens
// it in Playwright's WebKit or Chromium with the Tauri bridge stood in for (tauri-shim.js).
// See README.md.
import { chromium, webkit } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');

/** The built frontend (`bun run build` in apps/desktop). */
export const DIST = resolve(process.env.REALAPP_DIST ?? join(APP, 'dist'));
/** Where screenshots go. */
export const SHOTS = resolve(process.env.REALAPP_SHOTS ?? join(HERE, 'shots'));
/** The fake household's control API, with the desktop's IPC. */
export const CONTROL = `http://127.0.0.1:${process.env.REALEXT_CONTROL_PORT ?? 49509}`;
/** The port the frontend is served on. */
export const PORT = Number(process.env.REALAPP_PORT ?? 49520);
/** The rooms of the fake household, as run.sh starts it. */
export const ROOMS = (
  process.env.REALEXT_ROOMS ?? 'Kitchen,Office,Living Room,Bedroom,Bathroom,Study'
).split(',');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * Waits.
 * @param {number} ms - How long
 * @returns {Promise<void>} Resolves after `ms`
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Calls the fake household's control API (GET for reads, POST for the rest).
 * @param {string} path - For example `/cast?rooms=Kitchen`
 * @returns {Promise<string>} The reply
 */
export async function control(path) {
  const read = /^\/(state|log|ipc\/calls)/.test(path);
  const res = await fetch(CONTROL + path, { method: read ? 'GET' : 'POST' });
  return res.text();
}

/**
 * Calls one desktop command on the real core, as the app would.
 * @param {string} command - The command
 * @param {object} [args] - Its arguments
 * @returns {Promise<unknown>} Its result
 */
export async function ipc(command, args = {}) {
  const res = await fetch(`${CONTROL}/ipc/${command}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
  return res.json();
}

/**
 * The bodies of index.html's inline scripts (those without a src), the ones Tauri hashes.
 * @param {string} html - The built index.html
 * @returns {string[]} Each script's text, as written
 */
function inlineScripts(html) {
  const lower = html.toLowerCase();
  const bodies = [];
  let at = lower.indexOf('<script');
  while (at !== -1) {
    const open = lower.indexOf('>', at);
    const close = open === -1 ? -1 : lower.indexOf('</script', open);
    if (close === -1) break;
    if (!/\ssrc\s*=/.test(lower.slice(at, open))) bodies.push(html.slice(open + 1, close));
    at = lower.indexOf('<script', close);
  }
  return bodies;
}

/**
 * The Content-Security-Policy the Tauri app runs under: tauri.conf.json's, with the hash of
 * each inline script in index.html added (Tauri adds them at build time), and the IPC origin
 * replaced by this server's own (the shim reaches the core through it).
 * @param {string} html - The built index.html
 * @returns {string} The policy
 */
function csp(html) {
  const conf = JSON.parse(readFileSync(join(APP, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const hashes = inlineScripts(html).map(
    (body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
  );
  return `${conf.app.security.csp.replace('connect-src ipc: http://ipc.localhost', "connect-src 'self'")}; script-src 'self' ${hashes.join(' ')}`;
}

/**
 * Serves the built frontend, with a history fallback for the app's routes, and passes
 * /ipc/* through to the core.
 * @returns {http.Server} The server, listening on PORT
 */
export function serve() {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`no build in ${DIST}`);
  const index = readFileSync(join(DIST, 'index.html'), 'utf8');
  const policy = csp(index);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/ipc/')) {
      const upstream = http.request(
        `${CONTROL}${url.pathname}${url.search}`,
        { method: req.method, headers: { 'content-type': 'application/json' } },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      // The event stream lasts as long as the page; end the core's side with it.
      res.on('close', () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
      return;
    }
    const file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    const asset = file.startsWith(DIST) && extname(file) && existsSync(file);
    res.writeHead(200, {
      'content-type': asset ? (TYPES[extname(file)] ?? 'application/octet-stream') : TYPES['.html'],
      'content-security-policy': policy,
    });
    res.end(asset ? readFileSync(file) : index);
  });
  server.listen(PORT, '127.0.0.1');
  return server;
}

/**
 * One page of the app, in a browser of its own.
 * @typedef {object} App
 * @property {import('@playwright/test').Page} page - The page
 * @property {string[]} problems - Console errors, failed requests and exceptions so far
 * @property {(step: string) => Promise<string>} shot - Saves a screenshot, named for the step
 * @property {(path?: string) => Promise<void>} goto - Opens a route and waits for the app
 * @property {() => Promise<void>} close - Closes the browser
 */

/**
 * Opens the app in a fresh browser.
 * @param {object} o - What to open
 * @param {'webkit' | 'chromium'} o.engine - The browser
 * @param {number} o.scale - The device scale
 * @param {'light' | 'dark'} o.scheme - The colour scheme
 * @param {{width: number, height: number}} o.size - The window, in CSS px
 * @param {boolean} [o.onboarded] - Start with onboarding done (otherwise a fresh profile)
 * @returns {Promise<App>} The app
 */
export async function open({ engine, scale, scheme, size, onboarded = true }) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch();
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: scale,
    colorScheme: scheme,
    // Chromium writes to the clipboard when the page may; WebKit's clipboard refuses a
    // write Playwright did not ask for, which is the refusal the copy control handles.
    permissions: engine === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [],
  });
  const version = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).version;
  await context.addInitScript({
    content: readFileSync(join(HERE, 'tauri-shim.js'), 'utf8').replace(
      '__REALAPP_VERSION__',
      version,
    ),
  });
  if (onboarded) {
    await context.addInitScript(() => {
      if (!localStorage.getItem('thaumic-cast-onboarding')) {
        localStorage.setItem(
          'thaumic-cast-onboarding',
          JSON.stringify({ completed: true, completedAt: new Date().toISOString() }),
        );
      }
    });
  }
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  page.on('requestfailed', (r) => {
    // The event stream is cut when the page closes or navigates; that is not a failure.
    if (!r.url().endsWith('/ipc/events')) problems.push(`request failed: ${r.url()}`);
  });
  mkdirSync(SHOTS, { recursive: true });
  return {
    page,
    problems,
    shot: async (step) => {
      const path = join(SHOTS, `${step}.png`);
      await page.screenshot({ path, fullPage: false });
      return path;
    },
    goto: async (path = '/') => {
      await page.goto(`http://127.0.0.1:${PORT}${path}`);
      await page.waitForSelector('#app > *', { timeout: 10000 });
      await page.evaluate(() => document.fonts.ready);
    },
    close: () => browser.close(),
  };
}
