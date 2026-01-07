import type { JSX, ComponentChildren } from 'preact';

type StatusVariant = 'waiting' | 'acquiring' | 'synced' | 'lost';

interface StatusChipProps {
  /** The status variant */
  variant: StatusVariant;
  /** Child content (typically text) */
  children: ComponentChildren;
  /** Additional CSS class */
  className?: string;
}

/**
 * Status chip component for displaying sync status.
 * Uses semantic colors for different states.
 * @param props - Component props
 * @param props.variant - The status variant
 * @param props.children - Child content
 * @param props.className - Additional CSS class
 * @returns The rendered StatusChip component
 */
export function StatusChip({ variant, children, className }: StatusChipProps): JSX.Element {
  const variantClass = `statusChip${variant.charAt(0).toUpperCase() + variant.slice(1)}`;
  const combinedClass = `statusChip ${variantClass} ${className || ''}`.trim();

  return (
    <span className={combinedClass} role="status">
      {children}
    </span>
  );
}
