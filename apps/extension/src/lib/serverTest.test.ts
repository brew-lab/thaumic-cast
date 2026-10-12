import { describe, expect, it } from 'bun:test';
import { isServerUrl, serverAddressResult } from './serverTest';

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key;

describe('isServerUrl', () => {
  it('should accept http and https URLs', () => {
    expect(isServerUrl('http://192.168.1.20:49400')).toBe(true);
    expect(isServerUrl('https://cast.example')).toBe(true);
  });

  it('should reject what cannot be a companion address', () => {
    expect(isServerUrl('localhost 49400')).toBe(false);
    expect(isServerUrl('192.168.1.20:49400')).toBe(false);
    expect(isServerUrl('ftp://192.168.1.20')).toBe(false);
  });
});

describe('serverAddressResult', () => {
  it('should word a success with its latency, and say both', () => {
    expect(serverAddressResult({ success: true, latency: 12 }, t)).toEqual({
      ok: true,
      message: 'server_test_success',
      detail: 'server_status_latency:{"latency":12}',
      said: 'server_test_success, server_status_latency:{"latency":12}',
    });
  });

  it('should give the answer for a failure', () => {
    expect(serverAddressResult({ success: false, error: 'wrong_server' }, t)).toEqual({
      ok: false,
      error: 'error_wrong_server',
    });
    expect(serverAddressResult({ success: false }, t)).toEqual({
      ok: false,
      error: 'server_test_failed',
    });
  });
});
