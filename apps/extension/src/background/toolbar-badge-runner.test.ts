import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig } from '@thaumic-cast/protocol';

import { actionCalls, chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import { recordCastEnded, resetAwayLogForTests } from './away-log';
import { applyIngestGapsEvent, clearAllIngestGaps } from './ingest-gaps-state';
import { clearAllSessions, registerSession } from './session-manager';
import { resetToolbarBadgeForTests } from './toolbar-badge';
import { refreshToolbarBadge, startToolbarBadge } from './toolbar-badge-runner';
import { resetToolbarIconForTests, toolbarIconFor } from './toolbar-icon';
import { setToolbarDark } from './toolbar-badge';

const icon = () => actionCalls.filter(([method]) => method === 'setIcon').at(-1)?.[1];
const title = () => actionCalls.filter(([method]) => method === 'setTitle').at(-1)?.[1];

beforeEach(() => {
  resetChromeStub();
  resetAwayLogForTests();
  resetToolbarBadgeForTests();
  resetToolbarIconForTests();
  clearAllSessions();
  clearAllIngestGaps();
});

afterEach(() => {
  clearAllIngestGaps();
});

describe('refreshToolbarBadge', () => {
  it('should show gaps on a running cast, and clear once the cast is gone', async () => {
    registerSession(
      4,
      's1',
      ['192.168.1.10'],
      ['Kitchen'],
      createEncoderConfig({ codec: 'pcm' }),
      false,
    );
    applyIngestGapsEvent(
      {
        type: 'ingestGaps',
        streamId: 's1',
        gapsLastMinute: 3,
        worstGapMs: 80,
        smoothingMs: 200,
        timestamp: 0,
      },
      Date.now(),
    );

    await refreshToolbarBadge();
    expect(title()).toEqual({ title: 'Thaumic Cast: Gaps in the sound' });

    clearAllSessions();
    await refreshToolbarBadge();
    expect(title()).toEqual({ title: 'Thaumic Cast' });
    expect(actionCalls.at(-2)).toEqual(['setBadgeText', { text: '' }]);
  });

  it('should show an unseen fault from the away log', async () => {
    await recordCastEnded(4, 'Song', 'Kitchen', 'capture_error');

    await refreshToolbarBadge();

    expect(title()).toEqual({ title: 'Thaumic Cast: Cast to Song ended' });
  });
});

describe('the toolbar icon', () => {
  const cast = (): void =>
    registerSession(
      4,
      's1',
      ['192.168.1.10'],
      ['Kitchen'],
      createEncoderConfig({ codec: 'pcm' }),
      false,
    );

  it('should light while a cast runs and go out when it stops', async () => {
    await setToolbarDark(false);
    await refreshToolbarBadge();
    expect(icon()).toEqual({ path: toolbarIconFor(false, 'light') });

    cast();
    await refreshToolbarBadge();
    expect(icon()).toEqual({ path: toolbarIconFor(true, 'light') });

    clearAllSessions();
    await refreshToolbarBadge();
    expect(icon()).toEqual({ path: toolbarIconFor(false, 'light') });
  });

  it('should follow the theme the popup or offscreen document reports', async () => {
    cast();
    await refreshToolbarBadge();
    expect(icon()).toEqual({ path: toolbarIconFor(true, null) });

    await setToolbarDark(true);
    expect(chromeStorageData.session.toolbarDark).toBe(true);
    await refreshToolbarBadge();
    expect(icon()).toEqual({ path: toolbarIconFor(true, 'dark') });

    await setToolbarDark(false);
    await refreshToolbarBadge();
    expect(icon()).toEqual({ path: toolbarIconFor(true, 'light') });
  });

  it('should not write the same icon twice', async () => {
    await setToolbarDark(true);
    await refreshToolbarBadge();
    await refreshToolbarBadge();
    expect(actionCalls.filter(([method]) => method === 'setIcon')).toHaveLength(1);
  });

  it('should wait for the restored casts, then follow a theme change by itself', async () => {
    let restore = (): void => {};
    const restored = new Promise<void>((resolve) => (restore = resolve));
    const stop = startToolbarBadge(restored);
    try {
      await Bun.sleep(150);
      expect(icon()).toBeUndefined();

      cast();
      restore();
      await Bun.sleep(150);
      expect(icon()).toEqual({ path: toolbarIconFor(true, null) });

      await setToolbarDark(true);
      await Bun.sleep(150);
      expect(icon()).toEqual({ path: toolbarIconFor(true, 'dark') });
    } finally {
      stop();
    }
  });
});
