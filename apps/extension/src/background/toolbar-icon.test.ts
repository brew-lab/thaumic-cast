import { beforeEach, describe, expect, it } from 'bun:test';

import { actionCalls, resetChromeStub } from '../test-support/chrome-stub';
import {
  isToolbarIconLit,
  resetToolbarIconForTests,
  toolbarIconFor,
  writeToolbarIcon,
} from './toolbar-icon';

beforeEach(() => {
  resetChromeStub();
  resetToolbarIconForTests();
});

describe('toolbarIconFor', () => {
  it('should pick the dark set on a dark toolbar', () => {
    expect(toolbarIconFor(false, true)['16']).toBe('icons/action-dark-idle-16.png');
    expect(toolbarIconFor(true, true)['32']).toBe('icons/action-dark-lit-32.png');
  });

  it('should pick the manifest icon and its lit twin on a light or unknown toolbar', () => {
    expect(toolbarIconFor(false, false)).toEqual({
      '16': 'icons/action-16.png',
      '24': 'icons/action-24.png',
      '32': 'icons/action-32.png',
    });
    expect(toolbarIconFor(true, false)['24']).toBe('icons/action-lit-24.png');
  });
});

describe('isToolbarIconLit', () => {
  it('should light while any cast runs, and not with none', () => {
    expect(isToolbarIconLit([])).toBe(false);
    expect(isToolbarIconLit([{ streamId: 's1', tabId: 4 }])).toBe(true);
  });
});

describe('writeToolbarIcon', () => {
  it('should write a changed icon once, for every tab', async () => {
    await writeToolbarIcon(toolbarIconFor(true, true));
    await writeToolbarIcon(toolbarIconFor(true, true));
    await writeToolbarIcon(toolbarIconFor(false, true));

    expect(actionCalls).toEqual([
      ['setIcon', { path: toolbarIconFor(true, true) }],
      ['setIcon', { path: toolbarIconFor(false, true) }],
    ]);
  });
});
