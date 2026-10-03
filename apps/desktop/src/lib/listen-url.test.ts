import { describe, expect, it } from 'bun:test';

import { castsBySpeaker, listenUrl, type CastSession } from './listen-url';

describe('listenUrl', () => {
  it('should build an IPv4 URL with the extension for each codec', () => {
    const at = (codec: CastSession['codec']) =>
      listenUrl('192.168.1.5', 49400, { streamId: 'abc-123', codec });
    expect(at('pcm')).toBe('http://192.168.1.5:49400/stream/abc-123/listen.wav');
    expect(at('flac')).toBe('http://192.168.1.5:49400/stream/abc-123/listen.flac');
    expect(at('aac')).toBe('http://192.168.1.5:49400/stream/abc-123/listen');
    expect(at('mp3')).toBe('http://192.168.1.5:49400/stream/abc-123/listen');
  });

  it('should put an IPv6 address in brackets and escape its zone id', () => {
    const cast = { streamId: 'abc-123', codec: 'aac' } as const;
    expect(listenUrl('fd00::5', 49400, cast)).toBe('http://[fd00::5]:49400/stream/abc-123/listen');
    expect(listenUrl('fe80::1%eth0', 49400, cast)).toBe(
      'http://[fe80::1%25eth0]:49400/stream/abc-123/listen',
    );
    expect(listenUrl('[fd00::5]', 49400, cast)).toBe(
      'http://[fd00::5]:49400/stream/abc-123/listen',
    );
  });

  it('should give no URL while the address or port is not known', () => {
    const cast = { streamId: 'abc-123', codec: 'pcm' } as const;
    expect(listenUrl('', 49400, cast)).toBeNull();
    expect(listenUrl('192.168.1.5', 0, cast)).toBeNull();
    expect(listenUrl('192.168.1.5', 49400, { streamId: '', codec: 'pcm' })).toBeNull();
  });

  it('should escape a stream id that is not URL-safe', () => {
    expect(listenUrl('192.168.1.5', 49400, { streamId: 'a b/c', codec: 'mp3' })).toBe(
      'http://192.168.1.5:49400/stream/a%20b%2Fc/listen',
    );
  });
});

describe('castsBySpeaker', () => {
  it('should map each speaker to the cast it plays', () => {
    const sessions: CastSession[] = [
      { streamId: 's1', speakerIp: '10.0.0.2', codec: 'pcm', role: 'coordinator' },
      { streamId: 's1', speakerIp: '10.0.0.3', codec: 'pcm', role: 'slave' },
      { streamId: 's2', speakerIp: '10.0.0.4', codec: 'flac' },
    ];
    expect(castsBySpeaker(sessions)).toEqual({
      '10.0.0.2': { streamId: 's1', codec: 'pcm' },
      '10.0.0.3': { streamId: 's1', codec: 'pcm' },
      '10.0.0.4': { streamId: 's2', codec: 'flac' },
    });
  });

  it('should prefer the cast a speaker fetches over one it follows', () => {
    const sessions: CastSession[] = [
      { streamId: 'mine', speakerIp: '10.0.0.2', codec: 'aac', role: 'coordinator' },
      { streamId: 'old', speakerIp: '10.0.0.2', codec: 'pcm', role: 'slave' },
    ];
    expect(castsBySpeaker(sessions)['10.0.0.2']).toEqual({ streamId: 'mine', codec: 'aac' });
  });
});
