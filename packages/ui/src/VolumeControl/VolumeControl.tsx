import type { JSX, CSSProperties } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { Volume2, VolumeX } from 'lucide-preact';
import { IconButton } from '../IconButton';
import styles from './VolumeControl.module.css';

/** Debounce delay for volume slider in milliseconds */
const VOLUME_DEBOUNCE_MS = 100;

/** Debounce delay for mute toggle in milliseconds */
const MUTE_DEBOUNCE_MS = 200;

/**
 * Cooldown period after user interaction ends before accepting external updates.
 * This prevents stale server responses from causing the slider to jump.
 * Should be long enough for the server round-trip to complete.
 */
const INTERACTION_COOLDOWN_MS = 500;

interface VolumeControlProps {
  /** Current volume level (0-100) */
  volume: number;
  /** Whether the speaker is muted */
  muted: boolean;
  /** Callback when volume changes */
  onVolumeChange: (volume: number) => void;
  /** Callback when mute is toggled */
  onMuteToggle: () => void;
  /** Label for mute button when unmuted */
  muteLabel?: string;
  /** Label for mute button when muted */
  unmuteLabel?: string;
  /** Accessible label for the volume slider */
  volumeLabel?: string;
  /** Additional CSS class */
  className?: string;
}

/**
 * Compact horizontal volume control with mute button, slider, and value.
 * @param props - Component props
 * @param props.volume - Current volume level (0-100)
 * @param props.muted - Whether muted
 * @param props.onVolumeChange - Volume change handler
 * @param props.onMuteToggle - Mute toggle handler
 * @param props.muteLabel - Label for mute action
 * @param props.unmuteLabel - Label for unmute action
 * @param props.volumeLabel - Accessible label for the volume slider
 * @param props.className - Additional CSS class
 * @returns The rendered VolumeControl component
 */
export function VolumeControl({
  volume,
  muted,
  onVolumeChange,
  onMuteToggle,
  muteLabel = 'Mute',
  unmuteLabel = 'Unmute',
  volumeLabel = 'Volume',
  className,
}: VolumeControlProps): JSX.Element {
  // Local state for immediate visual feedback while dragging
  const [localVolume, setLocalVolume] = useState(volume);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const muteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMuteDebouncing = useRef(false);
  // Track if user is actively interacting with the slider (or in cooldown period)
  const isInteracting = useRef(false);
  // Track external volume updates that arrive during interaction to apply after cooldown
  const pendingExternalVolume = useRef<number | null>(null);

  /**
   * Ends the interaction period and applies any pending external volume update.
   * Used as the callback for cooldown timers in both pointer and change handlers.
   */
  const endInteraction = useCallback(() => {
    isInteracting.current = false;
    cooldownRef.current = null;
    if (pendingExternalVolume.current !== null) {
      setLocalVolume(pendingExternalVolume.current);
      pendingExternalVolume.current = null;
    }
  }, []);

  // Sync local state when prop changes, but only if user is not actively dragging
  useEffect(() => {
    if (!isInteracting.current) {
      setLocalVolume(volume);
      pendingExternalVolume.current = null;
    } else {
      // Store external update to apply after cooldown ends
      pendingExternalVolume.current = volume;
    }
  }, [volume]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (volumeDebounceRef.current) {
        clearTimeout(volumeDebounceRef.current);
      }
      if (muteDebounceRef.current) {
        clearTimeout(muteDebounceRef.current);
      }
      if (cooldownRef.current) {
        clearTimeout(cooldownRef.current);
      }
    };
  }, []);

  /**
   * Handles mute toggle with debounce to prevent rage clicking.
   */
  const handleMuteToggle = useCallback(() => {
    if (isMuteDebouncing.current) return;

    isMuteDebouncing.current = true;
    onMuteToggle();

    muteDebounceRef.current = setTimeout(() => {
      isMuteDebouncing.current = false;
    }, MUTE_DEBOUNCE_MS);
  }, [onMuteToggle]);

  /**
   * Handles slider change with debounced callback.
   */
  const handleSliderChange = useCallback(
    (e: Event) => {
      const newVolume = parseInt((e.target as HTMLInputElement).value, 10);

      // Update local state immediately for smooth UI
      setLocalVolume(newVolume);

      // Mark as interacting to prevent external updates from overwriting
      // This covers both pointer and keyboard interactions
      isInteracting.current = true;

      // Unmute immediately if muted (bypass debounce for this)
      if (muted) onMuteToggle();

      // Debounce the actual volume change callback
      if (volumeDebounceRef.current) {
        clearTimeout(volumeDebounceRef.current);
      }
      volumeDebounceRef.current = setTimeout(() => {
        onVolumeChange(newVolume);
      }, VOLUME_DEBOUNCE_MS);

      // Reset the cooldown timer - this keeps isInteracting=true until
      // INTERACTION_COOLDOWN_MS after the last user input, giving time for
      // the server round-trip to complete before accepting external updates
      if (cooldownRef.current) {
        clearTimeout(cooldownRef.current);
      }
      cooldownRef.current = setTimeout(
        endInteraction,
        VOLUME_DEBOUNCE_MS + INTERACTION_COOLDOWN_MS,
      );
    },
    [endInteraction, muted, onMuteToggle, onVolumeChange],
  );

  /**
   * Marks the start of user interaction with the slider.
   * This ensures external updates are blocked even before the first onChange fires.
   */
  const handlePointerDown = useCallback(() => {
    isInteracting.current = true;
    // Clear any existing cooldown timer - we're starting a new interaction
    if (cooldownRef.current) {
      clearTimeout(cooldownRef.current);
      cooldownRef.current = null;
    }
  }, []);

  /**
   * Handles pointer release or cancellation on the slider.
   * Sets a fallback cooldown timer if the user released without changing the value
   * (onChange would never fire, leaving isInteracting stuck at true).
   * Also handles pointercancel (system gesture override, incoming call, etc.).
   */
  const handlePointerUp = useCallback(() => {
    // Only set fallback timer if onChange didn't already set one
    if (cooldownRef.current === null) {
      cooldownRef.current = setTimeout(endInteraction, INTERACTION_COOLDOWN_MS);
    }
  }, [endInteraction]);

  return (
    <div className={[styles.volumeControl, className].filter(Boolean).join(' ')}>
      <IconButton
        size="sm"
        className={[styles.muteBtn, muted ? styles.muted : ''].filter(Boolean).join(' ')}
        onClick={handleMuteToggle}
        title={muted ? unmuteLabel : muteLabel}
        aria-label={muted ? unmuteLabel : muteLabel}
      >
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </IconButton>
      <input
        type="range"
        min="0"
        max="100"
        value={localVolume}
        onChange={handleSliderChange}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={styles.slider}
        style={{ '--volume': `${localVolume}%` } as CSSProperties}
        aria-label={volumeLabel}
        aria-valuetext={`${localVolume}%`}
      />
      <span className={styles.value} aria-hidden="true">
        {localVolume}
      </span>
    </div>
  );
}
