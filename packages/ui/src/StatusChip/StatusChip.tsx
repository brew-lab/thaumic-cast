import type { ComponentChildren, FunctionComponent } from 'preact';
import type { LucideProps } from 'lucide-preact';
import { Circle, CircleDot, CircleCheck, CircleX } from 'lucide-preact';
import styles from './StatusChip.module.css';

type StatusVariant = 'waiting' | 'acquiring' | 'synced' | 'lost';

interface StatusChipProps {
  children: ComponentChildren;
  variant: StatusVariant;
  className?: string;
}

const VARIANT_CLASSES: Record<StatusVariant, string> = {
  waiting: styles.waiting,
  acquiring: styles.acquiring,
  synced: styles.synced,
  lost: styles.lost,
};

const VARIANT_ICONS: Record<StatusVariant, FunctionComponent<LucideProps>> = {
  waiting: Circle,
  acquiring: CircleDot,
  synced: CircleCheck,
  lost: CircleX,
};

/**
 * Shared Status Chip Component.
 * Uses both color and icon indicators for accessibility (WCAG 1.4.1).
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
  const Icon = VARIANT_ICONS[variant];

  return (
    <span className={combinedClass}>
      <Icon size={10} className={styles.icon} aria-hidden="true" />
      {children}
    </span>
  );
}
