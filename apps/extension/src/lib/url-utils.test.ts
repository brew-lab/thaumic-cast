import { describe, expect, it } from 'bun:test';

import { getSourceFromUrl } from './url-utils';

describe('getSourceFromUrl', () => {
  it('should fall back to Browser when there is no usable URL', () => {
    expect(getSourceFromUrl(undefined)).toBe('Browser');
    expect(getSourceFromUrl('')).toBe('Browser');
    expect(getSourceFromUrl('not a url')).toBe('Browser');
  });

  it('should map well-known services to their display names', () => {
    expect(getSourceFromUrl('https://open.spotify.com/track/abc')).toBe('Spotify');
    expect(getSourceFromUrl('https://twitch.tv/somebody')).toBe('Twitch');
  });

  it('should ignore a leading www', () => {
    expect(getSourceFromUrl('https://www.youtube.com/watch?v=123')).toBe('YouTube');
  });

  it('should prefer the most specific mapping for a subdomain', () => {
    expect(getSourceFromUrl('https://music.youtube.com/watch?v=123')).toBe('YouTube Music');
  });

  it('should map unlisted subdomains of a known service to the service', () => {
    expect(getSourceFromUrl('https://m.soundcloud.com/artist/track')).toBe('SoundCloud');
  });

  it('should capitalise the main domain label for unknown sites', () => {
    expect(getSourceFromUrl('https://example.com/audio')).toBe('Example');
    expect(getSourceFromUrl('https://player.example.com/audio')).toBe('Example');
    expect(getSourceFromUrl('http://localhost:3000/')).toBe('Localhost');
  });
});
