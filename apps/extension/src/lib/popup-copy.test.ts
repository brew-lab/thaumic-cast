import { describe, expect, it } from 'bun:test';

import en from '../locales/en.json';
import { retryLabelKey } from './popup-copy';

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
