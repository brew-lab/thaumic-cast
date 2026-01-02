import type { JSX } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { Volume2, VolumeX } from 'lucide-preact';
import { IconButton } from './IconButton';

/** Debounce delay for volume slider in milliseconds */
const VOLUME_DEBOUNCE_MS = 100;

/** Debounce delay for mute toggle in milliseconds */
const MUTE_DEBOUNCE_MS = 200;

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
  className,
}: VolumeControlProps): JSX.Element {
  // Local state for immediate visual feedback while dragging
  const [localVolume, setLocalVolume] = useState(volume);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const muteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMuteDebouncing = useRef(false);

  // Sync local state when prop changes (e.g., from external update)
  useEffect(() => {
    setLocalVolume(volume);
  }, [volume]);

  // Cleanup debounce timers on unmount
  useEffect(() => {
    return () => {
      if (volumeDebounceRef.current) {
        clearTimeout(volumeDebounceRef.current);
      }
      if (muteDebounceRef.current) {
        clearTimeout(muteDebounceRef.current);
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

      // Unmute immediately if muted (bypass debounce for this)
      if (muted) onMuteToggle();

      // Debounce the actual volume change callback
      if (volumeDebounceRef.current) {
        clearTimeout(volumeDebounceRef.current);
      }
      volumeDebounceRef.current = setTimeout(() => {
        onVolumeChange(newVolume);
      }, VOLUME_DEBOUNCE_MS);
    },
    [muted, onMuteToggle, onVolumeChange],
  );

  return (
    <div className={`volumeControl ${className || ''}`}>
      <IconButton
        size="sm"
        className={`volumeControlMuteBtn ${muted ? 'muted' : ''}`}
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
        className="volumeControlSlider"
        style={{ '--volume': `${localVolume}%` } as JSX.CSSProperties}
      />
      <span className="volumeControlValue">{localVolume}</span>
    </div>
  );
}
