import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig } from '@thaumic-cast/protocol';

import { actionCalls, resetChromeStub } from '../test-support/chrome-stub';
import { recordCastEnded, resetAwayLogForTests } from './away-log';
import { applyIngestGapsEvent, clearAllIngestGaps } from './ingest-gaps-state';
import { clearAllSessions, registerSession } from './session-manager';
import { resetToolbarBadgeForTests } from './toolbar-badge';
import { refreshToolbarBadge } from './toolbar-badge-runner';

const title = () => actionCalls.filter(([method]) => method === 'setTitle').at(-1)?.[1];

beforeEach(() => {
  resetChromeStub();
  resetAwayLogForTests();
  resetToolbarBadgeForTests();
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
