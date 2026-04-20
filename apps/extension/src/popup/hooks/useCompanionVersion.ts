/**
 * Companion version hook.
 *
 * Reads the most recent companion info (persisted by the offscreen worker on
 * handshake) and the user's latest dismissal, derives whether to show the
 * out-of-date warning, and exposes a callback to dismiss the warning for the
 * current companion build.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  COMPANION_INFO_STORAGE_KEY,
  DISMISSED_COMPANION_VERSION_STORAGE_KEY,
  type CompanionInfo,
  type DismissedCompanionVersion,
  getCompanionInfo,
  getDismissedCompanionVersion,
  setDismissedCompanionVersion,
  shouldWarnAboutVersion,
} from '../../lib/versionCheck';
import { useStorageListener } from './useStorageListener';

export interface UseCompanionVersionResult {
  companion: CompanionInfo | null;
  showMismatchWarning: boolean;
  dismissMismatchWarning: () => void;
}

/**
 * Reads the connected companion's version metadata and derives whether the
 * popup should render the out-of-date warning.
 * @returns Companion info, the warning flag, and a dismissal callback
 */
export function useCompanionVersion(): UseCompanionVersionResult {
  const [companion, setCompanion] = useState<CompanionInfo | null>(null);
  const [dismissed, setDismissed] = useState<DismissedCompanionVersion | null>(null);

  useEffect(() => {
    getCompanionInfo()
      .then(setCompanion)
      .catch(() => setCompanion(null));
    getDismissedCompanionVersion()
      .then(setDismissed)
      .catch(() => setDismissed(null));
  }, []);

  useStorageListener<CompanionInfo>(COMPANION_INFO_STORAGE_KEY, setCompanion);
  useStorageListener<DismissedCompanionVersion>(
    DISMISSED_COMPANION_VERSION_STORAGE_KEY,
    setDismissed,
  );

  const dismissMismatchWarning = useCallback(() => {
    if (!companion?.appVersion) return;
    const appVersion = companion.appVersion;
    setDismissed({ appVersion });
    setDismissedCompanionVersion(appVersion).catch(() => {
      // Ignore — next handshake will re-derive state anyway.
    });
  }, [companion?.appVersion]);

  return {
    companion,
    showMismatchWarning: shouldWarnAboutVersion(companion, dismissed),
    dismissMismatchWarning,
  };
}
