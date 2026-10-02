import styles from './Wizard.module.css';

/**
 * Words the indicator's accessible name.
 * @param current - The current step, counted from 1
 * @param total - The total number of steps
 * @param label - The current step's label, when it has one
 * @returns The text a screen reader announces
 */
export type StepOfLabel = (current: number, total: number, label?: string) => string;

/**
 * The English accessible name, used when no `stepOfLabel` is passed.
 * @param current - The current step, counted from 1
 * @param total - The total number of steps
 * @param label - The current step's label, when it has one
 * @returns The text a screen reader announces
 */
const defaultStepOfLabel: StepOfLabel = (current, total, label) =>
  `Step ${current} of ${total}${label ? `: ${label}` : ''}`;

interface StepIndicatorProps {
  /** Current step (0-based) */
  current: number;
  /** Total number of steps */
  total: number;
  /** Optional step labels for accessibility */
  labels?: string[];
  /** Words the accessible name (for i18n); English when omitted */
  stepOfLabel?: StepOfLabel;
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
 * @param props.stepOfLabel
 * @param props.className
 * @returns The rendered StepIndicator component
 */
export function StepIndicator({
  current,
  total,
  labels,
  stepOfLabel = defaultStepOfLabel,
  className,
}: StepIndicatorProps): preact.JSX.Element {
  return (
    <div
      className={[styles.indicator, className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-valuenow={current + 1}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={stepOfLabel(current + 1, total, labels?.[current] || undefined)}
    >
      {Array.from({ length: total }, (_, i) => {
        const isCompleted = i < current;
        const isActive = i === current;
        const label = labels?.[i];

        const className = [
          styles.dot,
          isCompleted && styles.dotCompleted,
          isActive && styles.dotActive,
        ]
          .filter(Boolean)
          .join(' ');

        return <div key={i} className={className} aria-hidden="true" title={label} />;
      })}
    </div>
  );
}
