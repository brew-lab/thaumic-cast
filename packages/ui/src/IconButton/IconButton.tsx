import type { JSX } from 'preact';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { Tooltip } from '../Tooltip';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { usePress } from '../utils/press';
import styles from './IconButton.module.css';

/** Props for {@link IconButton}. */
export interface IconButtonProps extends DataAttributes {
  /** The glyph. */
  glyph: GlyphName;
  /** The accessible name, required: "Mute Kitchen", "Remove Kitchen", "Settings". */
  label: string;
  /** quiet (no fill; the default) or tonal (`--container-high`: Settings, Play and Pause). */
  kind?: 'quiet' | 'tonal';
  /** sm 1.75rem (28) or md 2rem (32), on both densities (F-size). */
  size?: 'sm' | 'md';
  /** A state that stays down (mute): `aria-pressed`, with the glyph swapped, never a fill. */
  pressed?: boolean;
  /** The glyph while pressed, e.g. `volume-off` for mute. */
  pressedGlyph?: GlyphName;
  /** Busy: the Clacks replace the glyph; focus stays. */
  busy?: boolean;
  /** Disabled. */
  disabled?: boolean;
  /** Show the name in a Tooltip on hover and focus (the desktop; DESIGN.md A-iconbtn). */
  tooltip?: boolean;
  /**
   * Something waits behind the button (Settings while an update exists): a small `--primary`
   * dot at its block-start, inline-end corner, outside the shaped surface. Never alone: the
   * name says it too ("Settings, update available").
   */
  mark?: boolean;
  /** The action. */
  onPress?: (event: MouseEvent) => void;
  /** Keyboard handling, e.g. Delete on a chip's remove button. */
  onKeyDown?: (event: KeyboardEvent) => void;
  /** Ties a hint to the button. */
  'aria-describedby'?: string;
  /** Names the region the button opens or controls. */
  'aria-controls'?: string;
}

/**
 * The icon-only action (DESIGN.md A-iconbtn). Quiet or tonal, never filled. The box is
 * 28 or 32 on every surface, and an `::after` hit area grows it to `--hit-min` (44 in a
 * window and under touch). Mute keeps one name; `aria-pressed` carries its state and the glyph swaps.
 * A `mark` dot sits at the corner, outside the shape the focus and the press draw, so neither
 * clips it and nothing moves.
 * @param props - Component props
 * @param props.glyph - The glyph
 * @param props.label - The accessible name
 * @param props.kind - quiet or tonal
 * @param props.size - sm or md
 * @param props.pressed - On, for a state that stays down
 * @param props.pressedGlyph - The glyph while pressed
 * @param props.busy - Busy
 * @param props.disabled - Disabled
 * @param props.tooltip - Show the name in a Tooltip
 * @param props.mark - Something waits behind the button: the corner dot
 * @param props.onPress - The action
 * @param props.onKeyDown - Keyboard handling
 * @returns The button
 */
export function IconButton({
  glyph,
  label,
  kind = 'quiet',
  size = 'md',
  pressed,
  pressedGlyph,
  busy = false,
  disabled = false,
  tooltip = false,
  mark = false,
  onPress,
  onKeyDown,
  ...rest
}: IconButtonProps): JSX.Element {
  const shown = pressed && pressedGlyph ? pressedGlyph : glyph;
  const press = usePress();
  const button = (
    <button
      type="button"
      class={cx(styles.iconButton, styles[kind], styles[size])}
      data-size={size}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-busy={busy ? 'true' : undefined}
      aria-disabled={busy ? 'true' : undefined}
      aria-describedby={rest['aria-describedby']}
      aria-controls={rest['aria-controls']}
      disabled={disabled}
      onClick={(event) => {
        if (!busy) onPress?.(event);
      }}
      onKeyDown={onKeyDown}
      {...press}
      {...dataAttributes(rest)}
    >
      {busy ? <Clacks size="sm" /> : <Icon glyph={shown} />}
      {mark && <span class={styles.mark} aria-hidden="true" />}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
