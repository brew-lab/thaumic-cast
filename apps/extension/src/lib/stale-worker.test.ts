import { describe, expect, it } from 'bun:test';

import {
  isWorkerStale,
  reloadIfWorkerStale,
  workerScriptResponse,
  type StaleWorkerDeps,
} from './stale-worker';

/** A build's worker loader, as CRXJS writes it. */
const LOADER = "import './assets/main.ts-CXFM-NDO.js';\n";
/** The loader the dev server writes. */
const DEV_LOADER =
  "import 'http://localhost:5173/@vite/env';\nimport 'http://localhost:5173/src/background/main.ts';\n";
const EXTENSION = 'chrome-extension://jpijcjhckddkjgnnhlbgednamjiklomc';

/**
 * Deps for reloadIfWorkerStale, recording the reloads.
 * @param answer - The worker's answer
 * @param loader - The loader on disk
 * @returns The deps and what they recorded
 */
function fakeDeps(
  answer: unknown,
  loader: string | undefined = LOADER,
): StaleWorkerDeps & { reloads: number; stored: Record<string, string> } {
  const deps = {
    reloads: 0,
    stored: {} as Record<string, string>,
    ask: async () => answer,
    readLoader: async () => loader,
    readReloadedFor: async () => deps.stored.reloadedFor,
    writeReloadedFor: async (value: string) => {
      deps.stored.reloadedFor = value;
    },
    reload: () => {
      deps.reloads += 1;
    },
  };
  return deps;
}

describe('workerScriptResponse', () => {
  it("should name the path of the worker's entry module", () => {
    expect(workerScriptResponse(`${EXTENSION}/assets/main.ts-CXFM-NDO.js`)).toEqual({
      script: '/assets/main.ts-CXFM-NDO.js',
    });
  });
});

describe('isWorkerStale', () => {
  it('should find a worker of the build on disk current', () => {
    expect(
      isWorkerStale(workerScriptResponse(`${EXTENSION}/assets/main.ts-CXFM-NDO.js`), LOADER),
    ).toBe(false);
  });

  it('should find a worker from another build stale', () => {
    expect(
      isWorkerStale(workerScriptResponse(`${EXTENSION}/assets/main.ts-CP-f4V5k.js`), LOADER),
    ).toBe(true);
  });

  it('should find a worker from before this check stale: it answers with the router default', () => {
    // What every earlier worker answers a message type it has no route for.
    expect(isWorkerStale({ success: true }, LOADER)).toBe(true);
  });

  it('should find the dev server worker current', () => {
    expect(
      isWorkerStale(
        workerScriptResponse('http://localhost:5173/src/background/main.ts'),
        DEV_LOADER,
      ),
    ).toBe(false);
  });

  it('should not act on a worker that did not answer', () => {
    expect(isWorkerStale(undefined, LOADER)).toBe(false);
  });

  it('should not act on a named script when the loader could not be read', () => {
    expect(isWorkerStale({ script: '/assets/main.ts-CP-f4V5k.js' }, undefined)).toBe(false);
  });
});

describe('reloadIfWorkerStale', () => {
  it('should reload the extension under a worker from an earlier build', async () => {
    const deps = fakeDeps({ success: true });
    expect(await reloadIfWorkerStale(deps)).toBe(true);
    expect(deps.reloads).toBe(1);
  });

  it('should leave a worker of the build on disk alone', async () => {
    const deps = fakeDeps({ script: '/assets/main.ts-CXFM-NDO.js' });
    expect(await reloadIfWorkerStale(deps)).toBe(false);
    expect(deps.reloads).toBe(0);
  });

  it('should reload once per build on disk, never again and again', async () => {
    const deps = fakeDeps({ script: '/assets/main.ts-CP-f4V5k.js' });
    expect(await reloadIfWorkerStale(deps)).toBe(true);
    expect(await reloadIfWorkerStale(deps)).toBe(false);
    expect(deps.reloads).toBe(1);
  });

  it('should reload again for the next build copied over', async () => {
    const deps = fakeDeps({ script: '/assets/main.ts-CP-f4V5k.js' });
    await reloadIfWorkerStale(deps);
    deps.readLoader = async () => "import './assets/main.ts-Next1234.js';\n";
    expect(await reloadIfWorkerStale(deps)).toBe(true);
    expect(deps.reloads).toBe(2);
  });

  it('should not reload when the check itself fails', async () => {
    const deps = fakeDeps({ success: true });
    deps.readReloadedFor = async () => {
      throw new Error('storage unavailable');
    };
    expect(await reloadIfWorkerStale(deps)).toBe(false);
    expect(deps.reloads).toBe(0);
  });
});
