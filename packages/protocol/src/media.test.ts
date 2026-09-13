import { describe, expect, it } from 'bun:test';

import {
  createTabMediaState,
  getDisplayImage,
  getDisplaySubtitle,
  getDisplayTitle,
  parseMediaMetadata,
  type MediaMetadata,
  type TabMediaState,
} from './media.js';

function mediaState(overrides: Partial<TabMediaState> = {}): TabMediaState {
  return {
    tabId: 7,
    tabTitle: 'Tab Title',
    metadata: null,
    supportedActions: [],
    playbackState: 'none',
    updatedAt: 0,
    ...overrides,
  };
}

describe('parseMediaMetadata', () => {
  it('should accept metadata with a title and optional fields', () => {
    const metadata: MediaMetadata = {
      title: 'Song',
      artist: 'Band',
      album: 'Album',
      artwork: 'https://cdn.example.com/art.jpg',
    };

    expect(parseMediaMetadata(metadata)).toEqual(metadata);
  });

  it('should return null when the title is missing or empty', () => {
    expect(parseMediaMetadata({ artist: 'Band' })).toBeNull();
    expect(parseMediaMetadata({ title: '' })).toBeNull();
  });

  it('should return null when the artwork is not a URL', () => {
    expect(parseMediaMetadata({ title: 'Song', artwork: 'art.jpg' })).toBeNull();
  });

  it('should drop fields the schema does not know', () => {
    expect(parseMediaMetadata({ title: 'Song', genre: 'Jazz' })).toEqual({ title: 'Song' });
  });
});

describe('createTabMediaState', () => {
  it('should fall back to a placeholder title when the tab has none', () => {
    expect(createTabMediaState({ id: 1 }).tabTitle).toBe('Unknown Tab');
    expect(createTabMediaState({ id: 1, title: '' }).tabTitle).toBe('Unknown Tab');
  });

  it('should default to no metadata, no actions and no playback', () => {
    const state = createTabMediaState({ id: 1, title: 'Tab' });

    expect(state.metadata).toBeNull();
    expect(state.supportedActions).toEqual([]);
    expect(state.playbackState).toBe('none');
  });

  it('should carry the tab images and source through', () => {
    const state = createTabMediaState({
      id: 1,
      favIconUrl: 'https://example.com/favicon.ico',
      ogImage: 'https://example.com/og.png',
      source: 'Example',
    });

    expect(state).toMatchObject({
      tabFavicon: 'https://example.com/favicon.ico',
      tabOgImage: 'https://example.com/og.png',
      source: 'Example',
    });
  });
});

describe('display helpers', () => {
  it('should prefer the metadata title and fall back to the tab title', () => {
    expect(getDisplayTitle(mediaState({ metadata: { title: 'Song' } }))).toBe('Song');
    expect(getDisplayTitle(mediaState())).toBe('Tab Title');
  });

  it('should prefer artwork, then the og:image, then the favicon', () => {
    const favicon = 'https://example.com/favicon.ico';
    const og = 'https://example.com/og.png';
    const art = 'https://example.com/art.jpg';

    expect(getDisplayImage(mediaState())).toBeUndefined();
    expect(getDisplayImage(mediaState({ tabFavicon: favicon }))).toBe(favicon);
    expect(getDisplayImage(mediaState({ tabFavicon: favicon, tabOgImage: og }))).toBe(og);
    expect(
      getDisplayImage(
        mediaState({ tabFavicon: favicon, tabOgImage: og, metadata: { title: 'S', artwork: art } }),
      ),
    ).toBe(art);
  });

  it('should build the subtitle from artist and album only when there is an artist', () => {
    expect(getDisplaySubtitle(mediaState())).toBeUndefined();
    expect(
      getDisplaySubtitle(mediaState({ metadata: { title: 'S', album: 'A' } })),
    ).toBeUndefined();
    expect(getDisplaySubtitle(mediaState({ metadata: { title: 'S', artist: 'Band' } }))).toBe(
      'Band',
    );
    expect(
      getDisplaySubtitle(mediaState({ metadata: { title: 'S', artist: 'Band', album: 'Album' } })),
    ).toBe('Band • Album');
  });
});
