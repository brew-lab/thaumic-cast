// The upgrade pass of the real-extension check: a build copied over the unpacked extension
// while it runs. Chrome keeps the running service worker (and the manifest) until the
// extension is reloaded, while the popup loads the new files, so the popup must notice the
// worker from the earlier build and reload the extension (lib/stale-worker.ts), once.
//
// The extension runs from a copy of dist/. The "new build" is made on disk by copying the
// worker's entry module to another hashed name and pointing the worker loader at it, which is
// what a rebuild with any change to the worker does. Developer mode is on, as it is wherever
// an unpacked build is loaded by hand (without it Chromium disables a reloaded unpacked
// extension). Needs no companion. Exit 1 on any failure. See README.md.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.REALEXT_EXT ?? join(HERE, '..', 'dist'));
const COPY = join(tmpdir(), 'thaumic-real-ext-upgrade-dist');
rmSync(COPY, { recursive: true, force: true });
cpSync(DIST, COPY, { recursive: true });
// lib reads the extension's directory when it is imported.
process.env.REALEXT_EXT = COPY;
const lib = await import('./lib.mjs');

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

const env = await lib.launch({ profile: 'upgrade' });
try {
  {
    const page = await env.ctx.newPage();
    await page.goto('chrome://extensions');
    await lib.sleep(500);
    await page.evaluate(
      () =>
        new Promise((r) =>
          chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r),
        ),
    );
    await page.close();
  }

  /**
   * The extension's service worker target, if it runs.
   * @returns {Promise<object | undefined>} The target
   */
  const worker = async () =>
    (await env.targets()).find((t) => t.type === 'service_worker' && t.url.includes(env.id));

  /**
   * Opens the popup in a tab (it runs the same start-up as the toolbar popup) and tells
   * whether the extension was reloaded under it: a reload starts a new worker target.
   * @returns {Promise<{ reloaded: boolean }>} Whether the extension reloaded
   */
  const openPopup = async () => {
    const was = (await worker())?.id;
    const page = await env.ctx.newPage();
    await page.goto(`chrome-extension://${env.id}/src/popup/index.html`).catch(() => {});
    await lib.sleep(2500);
    if (!page.isClosed()) await page.close().catch(() => {});
    for (let i = 0; i < 20 && !(await worker()); i++) await lib.sleep(250);
    return { reloaded: (await worker())?.id !== was };
  };

  /**
   * Asks the running worker which entry module it runs, from an extension page.
   * @returns {Promise<unknown>} Its answer
   */
  const ask = async () => {
    for (let i = 0; i < 20 && !(await worker()); i++) await lib.sleep(250);
    const page = await env.ctx.newPage();
    await page.goto(`chrome-extension://${env.id}/manifest.json`);
    const answer = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_WORKER_SCRIPT' }),
    );
    await page.close();
    return answer;
  };

  const loader = readFileSync(join(COPY, 'service-worker-loader.js'), 'utf8');
  const entry = loader.match(/assets\/main\.ts-[^'"]+\.js/)?.[0];
  check('the worker loader imports a hashed entry module', !!entry, loader);
  const before = await ask();
  check('the worker names the entry module it runs', before?.script === `/${entry}`, before);

  const first = await openPopup();
  check('a popup of the same build leaves the extension alone', !first.reloaded, first);

  // A new build on disk: the entry module under another hash, the loader pointing at it.
  const next = entry.replace(/main\.ts-[^.]+\.js$/, 'main.ts-Upgrade1.js');
  cpSync(join(COPY, entry), join(COPY, next));
  writeFileSync(join(COPY, 'service-worker-loader.js'), loader.replace(entry, next));
  const stale = await ask();
  check(
    'with a new build on disk the running worker is still the earlier one',
    stale?.script === `/${entry}`,
    stale,
  );

  const second = await openPopup();
  check(
    'the popup reloads the extension under a worker from an earlier build',
    second.reloaded,
    second,
  );
  const after = await ask();
  check('after the reload the worker runs the build on disk', after?.script === `/${next}`, after);

  const third = await openPopup();
  check('the next popup leaves the reloaded extension alone', !third.reloaded, third);
} finally {
  await env.close();
  rmSync(COPY, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed (upgrade)`);
process.exit(failed ? 1 : 0);
