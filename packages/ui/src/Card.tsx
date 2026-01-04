import type { ComponentChildren } from 'preact';

interface CardProps {
  /** Card content */
  children: ComponentChildren;
  /** Optional card title */
  title?: string;
  /** Additional CSS class */
  className?: string;
  /** Remove default padding (for cards with custom internal layout) */
  noPadding?: boolean;
}

/**
 * Shared Card Component for grouping content.
 * @param props - Component props
 * @param props.children - Card content
 * @param props.title - Optional card title
 * @param props.className - Additional CSS class
 * @param props.noPadding - Remove default padding
 * @returns The rendered Card component
 */
export function Card({ children, title, className, noPadding }: CardProps) {
  const classes = ['card', noPadding && 'cardNoPadding', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {title && <h2 className="cardTitle">{title}</h2>}
      {children}
    </div>
  );
}
