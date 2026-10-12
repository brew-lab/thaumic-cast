import type { JSX } from 'preact';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import { cx } from '../utils/cx';
import styles from './StatusDot.module.css';

/** The four states a StatusDot shows; `off` folds into `failed`. */
export type StatusDotState = 'connected' | 'checking' | 'failed' | 'live';

/** Props for {@link StatusDot}. */
export interface StatusDotProps {
  /** connected: a dot; checking: the Clacks; failed: circle-x; live: the magenta lamp. */
  state: StatusDotState;
  /** sm (`--size-dot-sm`) in a 12 to 13 px line, md (`--size-dot-md`) from 14 px. */
  size?: 'sm' | 'md';
  /** On a fill (the live dot on the artwork band): adds a `--ring-gap` ring. */
  onFill?: boolean;
}

/**
 * The small state mark beside words (DESIGN.md A-dot). Each state has its own shape, so no
 * state is told by colour alone, and magenta means live and nothing else. It is decorative
 * (`aria-hidden`): the words beside it are the content. It never animates, except that the
 * checking state is the Clacks.
 * @param props - Component props
 * @param props.state - The state
 * @param props.size - sm or md
 * @param props.onFill - Ring it, for a fill
 * @returns The mark
 */
export function StatusDot({ state, size = 'sm', onFill = false }: StatusDotProps): JSX.Element {
  if (state === 'checking') {
    return (
      <span class={cx(styles.dot, styles.checking)} aria-hidden="true">
        <Clacks size="sm" />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span class={cx(styles.glyph, styles[size])} aria-hidden="true">
        <Icon glyph="danger" />
      </span>
    );
  }
  return (
    <span
      class={cx(styles.dot, styles.round, styles[size], styles[state], onFill && styles.onFill)}
      aria-hidden="true"
    />
  );
}
