/**
 * The error for a tab capture Chrome refused.
 *
 * `chrome.tabCapture.getMediaStreamId` reports a refusal by calling back with
 * no id and leaving its reason in `chrome.runtime.lastError`, which is only
 * readable inside that callback. When Chrome gave a reason the popup shows it;
 * when it gave none, the popup says so.
 */

import { KeyedError } from './keyed-error';

/** The longest reason shown; the popup alert is 352 px wide. */
export const CAPTURE_DENIED_REASON_MAX = 160;

/**
 * Tidies Chrome's reason for showing inside a sentence: one line, no
 * surrounding space, cut to a length the popup alert can hold.
 * @param reason - `chrome.runtime.lastError?.message` as read in the callback
 * @returns The reason to show, or undefined when Chrome gave none
 */
export function captureDeniedReason(reason: string | undefined): string | undefined {
  const tidy = reason?.replace(/\s+/g, ' ').trim();
  if (!tidy) return undefined;
  if (tidy.length <= CAPTURE_DENIED_REASON_MAX) return tidy;
  return `${tidy.slice(0, CAPTURE_DENIED_REASON_MAX - 1).trimEnd()}…`;
}

/**
 * Builds the error for a refused tab capture: the line that quotes Chrome's
 * reason when there is one, else the line that says none was written down.
 * @param reason - `chrome.runtime.lastError?.message` as read in the callback
 * @returns The error to reject the capture with
 */
export function captureDeniedError(reason: string | undefined): Error {
  const shown = captureDeniedReason(reason);
  if (shown === undefined) return new Error('error_capture_denied');
  return new KeyedError('error_capture_denied_reason', { reason: shown });
}
