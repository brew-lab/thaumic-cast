import type { ComponentChildren, JSX } from 'preact';
import { Mark } from '../BrandBlock';
import { Clacks } from '../Clacks';
import { cx } from '../utils/cx';
import styles from './EmptyState.module.css';

/** Props for {@link EmptyState}. */
export interface EmptyStateProps {
  /**
   * empty: nothing to show; searching: still asking (the Clacks replace the mark, and the
   * root is `aria-busy`); offline: nothing connected. Every word is a prop.
   */
  kind?: 'empty' | 'searching' | 'offline';
  /** A short title, in Geist, above the body. The popup's one-sentence states have none. */
  title?: string;
  /** What happened and what to do. */
  body: ComponentChildren;
  /** One action, a Button. */
  action?: ComponentChildren;
  /** A line with a link under the action ("added by its IP address"). */
  link?: ComponentChildren;
}

/**
 * What a list shows when it has nothing in it (DESIGN.md M-empty, P-states): the idle mark
 * (never lit) in `--on-surface-variant`, or the Clacks while searching, beside the words.
 * Under 25rem of its own width the art sits beside the words, start-aligned; from 25rem
 * they stack and centre. It takes no focus when it appears, and its words are never a live
 * region. The dashed border is retired.
 * @param props - Component props
 * @param props.kind - empty, searching or offline
 * @param props.title - A short title
 * @param props.body - What happened and what to do
 * @param props.action - One action
 * @param props.link - A line with a link
 * @returns The empty state
 */
export function EmptyState({
  kind = 'empty',
  title,
  body,
  action,
  link,
}: EmptyStateProps): JSX.Element {
  const searching = kind === 'searching';
  return (
    <div class={styles.root} aria-busy={searching ? 'true' : undefined}>
      <div class={cx(styles.empty, styles[kind])}>
        <span class={styles.art} aria-hidden="true">
          {searching ? <Clacks /> : <Mark />}
        </span>
        <div class={styles.words}>
          {title && <p class={styles.title}>{title}</p>}
          <p class={styles.body}>{body}</p>
        </div>
        {(action || link) && (
          <div class={styles.actions}>
            {action}
            {link && <p class={styles.link}>{link}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
