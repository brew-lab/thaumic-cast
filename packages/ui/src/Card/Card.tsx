import type { ComponentChildren, CSSProperties } from 'preact';
import styles from './Card.module.css';

interface CardProps {
  /** Card content */
  children: ComponentChildren;
  /** Optional card title */
  title?: string;
  /** Additional CSS class */
  className?: string;
  /** Remove default padding (for cards with custom internal layout) */
  noPadding?: boolean;
  /** Inline styles */
  style?: CSSProperties;
}

/**
 * Shared Card Component for grouping content.
 * @param props - Component props
 * @param props.children - Card content
 * @param props.title - Optional card title
 * @param props.className - Additional CSS class
 * @param props.noPadding - Remove default padding
 * @param props.style - Inline styles
 * @returns The rendered Card component
 */
export function Card({ children, title, className, noPadding, style }: CardProps) {
  const classes = [styles.card, noPadding && styles['no-padding'], className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={style}>
      {title && <h2 className={styles.title}>{title}</h2>}
      {children}
    </div>
  );
}
