/**
 * The bridge between the video sync hook (page MAIN world) and its relay
 * (ISOLATED world), and the status the relay passes on to the extension.
 *
 * Both scripts run at document_start, before any page script. They pair with
 * a synchronous hello exchange on `window` in which the relay hands the hook
 * a random nonce. From then on each direction uses a CustomEvent whose name
 * is derived from the nonce, carrying a JSON string (only strings cross the
 * two worlds reliably). A page script cannot listen for an event name it
 * does not know, and every message is still checked for version, nonce and
 * shape. This is best effort: a page can always disturb its own audio and
 * video timing, and the relay forwards nothing but bounded enums and numbers.
 *
 * Hand-written validators keep zod out of the page bundles.
 */

/** Bridge protocol version. */
export const BRIDGE_VERSION = 1;

/** Largest lead the hook accepts, in ms. */
export const MAX_LEAD_MS = 6000;

/** Event the relay dispatches to hand over its nonce. */
export const HELLO_RELAY_EVENT = '__tcvs_hello_relay';
/** Event the hook dispatches when it installs, asking for the nonce. */
export const HELLO_HOOK_EVENT = '__tcvs_hello_hook';

/** How often the relay re-sends the current command, in ms. */
export const RESEND_MS = 2000;

/**
 * How long the relay keeps a lead alive without hearing from the background,
 * in ms. After that it stops re-sending, and the hook's dead-man switch takes
 * the lead off: a background that lost its state (a service-worker restart)
 * or missed the end of a cast can never leave a page playing its sound early.
 */
export const LEASE_MS = 10000;

/**
 * How often the background must send a wanted lead again, in ms, to keep
 * the relay's lease (and to reach frames and pages that loaded since).
 */
export const LEAD_REFRESH_MS = 3000;

/**
 * Whether the relay's lease on a lead has run out.
 * @param heardAt - When the background last sent a lead, in ms
 * @param now - The time now, in ms (same clock)
 * @returns True once more than {@link LEASE_MS} has passed
 */
export function leaseExpired(heardAt: number, now: number): boolean {
  return now - heardAt > LEASE_MS;
}

/**
 * Name of the relay-to-hook command event for a nonce.
 * @param nonce - The pairing nonce
 * @returns The event name
 */
export function commandEventName(nonce: string): string {
  return `__tcvs_c_${nonce}`;
}

/**
 * Name of the hook-to-relay status event for a nonce.
 * @param nonce - The pairing nonce
 * @returns The event name
 */
export function statusEventName(nonce: string): string {
  return `__tcvs_s_${nonce}`;
}

/**
 * Makes a random 128-bit nonce as 32 hex characters.
 * @returns The nonce
 */
export function makeNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Shape of a nonce. */
const NONCE_RE = /^[0-9a-f]{32}$/;

/**
 * Command: apply a lead (or none). Re-sent every {@link RESEND_MS} as the
 * heartbeat the hook's dead-man switch listens for.
 */
export interface SetCommand {
  v: typeof BRIDGE_VERSION;
  nonce: string;
  op: 'set';
  enabled: boolean;
  /** Lead in ms of wall time, 0..{@link MAX_LEAD_MS}. */
  leadMs: number;
}

/**
 * Command: clear a "turned off" latch so the lead may apply again.
 */
export interface RearmCommand {
  v: typeof BRIDGE_VERSION;
  nonce: string;
  op: 'rearm';
}

/** A relay-to-hook command. */
export type HookCommand = SetCommand | RearmCommand;

/** States the hook reports. */
export const HOOK_STATES = [
  'idle',
  'no-media',
  'ready',
  'switching',
  'applied',
  'pending',
  'off',
  'unavailable',
] as const;

/** A state the hook reports. */
export type HookState = (typeof HOOK_STATES)[number];

/** Reasons that go with `unavailable`, `off` or `pending`. */
export const HOOK_REASONS = [
  'muxed',
  'worker',
  'no-mse',
  'live-edge',
  'no-rap',
  'freeze',
  'format',
] as const;

/** A reason the hook reports. */
export type HookReason = (typeof HOOK_REASONS)[number];

/**
 * What the hook says about its frame.
 */
export interface HookStatus {
  state: HookState;
  reason?: HookReason;
  /** The lead in force, in ms of wall time, after whole-frame rounding. */
  appliedLeadMs: number;
  /** The frame's chosen media element is playing. */
  playing: boolean;
}

/**
 * Hook-to-relay status message.
 */
export interface StatusMessage {
  v: typeof BRIDGE_VERSION;
  nonce: string;
  status: HookStatus;
}

/**
 * Reads a plain object.
 * @param x - Any value
 * @returns The value as a record, or null
 */
function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

/**
 * Whether an object has exactly the given keys (some optional).
 * @param o - The object
 * @param required - Keys that must be present
 * @param optional - Keys that may be present
 * @returns True when nothing is missing or extra
 */
function exactKeys(
  o: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const k of required) if (!(k in o)) return false;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

/**
 * Parses a JSON string, never throwing.
 * @param s - Any value; only strings are parsed
 * @param parse - The JSON parser to use (the hook passes the native one it
 *   took before page scripts ran, so a page cannot read messages by patching
 *   JSON.parse)
 * @returns The parsed value, or undefined
 */
export function parseJson(s: unknown, parse: (text: string) => unknown = JSON.parse): unknown {
  if (typeof s !== 'string' || s.length > 4096) return undefined;
  try {
    return parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Validates a relay-to-hook command.
 * @param x - The parsed message
 * @param nonce - The pairing nonce it must carry
 * @returns The command, or null when it is not one
 */
export function validateCommand(x: unknown, nonce: string): HookCommand | null {
  const o = asRecord(x);
  if (!o || o.v !== BRIDGE_VERSION || typeof o.nonce !== 'string' || o.nonce !== nonce) return null;
  if (o.op === 'set') {
    if (!exactKeys(o, ['v', 'nonce', 'op', 'enabled', 'leadMs'])) return null;
    if (typeof o.enabled !== 'boolean') return null;
    if (typeof o.leadMs !== 'number' || !Number.isFinite(o.leadMs)) return null;
    if (o.leadMs < 0 || o.leadMs > MAX_LEAD_MS) return null;
    return { v: BRIDGE_VERSION, nonce, op: 'set', enabled: o.enabled, leadMs: o.leadMs };
  }
  if (o.op === 'rearm') {
    if (!exactKeys(o, ['v', 'nonce', 'op'])) return null;
    return { v: BRIDGE_VERSION, nonce, op: 'rearm' };
  }
  return null;
}

/**
 * Validates a hook status.
 * @param x - The status object
 * @returns A clean copy, or null when it is not one
 */
export function validateStatus(x: unknown): HookStatus | null {
  const o = asRecord(x);
  if (!o || !exactKeys(o, ['state', 'appliedLeadMs', 'playing'], ['reason'])) return null;
  if (!HOOK_STATES.includes(o.state as HookState)) return null;
  if (o.reason !== undefined && !HOOK_REASONS.includes(o.reason as HookReason)) return null;
  if (typeof o.appliedLeadMs !== 'number' || !Number.isFinite(o.appliedLeadMs)) return null;
  if (o.appliedLeadMs < 0 || o.appliedLeadMs > MAX_LEAD_MS) return null;
  if (typeof o.playing !== 'boolean') return null;
  const out: HookStatus = {
    state: o.state as HookState,
    appliedLeadMs: Math.round(o.appliedLeadMs),
    playing: o.playing,
  };
  if (o.reason !== undefined) out.reason = o.reason as HookReason;
  return out;
}

/**
 * Validates a hook-to-relay status message.
 * @param x - The parsed message
 * @param nonce - The pairing nonce it must carry
 * @returns The status, or null when it is not one
 */
export function validateStatusMessage(x: unknown, nonce: string): HookStatus | null {
  const o = asRecord(x);
  if (!o || !exactKeys(o, ['v', 'nonce', 'status'])) return null;
  if (o.v !== BRIDGE_VERSION || o.nonce !== nonce) return null;
  return validateStatus(o.status);
}

/**
 * Whether a string is a well-formed nonce.
 * @param x - Any value
 * @returns True for 32 lowercase hex characters
 */
export function isNonce(x: unknown): x is string {
  return typeof x === 'string' && NONCE_RE.test(x);
}

/** Runtime message type: background to every relay of a tab. */
export const LEAD_MESSAGE_TYPE = 'VIDEO_SYNC_LEAD';

/** Runtime message type: a relay to the background. */
export const HOOK_STATUS_MESSAGE_TYPE = 'VIDEO_SYNC_HOOK_STATUS';

/**
 * The lead the background wants in a tab, sent to every frame's relay.
 */
export interface LeadMessage {
  type: typeof LEAD_MESSAGE_TYPE;
  enabled: boolean;
  /** Lead in ms of wall time, 0..{@link MAX_LEAD_MS}. */
  leadMs: number;
  /** Also clear any "turned off" latch. */
  rearm?: boolean;
}

/**
 * Validates a lead message in the relay, without zod.
 * @param x - Any runtime message
 * @returns The message, or null when it is not a valid lead message
 */
export function validateLeadMessage(x: unknown): LeadMessage | null {
  const o = asRecord(x);
  if (!o || o.type !== LEAD_MESSAGE_TYPE) return null;
  if (!exactKeys(o, ['type', 'enabled', 'leadMs'], ['rearm'])) return null;
  if (typeof o.enabled !== 'boolean') return null;
  if (typeof o.leadMs !== 'number' || !Number.isFinite(o.leadMs)) return null;
  if (o.leadMs < 0 || o.leadMs > MAX_LEAD_MS) return null;
  if (o.rearm !== undefined && typeof o.rearm !== 'boolean') return null;
  const out: LeadMessage = { type: LEAD_MESSAGE_TYPE, enabled: o.enabled, leadMs: o.leadMs };
  if (o.rearm) out.rearm = true;
  return out;
}
