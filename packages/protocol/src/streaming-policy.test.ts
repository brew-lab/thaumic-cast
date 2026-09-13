import { describe, expect, it } from 'bun:test';

import { getStreamingPolicy } from './streaming-policy.js';

describe('getStreamingPolicy', () => {
  it('should drop frames under backpressure and bound latency in realtime mode', () => {
    const policy = getStreamingPolicy('realtime');

    expect(policy.dropOnBackpressure).toBe(true);
    expect(policy.catchUpMaxMs).not.toBeNull();
    expect(policy.catchUpTargetMs).toBeLessThan(policy.catchUpMaxMs!);
  });

  it('should queue frames and never catch up in quality mode', () => {
    const policy = getStreamingPolicy('quality');

    expect(policy.dropOnBackpressure).toBe(false);
    expect(policy.catchUpMaxMs).toBeNull();
  });

  it('should give quality mode more buffering headroom than realtime mode', () => {
    const quality = getStreamingPolicy('quality');
    const realtime = getStreamingPolicy('realtime');

    expect(quality.ringBufferSeconds).toBeGreaterThan(realtime.ringBufferSeconds);
    expect(quality.jitterBufferMs).toBeGreaterThan(realtime.jitterBufferMs);
    expect(quality.wsBufferHighWater).toBeGreaterThan(realtime.wsBufferHighWater);
  });
});
