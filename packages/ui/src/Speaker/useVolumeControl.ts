import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** Debounce delay for volume changes, in ms. */
export const VOLUME_DEBOUNCE_MS = 100;

/** Debounce delay for the mute toggle, in ms. */
export const MUTE_DEBOUNCE_MS = 200;

/**
 * Cooldown after the user's last change before external updates are accepted again, so a
 * stale speaker report never makes the slider jump. Long enough for the round trip.
 */
export const INTERACTION_COOLDOWN_MS = 500;

/** What {@link useVolumeControl} hands its row. */
export interface VolumeControlState {
  /**
   * The level to draw: the user's while they interact, else the speaker's; undefined while
   * the speaker has not reported one (the Slider shows "…").
   */
  level: number | undefined;
  /** Feed every slider change here. */
  change: (level: number) => void;
  /** Mute or unmute, at most once per {@link MUTE_DEBOUNCE_MS}; nothing without a toggle. */
  toggleMute: () => void;
  /** Call when a drag begins. */
  pointerDown: () => void;
  /** Call when a drag ends or is cancelled. */
  pointerUp: () => void;
}

/**
 * The volume row's timing (moved here from VolumeControl, which the Slider retires): the
 * slider answers at once, the speaker is told after {@link VOLUME_DEBOUNCE_MS}, external
 * updates wait until the user has been still for {@link INTERACTION_COOLDOWN_MS}, a change
 * while muted unmutes, and mute ignores rage clicks. RoomRow and GroupVolume take this over
 * in Phase 3 (DESIGN.md §14).
 * @param volume - The speaker's level, or undefined while it is not known
 * @param muted - Whether it is muted
 * @param onVolumeChange - Tells the speaker a new level
 * @param onMuteToggle - Toggles mute; optional, as a start level has no mute
 * @returns The level to draw and the handlers
 */
export function useVolumeControl(
  volume: number | undefined,
  muted: boolean,
  onVolumeChange: (volume: number) => void,
  onMuteToggle?: () => void,
): VolumeControlState {
  const [level, setLevel] = useState<number | undefined>(volume);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const muteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldown = useRef<ReturnType<typeof setTimeout> | null>(null);
  const muteDebouncing = useRef(false);
  const interacting = useRef(false);
  // null: nothing pending; undefined is a real report ("not known").
  const pendingExternal = useRef<number | undefined | null>(null);

  const endInteraction = useCallback(() => {
    interacting.current = false;
    cooldown.current = null;
    if (pendingExternal.current !== null) {
      setLevel(pendingExternal.current);
      pendingExternal.current = null;
    }
  }, []);

  useEffect(() => {
    if (!interacting.current) {
      setLevel(volume);
      pendingExternal.current = null;
    } else {
      pendingExternal.current = volume;
    }
  }, [volume]);

  useEffect(
    () => () => {
      if (volumeTimer.current) clearTimeout(volumeTimer.current);
      if (muteTimer.current) clearTimeout(muteTimer.current);
      if (cooldown.current) clearTimeout(cooldown.current);
    },
    [],
  );

  const toggleMute = useCallback(() => {
    if (!onMuteToggle || muteDebouncing.current) return;
    muteDebouncing.current = true;
    onMuteToggle();
    muteTimer.current = setTimeout(() => {
      muteDebouncing.current = false;
    }, MUTE_DEBOUNCE_MS);
  }, [onMuteToggle]);

  const change = useCallback(
    (next: number) => {
      setLevel(next);
      interacting.current = true;
      if (muted) onMuteToggle?.();
      if (volumeTimer.current) clearTimeout(volumeTimer.current);
      volumeTimer.current = setTimeout(() => onVolumeChange(next), VOLUME_DEBOUNCE_MS);
      if (cooldown.current) clearTimeout(cooldown.current);
      cooldown.current = setTimeout(endInteraction, VOLUME_DEBOUNCE_MS + INTERACTION_COOLDOWN_MS);
    },
    [endInteraction, muted, onMuteToggle, onVolumeChange],
  );

  const pointerDown = useCallback(() => {
    interacting.current = true;
    if (cooldown.current) {
      clearTimeout(cooldown.current);
      cooldown.current = null;
    }
  }, []);

  const pointerUp = useCallback(() => {
    // Released without a change: no change handler set the cooldown, so set it here.
    if (cooldown.current === null) {
      cooldown.current = setTimeout(endInteraction, INTERACTION_COOLDOWN_MS);
    }
  }, [endInteraction]);

  return { level, change, toggleMute, pointerDown, pointerUp };
}
