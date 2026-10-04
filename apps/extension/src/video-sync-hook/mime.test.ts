import { describe, expect, it } from 'bun:test';

import { classify, formatOf } from './mime';

describe('classify', () => {
  it('should read the codecs parameter', () => {
    expect(classify('audio/mp4; codecs="mp4a.40.2"')).toBe('audio');
    expect(classify('audio/mp4; codecs="mp4a.40.42"')).toBe('audio');
    expect(classify('audio/webm; codecs="opus"')).toBe('audio');
    expect(classify('video/mp4; codecs="avc1.64001f"')).toBe('video');
    expect(classify('video/webm; codecs="vp09.00.10.08"')).toBe('video');
    expect(classify('video/mp4; codecs="avc1.64001f, mp4a.40.2"')).toBe('muxed');
  });

  it('should fall back to the top-level type', () => {
    expect(classify('audio/mpeg')).toBe('audio');
    expect(classify('video/mp2t')).toBe('video');
    expect(classify('application/octet-stream')).toBe('other');
  });
});

describe('formatOf', () => {
  it('should know MP4 and WebM only', () => {
    expect(formatOf('audio/mp4; codecs="mp4a.40.2"')).toBe('mp4');
    expect(formatOf('video/iso.segment')).toBe('mp4');
    expect(formatOf('audio/webm; codecs="opus"')).toBe('webm');
    expect(formatOf('audio/aac')).toBe('unknown');
    expect(formatOf('video/mp2t; codecs="avc1.4d401f,mp4a.40.2"')).toBe('unknown');
  });
});
