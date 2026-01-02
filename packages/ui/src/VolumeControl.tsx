import type { JSX } from 'preact';
import { Volume2, VolumeX } from 'lucide-preact';

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
  /**
   * Handles slider change, unmuting if currently muted.
   * @param e
   */
  const handleSliderChange = (e: Event) => {
    if (muted) onMuteToggle();
    onVolumeChange(parseInt((e.target as HTMLInputElement).value, 10));
  };

  return (
    <div className={`volumeControl ${className || ''}`}>
      <button
        type="button"
        className={`volumeControlMuteBtn ${muted ? 'muted' : ''}`}
        onClick={onMuteToggle}
        title={muted ? unmuteLabel : muteLabel}
        aria-label={muted ? unmuteLabel : muteLabel}
      >
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      <input
        type="range"
        min="0"
        max="100"
        value={volume}
        onChange={handleSliderChange}
        className="volumeControlSlider"
      />
      <span className="volumeControlValue">{volume}</span>
    </div>
  );
}
