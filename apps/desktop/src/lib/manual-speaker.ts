import { probeSpeakerIp, addManualSpeakerIp } from '../state/store';

/** What adding a speaker by its address came to. */
export type AddSpeakerOutcome = { ok: true; ip: string } | { ok: false; code: string };

/** Keeps the busy state on screen long enough not to flash. */
const MIN_FEEDBACK_MS = 400;

/**
 * Adds a Sonos speaker by its IP address: probes it, then keeps it. The backend refreshes
 * the topology by itself, and the views follow its events. It never rejects: a failure
 * resolves with the probe's error code.
 *
 * @param ip - The typed address
 * @returns The cleaned address the probe found, or the error code
 */
export async function addManualSpeaker(ip: string): Promise<AddSpeakerOutcome> {
  const [result] = await Promise.all([
    probeSpeakerIp(ip.trim()).then(
      (speaker) => ({ ok: true as const, ip: speaker.ip }),
      (e: unknown) => ({ ok: false as const, code: probeErrorCode(e) }),
    ),
    new Promise((resolve) => setTimeout(resolve, MIN_FEEDBACK_MS)),
  ]);
  if (!result.ok) return result;
  try {
    // Keep the cleaned address the probe returned, not what was typed.
    await addManualSpeakerIp(result.ip);
    return result;
  } catch (e) {
    return { ok: false, code: probeErrorCode(e) };
  }
}

/**
 * Reads the error code off a rejected probe. A Tauri command rejects with
 * `{ code, message }`, which `String()` would turn into "[object Object]".
 *
 * @param e - Whatever the probe rejected with
 * @returns The machine-readable code when there is one, else the value as text
 */
export function probeErrorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') {
    return e.code;
  }
  return String(e);
}

/**
 * Get a localized error message for speaker probe errors.
 *
 * @param error - The error string from probe attempt
 * @param t - Translation function from useTranslation
 * @returns Localized error message
 */
export function getSpeakerErrorMessage(error: string, t: (key: string) => string): string {
  if (error.includes('ip_unreachable')) {
    return t('onboarding.speakers.manual_error_unreachable');
  }
  if (error.includes('not_sonos_device')) {
    return t('onboarding.speakers.manual_error_not_sonos');
  }
  if (error.includes('invalid_ip')) {
    return t('onboarding.speakers.manual_error_invalid');
  }
  // Generic fallback for unexpected errors (timeout, network issues, etc.)
  return t('onboarding.speakers.manual_error_generic');
}
