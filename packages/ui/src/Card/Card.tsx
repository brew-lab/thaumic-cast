import type { ComponentChildren, CSSProperties } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import styles from './Card.module.css';

type HeadingLevel = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

interface CardProps {
  /** Card content */
  children: ComponentChildren;
  /** Optional card title */
  title?: string;
  /** Optional icon to display before the title */
  icon?: LucideIcon;
  /** Heading level for the title (default: h2). Use to maintain proper heading hierarchy. */
  titleLevel?: HeadingLevel;
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
 * @param props.icon - Optional icon to display before the title
 * @param props.titleLevel - Heading level for title (default: h2)
 * @param props.className - Additional CSS class
 * @param props.noPadding - Remove default padding
 * @param props.style - Inline styles
 * @returns The rendered Card component
 */
export function Card({
  children,
  title,
  icon: Icon,
  titleLevel = 'h2',
  className,
  noPadding,
  style,
}: CardProps) {
  const classes = [styles.card, noPadding && styles.noPadding, className].filter(Boolean).join(' ');
  const TitleTag = titleLevel;

  return (
    <div className={classes} style={style}>
      {title && (
        <TitleTag className={styles.title}>
          {Icon && <Icon size={18} fill="currentColor" className={styles.icon} />}
          <span className={styles.titleText}>{title}</span>
        </TitleTag>
      )}
      {children}
    </div>
  );
}
