import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import { IconButton } from '../IconButton';
import { Slider } from '../Slider';
import { cx } from '../utils/cx';
import { useVolumeControl } from './useVolumeControl';
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
  /** Callback when mute is toggled. Without it (or `muteLabel`) the row has no mute button. */
  onMuteToggle?: () => void;
  /**
   * The mute button's one name, e.g. "Mute Living Room"; `aria-pressed` carries the state
   * (DESIGN.md A-iconbtn).
   */
  muteLabel?: string;
  /** @deprecated Mute keeps one name; `aria-pressed` carries the state. Ignored. */
  unmuteLabel?: string;
  /** Accessible label for the volume slider, e.g. "Living Room volume". */
  volumeLabel: string;
  /** Read in place of the level while it is not known yet ("Not known yet"). */
  unknownText?: string;
  /** When set, shown in place of the slider (e.g. "Fixed" for a line-level output). */
  fixedLabel?: string;
  /** A short line under the row (e.g. "Now 72; starts at 30"); it describes the slider. */
  caption?: string;
  /** Optional status indicator element */
  statusIndicator?: JSX.Element;
  /** Callback when remove button is clicked. If absent, no remove button shown. */
  onRemove?: () => void;
  /** Accessible label for remove button */
  removeLabel?: string;
}

/**
 * A speaker's name, mute, volume and Remove.
 *
 * @deprecated Phase 3 replaces it with RoomRow `cast` and StartLevel (DESIGN.md §14); until
 * then it draws the v1 atoms: IconButton mute, Slider and the quiet square Remove.
 * @param props - Component props
 * @param props.speakerName - Display name for the speaker
 * @param props.speakerIp - Speaker coordinator IP
 * @param props.volume - Current volume level, or undefined while not known
 * @param props.muted - Whether muted
 * @param props.disabled - Disabled (a fixed output)
 * @param props.onVolumeChange - Volume change callback
 * @param props.onMuteToggle - Mute toggle callback; no mute button without it
 * @param props.muteLabel - The mute button's name
 * @param props.volumeLabel - The slider's name
 * @param props.unknownText - Read while the level is not known
 * @param props.fixedLabel - Shown in place of the slider when set
 * @param props.caption - A short line under the row
 * @param props.statusIndicator - Optional status indicator element
 * @param props.onRemove - Optional callback when remove button is clicked
 * @param props.removeLabel - Accessible label for remove button
 * @returns The rendered SpeakerVolumeRow component
 */
export function SpeakerVolumeRow({
  speakerName,
  speakerIp,
  volume,
  muted = false,
  disabled = false,
  onVolumeChange,
  onMuteToggle,
  muteLabel,
  volumeLabel,
  unknownText,
  fixedLabel,
  caption,
  statusIndicator,
  onRemove,
  removeLabel,
}: SpeakerVolumeRowProps): JSX.Element {
  const control = useVolumeControl(volume, muted, onVolumeChange, onMuteToggle);
  const captionId = useId();
  return (
    <div class={styles.row} data-speaker-ip={speakerIp} role="group" aria-label={speakerName}>
      <div class={styles.header}>
        <span class={styles.name}>{speakerName}</span>
        {statusIndicator}
        {onRemove && removeLabel && (
          <span class={styles.remove}>
            <IconButton glyph="stop" label={removeLabel} onPress={onRemove} />
          </span>
        )}
      </div>
      <div class={styles.controls}>
        {onMuteToggle && muteLabel && (
          <IconButton
            glyph="volume"
            pressedGlyph="volume-off"
            pressed={muted}
            label={muteLabel}
            disabled={disabled}
            onPress={control.toggleMute}
          />
        )}
        {fixedLabel ? (
          <span class={styles.fixed}>{fixedLabel}</span>
        ) : (
          <>
            <Slider
              label={volumeLabel}
              value={control.level}
              unknownText={unknownText}
              disabled={disabled}
              onChange={control.change}
              onPointerDown={control.pointerDown}
              onPointerUp={control.pointerUp}
              aria-describedby={caption ? captionId : undefined}
            />
            <span class={cx(styles.value, 'num')} aria-hidden="true">
              {control.level ?? '…'}
            </span>
          </>
        )}
      </div>
      {caption && (
        <span id={captionId} class={styles.caption}>
          {caption}
        </span>
      )}
    </div>
  );
}
