import type { ComponentChildren } from 'preact';
import type { HTMLAttributes } from 'preact/compat';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import styles from './Card.module.css';

type HeadingLevel = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Card content */
  children: ComponentChildren;
  /** Optional card title */
  title?: string;
  /** Optional icon to display before the title */
  icon?: GlyphName;
  /** Heading level for the title (default: h2). Use to maintain proper heading hierarchy. */
  titleLevel?: HeadingLevel;
  /** Remove default padding (for cards with custom internal layout) */
  noPadding?: boolean;
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
 * @returns The rendered Card component
 */
export function Card({
  children,
  title,
  icon,
  titleLevel = 'h2',
  className,
  noPadding,
  ...rest
}: CardProps) {
  const classes = [styles.card, noPadding && styles.noPadding, className].filter(Boolean).join(' ');
  const TitleTag = titleLevel;

  return (
    <div className={classes} {...rest}>
      {title && (
        <TitleTag className={styles.title}>
          {icon && (
            <span className={styles.icon}>
              <Icon glyph={icon} />
            </span>
          )}
          <span className={styles.titleText}>{title}</span>
        </TitleTag>
      )}
      {children}
    </div>
  );
}
