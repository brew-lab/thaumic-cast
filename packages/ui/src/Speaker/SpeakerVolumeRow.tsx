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
  /** Current volume (0-100), or undefined while it is not known yet */
  volume: number | undefined;
  /** Whether speaker is muted */
  muted?: boolean;
  /** Whether volume controls are disabled (e.g., fixed line-level output) */
  disabled?: boolean;
  /** Callback when volume changes */
  onVolumeChange: (volume: number) => void;
  /** Callback when mute is toggled. Without it the row has no mute button. */
  onMuteToggle?: () => void;
  /** Accessible label for mute button. Should include speaker name for context (e.g., "Mute Living Room"). */
  muteLabel?: string;
  /** Accessible label for unmute button. Should include speaker name for context (e.g., "Unmute Living Room"). */
  unmuteLabel?: string;
  /** Accessible label for the volume slider. Should include speaker name for context (e.g., "Living Room volume"). */
  volumeLabel: string;
  /** Spoken in place of the level while it is not known yet */
  unknownLabel?: string;
  /** When set, shown in place of the slider (e.g. "Fixed" for a line-level output) */
  fixedLabel?: string;
  /** A short line under the row (e.g. "Now 72; starts at 30") */
  caption?: string;
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
 * @param props.disabled
 * @param props.onVolumeChange - Volume change callback
 * @param props.onMuteToggle - Mute toggle callback
 * @param props.muteLabel - Accessible label for mute button (include speaker name)
 * @param props.unmuteLabel - Accessible label for unmute button (include speaker name)
 * @param props.volumeLabel - Accessible label for volume slider (include speaker name)
 * @param props.unknownLabel - Spoken in place of the level while it is not known
 * @param props.fixedLabel - Shown in place of the slider when set
 * @param props.caption - A short line under the row
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
  disabled,
  onVolumeChange,
  onMuteToggle,
  muteLabel,
  unmuteLabel,
  volumeLabel,
  unknownLabel,
  fixedLabel,
  caption,
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
      {fixedLabel ? (
        <span className={styles.fixed}>{fixedLabel}</span>
      ) : (
        <VolumeControl
          volume={volume}
          muted={muted}
          disabled={disabled}
          onVolumeChange={onVolumeChange}
          onMuteToggle={onMuteToggle}
          muteLabel={muteLabel}
          unmuteLabel={unmuteLabel}
          volumeLabel={volumeLabel}
          unknownLabel={unknownLabel}
        />
      )}
      {caption && <span className={styles.caption}>{caption}</span>}
    </div>
  );
}
