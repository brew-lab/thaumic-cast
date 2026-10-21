import { describe, expect, it } from 'bun:test';

import { isExpectedClose } from './ws-close';

describe('isExpectedClose', () => {
  it('should treat the companion going away as expected', () => {
    for (const code of [1000, 1001, 1005, 1006]) expect(isExpectedClose(code)).toBe(true);
  });

  it('should treat a policy violation or server error as unexpected', () => {
    for (const code of [1002, 1003, 1008, 1011, 4000]) expect(isExpectedClose(code)).toBe(false);
  });
});
