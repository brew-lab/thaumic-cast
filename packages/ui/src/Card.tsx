import type { ComponentChildren } from 'preact';

interface CardProps {
  children: ComponentChildren;
  title?: string;
  className?: string;
}

/**
 * Shared Card Component for grouping content.
 * @param props - Component props
 * @param props.children - Card content
 * @param props.title - Optional card title
 * @param props.className - Additional CSS class
 * @returns The rendered Card component
 */
export function Card({ children, title, className }: CardProps) {
  return (
    <div className={`card ${className || ''}`}>
      {title && <h2 className="cardTitle">{title}</h2>}
      {children}
    </div>
  );
}
