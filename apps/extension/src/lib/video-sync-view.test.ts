import { describe, expect, it } from 'bun:test';
import { VideoSyncReasonSchema } from '@thaumic-cast/protocol';
import en from '../locales/en.json';
import { videoSyncAction, videoSyncReasonKey } from './video-sync-view';

const strings = en as Record<string, string>;

describe('videoSyncAction', () => {
  it('should offer nothing before the background answers', () => {
    expect(videoSyncAction(undefined, undefined)).toBeUndefined();
  });

  it('should offer nothing while off, locking, in step or with nothing to watch', () => {
    for (const phase of ['off', 'locking', 'in-step', 'no-video'] as const) {
      expect(videoSyncAction(phase, undefined)).toBeUndefined();
    }
  });

  it('should offer Reload page for a page open before video sync was on', () => {
    expect(videoSyncAction('unavailable', 'reload')).toBe('reload');
  });

  it('should offer nothing for a reload reason left over while locking on again', () => {
    expect(videoSyncAction('locking', 'reload')).toBeUndefined();
  });

  it('should offer nothing for any other reason it cannot sync', () => {
    for (const reason of VideoSyncReasonSchema.options) {
      if (reason === 'reload' || reason === 'freeze' || reason === 'live-edge') continue;
      expect(videoSyncAction('unavailable', reason)).toBeUndefined();
    }
  });

  it('should offer Try again when the player turned the early sound off', () => {
    expect(videoSyncAction('turned-off', 'freeze')).toBe('try-again');
    expect(videoSyncAction('turned-off', 'live-edge')).toBe('try-again');
    expect(videoSyncAction('turned-off', undefined)).toBe('try-again');
  });
});

describe('videoSyncReasonKey', () => {
  it('should have a sentence for every reason the background sends', () => {
    for (const reason of VideoSyncReasonSchema.options) {
      expect(strings[videoSyncReasonKey(reason)]).toBeString();
    }
  });
});
