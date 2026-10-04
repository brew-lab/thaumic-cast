import { describe, expect, it } from 'bun:test';

import { elementRanges, intersectRanges, virtualRanges } from './ranges';

describe('virtualRanges', () => {
  it('should map native ranges back by the offset', () => {
    expect(virtualRanges([[9.1, 19.1]], -0.9, 0, null)).toEqual([[10, 20]]);
  });

  it('should never report negative times', () => {
    expect(virtualRanges([[0, 1]], 0.5, 0, null)).toEqual([[0, 0.5]]);
    expect(virtualRanges([[0, 0.3]], 0.5, 0, null)).toEqual([]);
  });

  it('should report the window start for a range clamped at native 0', () => {
    // audio 0.9 s earlier: native data can only start at 0, i.e. virtual 0.9,
    // but the player appended from 0 and must not refetch the first 0.9 s
    expect(virtualRanges([[0, 9.1]], -0.9, 0, 0)).toEqual([[0, 10]]);
    // the player's own window start wins when it is later than the first fragment
    expect(virtualRanges([[0, 9.1]], -0.9, 0.5, 0)).toEqual([[0.5, 10]]);
  });

  it('should leave ranges away from native 0 alone', () => {
    expect(virtualRanges([[2, 5]], -0.9, 0, 0)).toEqual([[2.9, 5.9]]);
  });

  it('should merge ranges that touch after the mapping', () => {
    expect(
      virtualRanges(
        [
          [0, 0.4],
          [0.4, 3],
        ],
        0.5,
        0,
        null,
      ),
    ).toEqual([[0, 2.5]]);
  });
});

describe('intersectRanges and elementRanges', () => {
  it('should intersect two lists', () => {
    expect(
      intersectRanges(
        [
          [0, 5],
          [6, 10],
        ],
        [
          [1, 7],
          [9, 12],
        ],
      ),
    ).toEqual([
      [1, 5],
      [6, 7],
      [9, 10],
    ]);
  });

  it('should intersect every buffer of an element', () => {
    expect(elementRanges([[[0, 10]], [[1, 8]], [[2, 9]]], false)).toEqual([[2, 8]]);
    expect(elementRanges([], false)).toEqual([]);
  });

  it('should stretch each last range to the highest end once ended', () => {
    expect(elementRanges([[[0, 10]], [[1, 8]]], true)).toEqual([[1, 10]]);
  });
});
