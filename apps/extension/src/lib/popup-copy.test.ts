import { describe, expect, it } from 'bun:test';

import en from '../locales/en.json';
import { captureHealthAlert, retryLabelKey } from './popup-copy';

const strings = en as Record<string, string>;

describe('retryLabelKey', () => {
  it('should offer to reconnect only when a connection was lost', () => {
    expect(retryLabelKey('error_connection_lost')).toBe('retry_connection');
  });

  it('should offer to try again for every other connection error', () => {
    expect(retryLabelKey('error_desktop_not_found')).toBe('retry_connection_not_found');
    expect(retryLabelKey('error_permission_needed')).toBe('retry_connection_not_found');
    expect(retryLabelKey('Something the companion said')).toBe('retry_connection_not_found');
  });

  it('should have a string for both labels', () => {
    expect(strings.retry_connection).toBeString();
    expect(strings.retry_connection_not_found).toBeString();
  });
});

describe('captureHealthAlert', () => {
  it('should recommend browser-wide capture and offer settings on Windows', () => {
    expect(captureHealthAlert(true)).toEqual({
      key: 'capture_health_frame_drops_message',
      hasAction: true,
    });
  });

  it('should say only what is wrong, with no button, where the setting does not exist', () => {
    const alert = captureHealthAlert(false);

    expect(alert).toEqual({
      key: 'capture_health_frame_drops_message_no_remedy',
      hasAction: false,
    });
    expect(strings[alert.key]).not.toMatch(/browser-wide/i);
  });

  it('should have a string for both messages', () => {
    expect(strings[captureHealthAlert(true).key]).toBeString();
    expect(strings[captureHealthAlert(false).key]).toBeString();
  });
});
