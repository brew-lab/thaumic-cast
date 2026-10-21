/**
 * Which WebSocket closes are part of ordinary life.
 *
 * The companion closes its sockets when the desktop app quits or restarts, the server stops,
 * or the computer sleeps: the browser reports a normal close (1000), going away (1001), no
 * status (1005) or, when the process simply vanished, an abnormal close (1006). None of these
 * is a fault in the extension, and the control connection reconnects by itself, so they are
 * logged at info. Any other code (a policy violation, an internal server error) is a warning.
 */

/** Close codes that mean the companion went away or closed normally. */
const EXPECTED_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1001, 1005, 1006]);

/**
 * Whether a WebSocket close is an ordinary event rather than a fault.
 * @param code - The CloseEvent's code
 * @returns True for a normal close or the companion going away
 */
export function isExpectedClose(code: number): boolean {
  return EXPECTED_CLOSE_CODES.has(code);
}
