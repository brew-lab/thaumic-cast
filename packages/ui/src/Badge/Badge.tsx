import type { JSX } from 'preact';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { cx } from '../utils/cx';
import styles from './Badge.module.css';

/** The Badge tones (DESIGN.md A-badge). The count tone is retired. */
export type BadgeTone = 'casting' | 'neutral' | 'warning' | 'danger' | 'busy';

/** Props for {@link Badge}. */
export interface BadgeProps {
  /** casting: filled lilac; neutral: outlined; warning, danger: container + glyph; busy: outlined + Clacks. */
  tone: BadgeTone;
  /** The word, in sentence case: it is shown in capitals and read as written. */
  label: string;
}

const GLYPH: Partial<Record<BadgeTone, GlyphName>> = { warning: 'warning', danger: 'danger' };

/**
 * The glyph a tone carries, so no tone is told by colour alone.
 * @param tone - The tone
 * @returns The glyph, the Clacks for busy, or none
 */
export function badgeMark(tone: BadgeTone): GlyphName | 'clacks' | null {
  if (tone === 'busy') return 'clacks';
  return GLYPH[tone] ?? null;
}

/**
 * A status word on a row, a card or a fold summary (DESIGN.md A-badge). It absorbs
 * StatusChip, SyncStatus, StatusMark and the desktop's device pill. Geist capitals at
 * `--text-1`; warning, danger and busy carry a shape as well as a colour. It is never
 * focusable, never truncated and never magenta, and it never announces itself.
 * @param props - Component props
 * @param props.tone - The tone
 * @param props.label - The word
 * @returns The badge
 */
export function Badge({ tone, label }: BadgeProps): JSX.Element {
  const mark = badgeMark(tone);
  return (
    <span class={cx(styles.badge, styles[tone])}>
      {mark === 'clacks' ? (
        <Clacks size="sm" />
      ) : mark ? (
        <span class={styles.glyph}>
          <Icon glyph={mark} />
        </span>
      ) : null}
      <span class={styles.label}>{label}</span>
    </span>
  );
}
