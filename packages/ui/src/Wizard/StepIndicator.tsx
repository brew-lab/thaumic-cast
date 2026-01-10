import styles from './Wizard.module.css';

interface StepIndicatorProps {
  /** Current step (0-based) */
  current: number;
  /** Total number of steps */
  total: number;
  /** Optional step labels for accessibility */
  labels?: string[];
  /** Additional CSS class */
  className?: string;
}

/**
 * Visual progress indicator for wizard steps.
 * Shows dots representing each step, with the current step highlighted.
 *
 * @param props - Indicator configuration
 * @param props.current
 * @param props.total
 * @param props.labels
 * @param props.className
 * @returns The rendered StepIndicator component
 */
export function StepIndicator({
  current,
  total,
  labels,
  className,
}: StepIndicatorProps): preact.JSX.Element {
  return (
    <div
      className={[styles.indicator, className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-valuenow={current + 1}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={`Step ${current + 1} of ${total}${
        labels?.[current] ? `: ${labels[current]}` : ''
      }`}
    >
      {Array.from({ length: total }, (_, i) => {
        const isCompleted = i < current;
        const isActive = i === current;
        const label = labels?.[i];

        const className = [
          styles.dot,
          isCompleted && styles['dot-completed'],
          isActive && styles['dot-active'],
        ]
          .filter(Boolean)
          .join(' ');

        return <div key={i} className={className} aria-hidden="true" title={label} />;
      })}
    </div>
  );
}
