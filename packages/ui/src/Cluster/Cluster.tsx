import type { ComponentChildren, JSX } from 'preact';
import styles from './Cluster.module.css';

/** Props for {@link Cluster}. */
export interface ClusterProps {
  /** The gap between items, a space step: 2 `--space-2`, 3 `--space-3` (default), 4 `--space-4`. */
  gap?: '2' | '3' | '4';
  /** Where the items sit along the row. Defaults to start. */
  justify?: 'start' | 'end' | 'between';
  /**
   * An actions row: under a 25rem cluster the items stack full width, in DOM order (danger
   * last). The cluster then fills its container's inline size.
   */
  stack?: boolean;
  /** The element to render. Defaults to div. */
  as?: 'div' | 'ul' | 'ol' | 'p' | 'span';
  /** The items. */
  children: ComponentChildren;
  /** An accessible name, when the row is a group with a label of its own. */
  'aria-label'?: string;
  /** A role, such as "group" for a row of related actions. */
  role?: 'group' | 'list' | 'toolbar';
}

// The apps' CSS Modules export camelCase names only (gap-2 → gap2).
const GAP_CLASS = { '2': styles.gap2, '3': '', '4': styles.gap4 };
const JUSTIFY_CLASS = { start: '', end: styles.justifyEnd, between: styles.justifyBetween };

/**
 * The one layout primitive for a row of things (DESIGN.md F-utils): a wrapping flex row
 * with a gap from T-space. It replaces ButtonGroup and ChipSet. Do not wrap a single item.
 * @param props - Component props
 * @param props.gap - The gap step
 * @param props.justify - Alignment along the row
 * @param props.stack - Stack the items full width under 25rem
 * @param props.as - The element to render
 * @param props.children - The items
 * @returns The row
 */
export function Cluster({
  gap = '3',
  justify = 'start',
  stack = false,
  as = 'div',
  children,
  ...rest
}: ClusterProps): JSX.Element {
  // One element type for the checker; every option takes the same attributes here.
  const Tag = as as 'div';
  const className = [
    styles.cluster,
    GAP_CLASS[gap],
    JUSTIFY_CLASS[justify],
    stack ? styles.stack : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag class={className} {...rest}>
      {children}
    </Tag>
  );
}
