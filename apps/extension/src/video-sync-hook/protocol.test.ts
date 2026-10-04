import { describe, expect, it } from 'bun:test';

import {
  BRIDGE_VERSION,
  LEAD_MESSAGE_TYPE,
  LEAD_REFRESH_MS,
  LEASE_MS,
  MAX_LEAD_MS,
  commandEventName,
  isNonce,
  leaseExpired,
  makeNonce,
  parseJson,
  statusEventName,
  validateCommand,
  validateLeadMessage,
  validateStatus,
  validateStatusMessage,
} from './protocol';

const NONCE = 'a'.repeat(32);
const set = (over: Record<string, unknown> = {}) => ({
  v: BRIDGE_VERSION,
  nonce: NONCE,
  op: 'set',
  enabled: true,
  leadMs: 900,
  ...over,
});

describe('nonces and event names', () => {
  it('should make 128-bit hex nonces that differ', () => {
    const a = makeNonce();
    expect(isNonce(a)).toBe(true);
    expect(a).not.toBe(makeNonce());
    expect(isNonce('xyz')).toBe(false);
    expect(isNonce(42)).toBe(false);
  });

  it('should derive the channel names from the nonce', () => {
    expect(commandEventName(NONCE)).toContain(NONCE);
    expect(statusEventName(NONCE)).not.toBe(commandEventName(NONCE));
  });
});

describe('validateCommand', () => {
  it('should accept a set and a rearm with the right nonce', () => {
    expect(validateCommand(set(), NONCE)).toEqual(set() as never);
    expect(validateCommand({ v: 1, nonce: NONCE, op: 'rearm' }, NONCE)).toEqual({
      v: 1,
      nonce: NONCE,
      op: 'rearm',
    });
  });

  it('should reject a wrong nonce or version', () => {
    expect(validateCommand(set({ nonce: 'b'.repeat(32) }), NONCE)).toBeNull();
    expect(validateCommand(set({ v: 2 }), NONCE)).toBeNull();
    expect(validateCommand(set({ v: '1' }), NONCE)).toBeNull();
  });

  it('should reject a lead out of range or not a number', () => {
    expect(validateCommand(set({ leadMs: -1 }), NONCE)).toBeNull();
    expect(validateCommand(set({ leadMs: MAX_LEAD_MS + 1 }), NONCE)).toBeNull();
    expect(validateCommand(set({ leadMs: Infinity }), NONCE)).toBeNull();
    expect(validateCommand(set({ leadMs: '900' }), NONCE)).toBeNull();
    expect(validateCommand(set({ enabled: 1 }), NONCE)).toBeNull();
    expect(validateCommand(set({ leadMs: MAX_LEAD_MS }), NONCE)).not.toBeNull();
  });

  it('should reject extra fields and unknown operations', () => {
    expect(validateCommand(set({ direction: 'video' }), NONCE)).toBeNull();
    expect(validateCommand(set({ op: 'get' }), NONCE)).toBeNull();
    expect(validateCommand({ v: 1, nonce: NONCE, op: 'rearm', x: 1 }, NONCE)).toBeNull();
    expect(validateCommand(null, NONCE)).toBeNull();
    expect(validateCommand([set()], NONCE)).toBeNull();
  });
});

describe('statuses', () => {
  const ok = { state: 'applied', appliedLeadMs: 896, playing: true };

  it('should accept a known state with an optional known reason', () => {
    expect(validateStatus(ok)).toEqual(ok as never);
    expect(validateStatus({ ...ok, state: 'unavailable', reason: 'muxed' })?.reason).toBe('muxed');
  });

  it('should reject unknown states, reasons, extra fields and bad numbers', () => {
    expect(validateStatus({ ...ok, state: 'great' })).toBeNull();
    expect(validateStatus({ ...ok, reason: 'because' })).toBeNull();
    expect(validateStatus({ ...ok, url: 'https://x' })).toBeNull();
    expect(validateStatus({ ...ok, appliedLeadMs: 1e9 })).toBeNull();
    expect(validateStatus({ ...ok, playing: 'yes' })).toBeNull();
  });

  it('should check the version and nonce of a status message', () => {
    expect(validateStatusMessage({ v: 1, nonce: NONCE, status: ok }, NONCE)).toEqual(ok as never);
    expect(validateStatusMessage({ v: 1, nonce: 'c'.repeat(32), status: ok }, NONCE)).toBeNull();
  });
});

describe('validateLeadMessage', () => {
  it('should accept a lead message, with or without rearm', () => {
    const m = { type: LEAD_MESSAGE_TYPE, enabled: true, leadMs: 900 };
    expect(validateLeadMessage(m)).toEqual(m as never);
    expect(validateLeadMessage({ ...m, rearm: true })?.rearm).toBe(true);
  });

  it('should reject other messages and bad values', () => {
    expect(validateLeadMessage({ type: 'REQUEST_METADATA' })).toBeNull();
    expect(
      validateLeadMessage({ type: LEAD_MESSAGE_TYPE, enabled: true, leadMs: 7000 }),
    ).toBeNull();
    expect(validateLeadMessage({ type: LEAD_MESSAGE_TYPE, enabled: true })).toBeNull();
  });
});

describe('lease', () => {
  it('should keep a lead for the lease and let it lapse after', () => {
    expect(leaseExpired(0, LEASE_MS)).toBe(false);
    expect(leaseExpired(0, LEASE_MS + 1)).toBe(true);
  });

  it('should leave room for a missed refresh or two within the lease', () => {
    expect(LEAD_REFRESH_MS * 3).toBeLessThan(LEASE_MS);
  });
});

describe('parseJson', () => {
  it('should parse strings only and never throw', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('{')).toBeUndefined();
    expect(parseJson({ a: 1 })).toBeUndefined();
    expect(parseJson('x'.repeat(5000))).toBeUndefined();
  });
});
