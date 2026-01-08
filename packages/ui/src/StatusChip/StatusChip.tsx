import type { ComponentChildren } from 'preact';
import styles from './StatusChip.module.css';

interface StatusChipProps {
  children: ComponentChildren;
  variant: 'waiting' | 'acquiring' | 'synced' | 'lost';
  className?: string;
}

const VARIANT_CLASSES = {
  waiting: styles.waiting,
  acquiring: styles.acquiring,
  synced: styles.synced,
  lost: styles.lost,
};

/**
 * Shared Status Chip Component
 * @param props - Component props
 * @param props.children
 * @param props.variant
 * @param props.className
 * @returns The rendered StatusChip component
 */
export function StatusChip({ children, variant, className }: StatusChipProps) {
  const combinedClass = [styles.chip, VARIANT_CLASSES[variant], className]
    .filter(Boolean)
    .join(' ');
  return <span className={combinedClass}>{children}</span>;
}
