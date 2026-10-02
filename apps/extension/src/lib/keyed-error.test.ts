import { describe, expect, it } from 'bun:test';

import { KeyedError, errorParamsOf } from './keyed-error';

describe('KeyedError', () => {
  it('should carry the key as its message and keep the values beside it', () => {
    const err = new KeyedError('error_max_sessions', { max: 10 });

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('error_max_sessions');
    expect(err.params).toEqual({ max: 10 });
  });

  it('should hand back the values of a keyed error and nothing for any other', () => {
    expect(errorParamsOf(new KeyedError('error_unsupported_sample_rate', { rate: 96000 }))).toEqual(
      { rate: 96000 },
    );
    expect(errorParamsOf(new Error('error_capture_denied'))).toBeUndefined();
    expect(errorParamsOf('error_capture_denied')).toBeUndefined();
    expect(errorParamsOf(undefined)).toBeUndefined();
  });
});
