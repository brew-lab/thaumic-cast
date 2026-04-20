/**
 * Companion version tracking.
 *
 * The companion's metadata (`appType`, `appVersion`, `protocolVersion`) is
 * carried by `connectionState` (see `background/connection-state.ts`):
 * `appType` lands at discovery time from `/health`, `appVersion` and
 * `protocolVersion` arrive on the WebSocket via `INITIAL_STATE`. The popup
 * and options page read them through `useConnectionStatus`. This module
 * provides the pure helpers that interpret those fields:
 *   1. Compare against `MIN_COMPATIBLE_PROTOCOL_VERSION` to drive the
 *      out-of-date warning.
 *   2. Resolve i18n keys for companion-type labels and update-prompt copy.
 *
 * Pre-0.4.0 companions advertise none of the version fields. We still want
 * to alert the user — Chrome may auto-update the extension before they
 * update the companion — so we treat the absence of a `protocolVersion` as
 * a mismatch.
 *
 * The Alert is dismissible per `appVersion` (`null` is its own bucket): once
 * dismissed it stays silent for that build, but if the companion rolls
 * forward — including from "unknown" to a real version — the dismissal no
 * longer matches and the Alert re-appears. Even when dismissed, the popup
 * footer keeps a persistent "Update available" link so the user always has
 * a way back to the releases page.
 *
 * The dismissal record stays in `chrome.storage.local` (a user preference
 * that should survive browser restarts), separate from `connectionState`
 * (ephemeral, in `chrome.storage.session`).
 */

import type { AppType } from '@thaumic-cast/protocol';
import { MIN_COMPATIBLE_PROTOCOL_VERSION } from '@thaumic-cast/shared';

/** Key for the companion `appVersion` the user last dismissed a warning for. */
export const DISMISSED_COMPANION_VERSION_STORAGE_KEY = 'dismissedCompanionVersion';

/**
 * Companion metadata as consumed by the version-check helpers below.
 *
 * Sourced from `connectionState` — `appType` is populated at discovery time
 * from `/health`; `appVersion`/`protocolVersion` arrive via the WebSocket
 * `INITIAL_STATE`. All three are nullable so we can record "connected to a
 * companion that doesn't advertise its version" (pre-0.4.0).
 */
export interface CompanionInfo {
  appVersion: string | null;
  protocolVersion: string | null;
  appType: AppType | null;
}

/**
 * Persisted dismissal marker. `appVersion` is `null` for pre-0.4.0
 * companions (so they can be dismissed too) — when the companion later
 * advertises a real version, that bucket no longer matches and the Alert
 * re-appears.
 */
export interface DismissedCompanionVersion {
  appVersion: string | null;
}

/**
 * Compares two semver-style "X.Y.Z" strings.
 *
 * Any prerelease suffix (e.g. `-beta.1`) is stripped before comparison —
 * the repo ships stable `0.x.y` tags so this is sufficient and avoids pulling
 * in a full semver dependency. Missing or malformed segments are treated as
 * `0`, so `"1"` compares less than `"1.0.1"`.
 *
 * @param a - First version string
 * @param b - Second version string
 * @returns Negative if `a < b`, zero if equal, positive if `a > b`
 */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string): [number, number, number] => {
    const core = v.split('-', 1)[0] ?? '';
    const [maj = '0', min = '0', pat = '0'] = core.split('.');
    return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
  };
  const [aMaj, aMin, aPat] = parts(a);
  const [bMaj, bMin, bPat] = parts(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

/**
 * Whether `actual` is at least `min`. Used to gate the out-of-date warning.
 *
 * @param actual - Version reported by the companion
 * @param min - Minimum version the extension requires
 * @returns `true` if `actual >= min`
 */
export function isCompatible(actual: string, min: string): boolean {
  return compareSemver(actual, min) >= 0;
}

/**
 * Raw "is the connected companion out of date?" check, ignoring any dismissal.
 * Used to drive surfaces that should always reflect mismatch status — e.g. the
 * popup footer's persistent "Update available" link.
 *
 * Returns `false` when no companion has connected yet (nothing to warn about).
 *
 * @param companion - Most recent companion info, or null if none yet seen
 * @param minProtocolVersion - Override for the minimum compatible protocol version
 * @returns `true` when the companion's protocol is missing or below the minimum
 */
export function hasVersionMismatch(
  companion: CompanionInfo | null,
  minProtocolVersion: string = MIN_COMPATIBLE_PROTOCOL_VERSION,
): boolean {
  if (!companion) return false;
  if (!companion.protocolVersion) return true;
  return !isCompatible(companion.protocolVersion, minProtocolVersion);
}

/**
 * True when the popup should render the out-of-date *Alert*. Same as
 * `hasVersionMismatch` but suppressed once the user has dismissed it for
 * this `appVersion` bucket (`null` is its own bucket — see
 * `DismissedCompanionVersion`).
 *
 * @param companion - Most recent companion info, or null if none yet seen
 * @param dismissed - Last dismissal record persisted in chrome.storage
 * @param minProtocolVersion - Override for the minimum compatible protocol version
 * @returns `true` when the popup should render the out-of-date warning Alert
 */
export function shouldWarnAboutVersion(
  companion: CompanionInfo | null,
  dismissed: DismissedCompanionVersion | null,
  minProtocolVersion: string = MIN_COMPATIBLE_PROTOCOL_VERSION,
): boolean {
  if (!hasVersionMismatch(companion, minProtocolVersion)) return false;
  return dismissed?.appVersion !== companion?.appVersion;
}

/**
 * Reads the companion app version for which the user last dismissed the warning.
 * @returns The dismissed version record, or null if the warning has never been dismissed.
 */
export async function getDismissedCompanionVersion(): Promise<DismissedCompanionVersion | null> {
  const result = await chrome.storage.local.get(DISMISSED_COMPANION_VERSION_STORAGE_KEY);
  const value = result[DISMISSED_COMPANION_VERSION_STORAGE_KEY] as
    | DismissedCompanionVersion
    | undefined;
  return value ?? null;
}

/**
 * Records that the user has dismissed the warning for this companion build.
 * `null` is a valid bucket — pre-0.4.0 companions can be dismissed too, and
 * the dismissal stops matching once the companion reports a real version.
 * @param appVersion - The companion's current `appVersion` (or `null`) at the moment of dismissal.
 */
export async function setDismissedCompanionVersion(appVersion: string | null): Promise<void> {
  await chrome.storage.local.set({
    [DISMISSED_COMPANION_VERSION_STORAGE_KEY]: { appVersion } satisfies DismissedCompanionVersion,
  });
}

/**
 * Resolves the i18n key identifying the companion type label
 * (`about_companion_type_{desktop,server,generic}`). Unknown or absent
 * `appType` falls through to the generic label so copy still reads naturally
 * when a newer companion sends an `appType` this extension doesn't recognise.
 *
 * @param appType - Reported by the companion, or `null`/`undefined` when absent/unknown
 * @returns i18n key for the companion type display label
 */
export function companionTypeLabelKey(appType: AppType | null | undefined): string {
  if (appType === 'server') return 'about_companion_type_server';
  if (appType === 'desktop') return 'about_companion_type_desktop';
  return 'about_companion_type_generic';
}

/**
 * Resolves the i18n key for the Alert action button that prompts the user to
 * update the companion (`version_mismatch_action_{desktop,server,generic}`).
 *
 * @param appType - Reported by the companion, or `null`/`undefined` when absent/unknown
 * @returns i18n key for the action button label
 */
export function versionMismatchActionKey(appType: AppType | null | undefined): string {
  if (appType === 'server') return 'version_mismatch_action_server';
  if (appType === 'desktop') return 'version_mismatch_action_desktop';
  return 'version_mismatch_action_generic';
}
