/**
 * Speaker Selection Hook
 *
 * Manages speaker group selection state with automatic defaults.
 * Auto-selects first group when groups load, clears when empty.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { getSpeakerAvailability } from '@thaumic-cast/protocol';
import type { SonosStateSnapshot, SpeakerAvailability } from '@thaumic-cast/protocol';
import type { SpeakerGroupCollection } from '../../domain/speaker';

/**
 * Return value from the useSpeakerSelection hook.
 */
interface UseSpeakerSelectionResult {
  /** Currently selected speaker IPs. */
  selectedIps: string[];
  /** Update selected speaker IPs. */
  setSelectedIps: (ips: string[]) => void;
  /** Primary (first) selected speaker IP, or undefined if none. */
  primarySelectedIp: string | undefined;
  /** Availability status of the primary selected speaker. */
  selectedAvailability: SpeakerAvailability;
}

/**
 * Hook for managing speaker group selection with auto-selection behavior.
 * @param speakerGroups - Available speaker groups from useSonosState
 * @param sonosState - Current Sonos state snapshot for availability calculation
 * @param castingSpeakerIps - IPs of speakers currently casting
 * @returns Selection state and controls
 */
export function useSpeakerSelection(
  speakerGroups: SpeakerGroupCollection,
  sonosState: SonosStateSnapshot,
  castingSpeakerIps: string[],
): UseSpeakerSelectionResult {
  const [selectedIps, setSelectedIps] = useState<string[]>([]);
  const hasAutoSelected = useRef(false);

  // Auto-select first group on initial load only, clear when groups become empty
  useEffect(() => {
    if (!speakerGroups.isEmpty && selectedIps.length === 0 && !hasAutoSelected.current) {
      const firstGroup = speakerGroups.groups[0];
      if (firstGroup) {
        setSelectedIps([firstGroup.coordinatorIp]);
        hasAutoSelected.current = true;
      }
    } else if (speakerGroups.isEmpty && selectedIps.length > 0) {
      // Reset auto-selection flag when groups become empty (e.g., disconnect)
      hasAutoSelected.current = false;
      setSelectedIps([]);
    }
  }, [speakerGroups, selectedIps.length]);

  const primarySelectedIp = selectedIps[0];

  const selectedAvailability = useMemo(
    () =>
      primarySelectedIp
        ? getSpeakerAvailability(primarySelectedIp, sonosState, castingSpeakerIps)
        : 'available',
    [primarySelectedIp, sonosState, castingSpeakerIps],
  );

  const setSelection = useCallback((ips: string[]) => {
    setSelectedIps(ips);
  }, []);

  return {
    selectedIps,
    setSelectedIps: setSelection,
    primarySelectedIp,
    selectedAvailability,
  };
}
