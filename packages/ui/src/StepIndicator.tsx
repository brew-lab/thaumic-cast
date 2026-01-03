interface StepIndicatorProps {
  /** Current step (0-based) */
  current: number;
  /** Total number of steps */
  total: number;
  /** Optional step labels for accessibility */
  labels?: string[];
}

/**
 * Visual progress indicator for wizard steps.
 * Shows dots representing each step, with the current step highlighted.
 *
 * @param props - Indicator configuration
 * @param props.current
 * @param props.total
 * @param props.labels
 * @returns The rendered StepIndicator component
 */
export function StepIndicator({ current, total, labels }: StepIndicatorProps): preact.JSX.Element {
  return (
    <div
      className="stepIndicator"
      role="progressbar"
      aria-valuenow={current + 1}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={`Step ${current + 1} of ${total}${labels?.[current] ? `: ${labels[current]}` : ''}`}
    >
      {Array.from({ length: total }, (_, i) => {
        const isCompleted = i < current;
        const isActive = i === current;
        const label = labels?.[i];

        let className = 'stepDot';
        if (isCompleted) className += ' stepDotCompleted';
        if (isActive) className += ' stepDotActive';

        return <div key={i} className={className} aria-hidden="true" title={label} />;
      })}
    </div>
  );
}
