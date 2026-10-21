import type { ComponentChildren, JSX } from 'preact';
import { IconButton } from '../IconButton';
import { Slider } from '../Slider';
import { useVolumeControl } from './useVolumeControl';
import styles from './RoomRow.module.css';

/** The words a volume line needs, from the app's locale. */
export interface VolumeLineStrings {
  /** `mute_speaker`: "Mute {{name}}". One name; `aria-pressed` carries the state. */
  mute: (name: string) => string;
  /** `volume_speaker`: "{{name}} volume". */
  volume: (name: string) => string;
  /** `volume_not_known`: "Not known yet", read while the level is unknown. */
  unknown: string;
  /** `volume_fixed_hint`: read as the value of a fixed output. */
  fixed: string;
}

/** Props for {@link VolumeLine}. */
export interface VolumeLineProps {
  /** Who it is for: a room ("Kitchen") or the joined names ("Kitchen + Patio"). */
  name: string;
  /** The level, or undefined while it is not known ("…"). */
  volume?: number;
  /** Muted. */
  muted: boolean;
  /** A fixed output: mute and the slider are disabled; the value stays readable (WCAG 1.4.3). */
  fixed?: boolean;
  /** Tells the speaker a new level (debounced). */
  onVolume: (volume: number) => void;
  /** Mutes or unmutes. */
  onMute: (muted: boolean) => void;
  /**
   * Inert for now (a joining row): mute and the slider keep their places, drawn disabled, so
   * the row lines up with its neighbours and plainly cannot be moved yet.
   */
  disabled?: boolean;
  /** Something after the value: the Remove button. */
  trailing?: ComponentChildren;
  /**
   * Keep the Remove slot, empty, when there is no trailing control: a cast's row, so every
   * row's Slider lines up.
   */
  slot?: boolean;
  /** The words. */
  strings: VolumeLineStrings;
}

/**
 * One volume line (DESIGN.md M-roomrow `cast`, M-groupvol): mute (IconButton quiet md,
 * `pressed` swaps the glyph, no fill) › Slider › its value in a `--ch-volume` box › an
 * optional trailing control. It owns the timing (useVolumeControl): the slider answers at
 * once, the speaker is told after a pause, and reports wait until the hand is still.
 * @param props - Component props
 * @param props.name - Who it is for
 * @param props.volume - The level, if known
 * @param props.muted - Muted
 * @param props.fixed - A fixed output
 * @param props.onVolume - Sets the level
 * @param props.onMute - Mutes or unmutes
 * @param props.disabled - Inert for now
 * @param props.trailing - A trailing control
 * @param props.slot - Keep the empty Remove slot
 * @param props.strings - The words
 * @returns The line
 */
export function VolumeLine({
  name,
  volume,
  muted,
  fixed = false,
  onVolume,
  onMute,
  disabled = false,
  trailing,
  slot = false,
  strings,
}: VolumeLineProps): JSX.Element {
  const control = useVolumeControl(volume, muted, onVolume, () => onMute(!muted));
  return (
    <div class={styles.controls}>
      <IconButton
        glyph="volume"
        pressedGlyph="volume-off"
        pressed={muted}
        label={strings.mute(name)}
        disabled={fixed || disabled}
        onPress={control.toggleMute}
      />
      <span class={styles.slider}>
        <Slider
          label={strings.volume(name)}
          value={control.level}
          unknownText={strings.unknown}
          valueText={fixed ? () => strings.fixed : undefined}
          readout={3}
          disabled={fixed || disabled}
          onChange={control.change}
          onPointerDown={control.pointerDown}
          onPointerUp={control.pointerUp}
        />
      </span>
      {trailing ?? (slot && <span class={styles.reserve} aria-hidden="true" />)}
    </div>
  );
}
