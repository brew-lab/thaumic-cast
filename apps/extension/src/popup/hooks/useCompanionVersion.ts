/**
 * Companion version hook.
 *
 * Reads companion fields straight off the connection status (which itself
 * reads from `connectionState`), reads the user's latest dismissal, derives
 * whether to show the out-of-date warning, and exposes a callback to
 * dismiss the warning for the current companion build.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  DISMISSED_COMPANION_VERSION_STORAGE_KEY,
  type CompanionInfo,
  type DismissedCompanionVersion,
  getDismissedCompanionVersion,
  hasVersionMismatch,
  setDismissedCompanionVersion,
  shouldWarnAboutVersion,
} from '../../lib/versionCheck';
import { useStorageListener } from './useStorageListener';
import type { ConnectionStatus } from './useConnectionStatus';

export interface UseCompanionVersionResult {
  companion: CompanionInfo | null;
  /**
   * Raw "is the companion out of date?" — true regardless of whether the
   * Alert has been dismissed. Drives the persistent footer "Update available"
   * link.
   */
  hasMismatch: boolean;
  /** Whether the popup should currently render the dismissible Alert. */
  showMismatchWarning: boolean;
  /** Dismisses the Alert for the companion's current `appVersion` bucket. */
  dismissMismatchWarning: () => void;
}

/**
 * Derives companion-info-related UI flags from the connection status.
 * @param connection - Current connection status (from `useConnectionStatus`)
 * @returns Companion info, the warning flags, and a dismissal callback
 */
export function useCompanionVersion(connection: ConnectionStatus): UseCompanionVersionResult {
  const [dismissed, setDismissed] = useState<DismissedCompanionVersion | null>(null);

  useEffect(() => {
    getDismissedCompanionVersion()
      .then(setDismissed)
      .catch(() => setDismissed(null));
  }, []);

  useStorageListener<DismissedCompanionVersion>(
    DISMISSED_COMPANION_VERSION_STORAGE_KEY,
    setDismissed,
  );

  // Build a CompanionInfo only when we have a live connection. Without one,
  // the version-check helpers should treat the popup as "no companion seen
  // yet" — the connection-state fields are stale until reconnect.
  const companion: CompanionInfo | null = connection.desktopAppUrl
    ? {
        appType: connection.appType,
        appVersion: connection.appVersion,
        protocolVersion: connection.protocolVersion,
      }
    : null;

  const dismissMismatchWarning = useCallback(() => {
    if (!companion) return;
    const appVersion = companion.appVersion ?? null;
    setDismissed({ appVersion });
    setDismissedCompanionVersion(appVersion).catch(() => {
      // Ignore — next reconnect will re-derive state anyway.
    });
  }, [companion]);

  return {
    companion,
    hasMismatch: hasVersionMismatch(companion),
    showMismatchWarning: shouldWarnAboutVersion(companion, dismissed),
    dismissMismatchWarning,
  };
}
