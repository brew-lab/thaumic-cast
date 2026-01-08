import type { JSX } from 'preact';
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
  /** Label for mute button when unmuted */
  muteLabel?: string;
  /** Label for mute button when muted */
  unmuteLabel?: string;
  /** Accessible label for the volume slider */
  volumeLabel?: string;
  /** Optional status indicator element */
  statusIndicator?: JSX.Element;
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
 * @param props.muteLabel - Label for mute action
 * @param props.unmuteLabel - Label for unmute action
 * @param props.volumeLabel - Accessible label for the volume slider
 * @param props.statusIndicator - Optional status indicator element
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
  muteLabel = 'Mute',
  unmuteLabel = 'Unmute',
  volumeLabel = 'Volume',
  statusIndicator,
  className,
}: SpeakerVolumeRowProps): JSX.Element {
  return (
    <div className={[styles.row, className].filter(Boolean).join(' ')} data-speaker-ip={speakerIp}>
      <div className={styles.header}>
        <span className={styles.name}>{speakerName}</span>
        {statusIndicator}
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
