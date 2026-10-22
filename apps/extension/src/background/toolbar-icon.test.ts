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
  it('should pick the file set for each state and theme', () => {
    expect(toolbarIconFor(false, 'light')['16']).toBe('icons/action-light-idle-16.png');
    expect(toolbarIconFor(true, 'light')['24']).toBe('icons/action-light-lit-24.png');
    expect(toolbarIconFor(false, 'dark')['32']).toBe('icons/action-dark-idle-32.png');
    expect(toolbarIconFor(true, 'dark')['16']).toBe('icons/action-dark-lit-16.png');
  });

  it('should use the manifest icon and its lit twin while the theme is unknown', () => {
    expect(toolbarIconFor(false, null)).toEqual({
      '16': 'icons/action-16.png',
      '24': 'icons/action-24.png',
      '32': 'icons/action-32.png',
    });
    expect(toolbarIconFor(true, null)['16']).toBe('icons/action-lit-16.png');
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
    await writeToolbarIcon(toolbarIconFor(true, 'dark'));
    await writeToolbarIcon(toolbarIconFor(true, 'dark'));
    await writeToolbarIcon(toolbarIconFor(false, 'dark'));

    expect(actionCalls).toEqual([
      ['setIcon', { path: toolbarIconFor(true, 'dark') }],
      ['setIcon', { path: toolbarIconFor(false, 'dark') }],
    ]);
  });
});
