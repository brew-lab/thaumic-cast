import type { ComponentChildren } from 'preact';
import styles from './ButtonGroup.module.css';

export interface ButtonGroupProps {
  /** Button elements to group */
  children: ComponentChildren;
  /** Gap size between buttons */
  gap?: 'xs' | 'sm' | 'md';
  /** Whether buttons should wrap to next line */
  wrap?: boolean;
  /** Whether buttons should grow to fill available space equally */
  grow?: boolean;
  /** Horizontal alignment of the button group */
  align?: 'start' | 'center' | 'end';
  /** Additional CSS class */
  className?: string;
}

/**
 * Groups buttons together with consistent spacing and alignment.
 *
 * @param props - ButtonGroup configuration
 * @param props.children - Button elements to group
 * @param props.gap - Gap size between buttons (default: 'sm')
 * @param props.wrap - Whether buttons should wrap (default: false)
 * @param props.grow - Whether buttons should grow equally (default: false)
 * @param props.align - Horizontal alignment (default: 'end')
 * @param props.className - Additional CSS class
 * @returns The rendered ButtonGroup component
 */
export function ButtonGroup({
  children,
  gap = 'sm',
  wrap = false,
  grow = false,
  align = 'end',
  className,
}: ButtonGroupProps) {
  const classes = [
    styles.group,
    styles[`gap-${gap}`],
    wrap && styles.wrap,
    grow && styles.grow,
    styles[`align-${align}`],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <div className={classes}>{children}</div>;
}
