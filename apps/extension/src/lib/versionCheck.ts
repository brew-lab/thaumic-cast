/**
 * Companion version tracking.
 *
 * On every successful WebSocket handshake the offscreen worker persists the
 * companion's reported metadata (`appVersion`, `protocolVersion`, `appType`) to
 * `chrome.storage.local`. The popup reads from the same storage to:
 *   1. Display the connected companion in its About surface.
 *   2. Warn the user when `protocolVersion` is below
 *      `MIN_COMPATIBLE_PROTOCOL_VERSION` and route them to the GitHub releases
 *      page so they can update the desktop app or server.
 *
 * The warning dismissal is keyed on the companion's `appVersion`: once the user
 * dismisses for v0.11.0, the warning stays silent — but if they roll forward
 * (or back) to a different build the dismissal no longer matches and the Alert
 * re-appears, so stale dismissals don't mask real mismatches.
 */

import type { AppType } from '@thaumic-cast/protocol';
import { MIN_COMPATIBLE_PROTOCOL_VERSION } from '@thaumic-cast/shared';

/** Key for the currently-connected companion's version metadata. */
export const COMPANION_INFO_STORAGE_KEY = 'companionInfo';

/** Key for the companion `appVersion` the user last dismissed a warning for. */
export const DISMISSED_COMPANION_VERSION_STORAGE_KEY = 'dismissedCompanionVersion';

/**
 * Companion metadata captured from the handshake ACK.
 *
 * `appVersion` and `protocolVersion` are required: without them we cannot show
 * meaningful About content or drive the out-of-date warning, and persisting
 * partial data would only pollute the UI. `appType`, by contrast, is allowed
 * to be undefined — a future companion may introduce a new variant (e.g.
 * `"cli"`) that older extensions don't recognise, and `WsHandshakeAckPayloadSchema`
 * degrades unknown values to `undefined`. We want the About surface and the
 * warning to keep working in that case, just with a generic "companion" label.
 *
 * Pre-0.4.0 companions omit all three fields and are treated as "unknown,
 * assume compatible" — nothing is persisted for them.
 */
export interface CompanionInfo {
  appVersion: string;
  protocolVersion: string;
  appType?: AppType;
}

/** Persisted "user has already dismissed the warning for this companion build" marker. */
export interface DismissedCompanionVersion {
  appVersion: string;
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
 * True when the extension should surface the "update your companion" warning
 * — i.e. the companion reported a `protocolVersion` below
 * `MIN_COMPATIBLE_PROTOCOL_VERSION` and the user has not dismissed the warning
 * for the companion's current `appVersion`.
 *
 * Companions that omit `protocolVersion` (pre-0.4.0 builds) are treated as
 * compatible — we don't want to spam users on older companions who haven't
 * yet had a chance to update through the normal channel.
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
  if (!companion?.protocolVersion) return false;
  if (isCompatible(companion.protocolVersion, minProtocolVersion)) return false;
  return dismissed?.appVersion !== companion.appVersion;
}

/**
 * Persists the companion info captured during handshake.
 * @param info - Companion metadata to persist
 */
export async function setCompanionInfo(info: CompanionInfo): Promise<void> {
  await chrome.storage.local.set({ [COMPANION_INFO_STORAGE_KEY]: info });
}

/**
 * Reads the most recently captured companion info, if any.
 * @returns The persisted companion info, or null if the extension hasn't
 *   completed a handshake since install.
 */
export async function getCompanionInfo(): Promise<CompanionInfo | null> {
  const result = await chrome.storage.local.get(COMPANION_INFO_STORAGE_KEY);
  const value = result[COMPANION_INFO_STORAGE_KEY] as CompanionInfo | undefined;
  return value ?? null;
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
 * @param appVersion - The companion's current `appVersion` at the moment of dismissal.
 */
export async function setDismissedCompanionVersion(appVersion: string): Promise<void> {
  await chrome.storage.local.set({
    [DISMISSED_COMPANION_VERSION_STORAGE_KEY]: { appVersion } satisfies DismissedCompanionVersion,
  });
}
