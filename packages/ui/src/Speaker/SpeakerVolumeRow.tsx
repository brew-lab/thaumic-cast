import type { JSX } from 'preact';
import { X } from 'lucide-preact';
import { IconButton } from '../IconButton';
import { VolumeControl } from '../VolumeControl';
import styles from './SpeakerVolumeRow.module.css';

interface SpeakerVolumeRowProps {
  /** Display name for the speaker/group */
  speakerName: string;
  /** Speaker/group coordinator IP (used as data attribute) */
  speakerIp: string;
  /** Current volume (0-100) */
  volume: number;
  /** Whether speaker is muted */
  muted: boolean;
  /** Callback when volume changes */
  onVolumeChange: (volume: number) => void;
  /** Callback when mute is toggled */
  onMuteToggle: () => void;
  /** Accessible label for mute button. Should include speaker name for context (e.g., "Mute Living Room"). */
  muteLabel: string;
  /** Accessible label for unmute button. Should include speaker name for context (e.g., "Unmute Living Room"). */
  unmuteLabel: string;
  /** Accessible label for the volume slider. Should include speaker name for context (e.g., "Living Room volume"). */
  volumeLabel: string;
  /** Optional status indicator element */
  statusIndicator?: JSX.Element;
  /** Callback when remove button is clicked. If absent, no remove button shown. */
  onRemove?: () => void;
  /** Accessible label for remove button */
  removeLabel?: string;
  /** Additional CSS class */
  className?: string;
}

/**
 * Displays a speaker row with name and volume controls.
 * @param props - Component props
 * @param props.speakerName - Display name for the speaker
 * @param props.speakerIp - Speaker coordinator IP
 * @param props.volume - Current volume level
 * @param props.muted - Whether muted
 * @param props.onVolumeChange - Volume change callback
 * @param props.onMuteToggle - Mute toggle callback
 * @param props.muteLabel - Accessible label for mute button (include speaker name)
 * @param props.unmuteLabel - Accessible label for unmute button (include speaker name)
 * @param props.volumeLabel - Accessible label for volume slider (include speaker name)
 * @param props.statusIndicator - Optional status indicator element
 * @param props.onRemove - Optional callback when remove button is clicked
 * @param props.removeLabel - Accessible label for remove button
 * @param props.className - Additional CSS class
 * @returns The rendered SpeakerVolumeRow component
 */
export function SpeakerVolumeRow({
  speakerName,
  speakerIp,
  volume,
  muted,
  onVolumeChange,
  onMuteToggle,
  muteLabel,
  unmuteLabel,
  volumeLabel,
  statusIndicator,
  onRemove,
  removeLabel,
  className,
}: SpeakerVolumeRowProps): JSX.Element {
  return (
    <div
      className={[styles.row, className].filter(Boolean).join(' ')}
      data-speaker-ip={speakerIp}
      role="group"
      aria-label={speakerName}
    >
      <div className={styles.header}>
        <span className={styles.name}>{speakerName}</span>
        {statusIndicator}
        {onRemove && (
          <IconButton
            size="sm"
            className={styles.removeBtn}
            onClick={onRemove}
            aria-label={removeLabel}
            title={removeLabel}
          >
            <X size={10} />
          </IconButton>
        )}
      </div>
      <VolumeControl
        volume={volume}
        muted={muted}
        onVolumeChange={onVolumeChange}
        onMuteToggle={onMuteToggle}
        muteLabel={muteLabel}
        unmuteLabel={unmuteLabel}
        volumeLabel={volumeLabel}
      />
    </div>
  );
}
