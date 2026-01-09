/**
 * Speaker Selection Hook
 *
 * Manages speaker group selection state with persistence and automatic defaults.
 * - Persists selection to chrome.storage.local for cross-session retention
 * - Validates saved selection against available speakers on load
 * - Auto-selects first group when no valid saved selection exists
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { getSpeakerAvailability } from '@thaumic-cast/protocol';
import type { SonosStateSnapshot, SpeakerAvailability } from '@thaumic-cast/protocol';
import type { SpeakerGroupCollection } from '../../domain/speaker';
import { loadSpeakerSelection, saveSpeakerSelection } from '../../lib/settings';

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
 * Hook for managing speaker group selection with persistence and auto-selection.
 *
 * Selection is persisted to chrome.storage.local (device-specific, survives browser restart).
 * On load, validates saved IPs against current groups and falls back to auto-select if needed.
 *
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
  const [isStorageLoaded, setIsStorageLoaded] = useState(false);
  const hasInitialized = useRef(false);

  // Load saved selection from storage on mount
  useEffect(() => {
    loadSpeakerSelection().then((savedIps) => {
      if (savedIps.length > 0) {
        setSelectedIps(savedIps);
      }
      setIsStorageLoaded(true);
    });
  }, []);

  // Validate and initialize selection when groups become available
  useEffect(() => {
    // Wait for storage to load and groups to be available
    if (!isStorageLoaded || speakerGroups.isEmpty) {
      return;
    }

    // Only initialize once per mount
    if (hasInitialized.current) {
      return;
    }

    hasInitialized.current = true;

    // Get valid coordinator IPs from current groups
    const validIps = new Set(speakerGroups.getCoordinatorIps());

    // Filter saved selection to only include speakers that still exist
    const validSavedIps = selectedIps.filter((ip) => validIps.has(ip));

    if (validSavedIps.length > 0) {
      // Some saved speakers still exist - use them
      if (validSavedIps.length !== selectedIps.length) {
        // Some speakers disappeared, update selection
        setSelectedIps(validSavedIps);
        saveSpeakerSelection(validSavedIps);
      }
    } else {
      // No valid saved selection - auto-select first speaker
      const firstGroup = speakerGroups.groups[0];
      if (firstGroup) {
        const newSelection = [firstGroup.coordinatorIp];
        setSelectedIps(newSelection);
        saveSpeakerSelection(newSelection);
      }
    }
  }, [isStorageLoaded, speakerGroups, selectedIps]);

  // Clear selection and reset when groups become empty (e.g., disconnect)
  useEffect(() => {
    // Only clear if we've already initialized - don't clear before groups first load
    if (hasInitialized.current && speakerGroups.isEmpty && selectedIps.length > 0) {
      hasInitialized.current = false;
      setSelectedIps([]);
    }
  }, [speakerGroups.isEmpty, selectedIps.length]);

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
    saveSpeakerSelection(ips);
  }, []);

  return {
    selectedIps,
    setSelectedIps: setSelection,
    primarySelectedIp,
    selectedAvailability,
  };
}
