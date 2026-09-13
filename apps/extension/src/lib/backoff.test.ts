import { describe, expect, it } from 'bun:test';

import { exponentialBackoff } from './backoff';

describe('exponentialBackoff', () => {
  it('should start at the initial delay on the first attempt', () => {
    expect(exponentialBackoff(1, 500, 5000)).toBe(500);
  });

  it('should double the delay on every further attempt', () => {
    expect(exponentialBackoff(2, 500, 5000)).toBe(1000);
    expect(exponentialBackoff(3, 500, 5000)).toBe(2000);
    expect(exponentialBackoff(4, 500, 5000)).toBe(4000);
  });

  it('should cap the delay at the maximum', () => {
    expect(exponentialBackoff(5, 500, 5000)).toBe(5000);
    expect(exponentialBackoff(50, 500, 5000)).toBe(5000);
  });

  it('should never exceed the maximum even when it is below the initial delay', () => {
    expect(exponentialBackoff(1, 100, 40)).toBe(40);
  });
});
