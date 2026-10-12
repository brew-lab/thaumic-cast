import type { JSX } from 'preact';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { CLACKS_PATH } from './snake';
import styles from './Clacks.module.css';

/** Props for {@link Clacks}. */
export interface ClacksProps extends DataAttributes {
  /** Working walks three open shutters along the snake; answered lights all eight. */
  state?: 'working' | 'answered';
  /**
   * sm fits an icon slot (a Button, an IconButton, a Switch thumb, a Badge, StatusDot
   * checking); md stands beside words, sized by the density.
   */
  size?: 'sm' | 'md';
}

/**
 * The only busy indicator (DESIGN.md A-clacks): eight shutters, four by two. Working walks
 * three open shutters along the snake path, one step per `--dur-step`; answered lights all
 * eight in `--success-ink`. Under reduced motion the shutters fade instead of walking. It is
 * decorative: always show it with words, which carry the meaning.
 * @param props - Component props
 * @param props.state - Working or answered
 * @param props.size - sm for an icon slot, md beside words
 * @returns The shutters
 */
export function Clacks({ state = 'working', size = 'md', ...rest }: ClacksProps): JSX.Element {
  return (
    <span
      class={cx(styles.clacks, styles[size], state === 'answered' && styles.answered)}
      data-tone={state === 'answered' ? 'success' : undefined}
      aria-hidden="true"
      {...dataAttributes(rest)}
    >
      {CLACKS_PATH.map((_, i) => (
        // The DOM index, for engines without sibling-index(); the CSS turns it into the walk.
        <span key={i} class={styles.shutter} style={{ '--i': i + 1 }} />
      ))}
    </span>
  );
}
