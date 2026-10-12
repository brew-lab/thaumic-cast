import type { JSX } from 'preact';
import { cx } from '../utils/cx';
import styles from './StepIndicator.module.css';

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
export const defaultStepOfLabel: StepOfLabel = (current, total, label) =>
  `Step ${current} of ${total}${label ? `: ${label}` : ''}`;

/** Where one step stands. */
export type StepState = 'done' | 'current' | 'to-come';

/**
 * The state of each step.
 * @param current - The current step, counted from 0
 * @param total - The total number of steps
 * @returns One state per step
 */
export function stepStates(current: number, total: number): StepState[] {
  return Array.from({ length: total }, (_, i) =>
    i < current ? 'done' : i === current ? 'current' : 'to-come',
  );
}

const STATE_CLASS: Record<StepState, string> = {
  done: styles.done,
  current: styles.current,
  'to-come': styles.toCome,
};

/** Props for {@link StepIndicator}. */
export interface StepIndicatorProps {
  /** The current step, counted from 0. */
  current: number;
  /** The total number of steps. */
  total: number;
  /** The steps' labels, for the accessible name. */
  labels?: string[];
  /** Words the accessible name (for i18n); English when omitted. */
  stepOfLabel?: StepOfLabel;
}

/**
 * Where a wizard is (DESIGN.md A-step): done is a filled dot, the current step the long
 * pill, a step to come a ring, so the shape tells them apart. It is a `progressbar` named
 * "Step {{n}} of {{m}}: {{label}}". The dots are `--size-dot-sm` in the popup and
 * `--size-dot-md` on the desktop.
 * @param props - Component props
 * @param props.current - The current step, from 0
 * @param props.total - The total number of steps
 * @param props.labels - The steps' labels
 * @param props.stepOfLabel - Words the accessible name
 * @returns The indicator
 */
export function StepIndicator({
  current,
  total,
  labels,
  stepOfLabel = defaultStepOfLabel,
}: StepIndicatorProps): JSX.Element {
  return (
    <div
      class={styles.indicator}
      role="progressbar"
      aria-valuenow={current + 1}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={stepOfLabel(current + 1, total, labels?.[current] || undefined)}
    >
      {stepStates(current, total).map((state, i) => (
        <span key={i} class={cx(styles.step, STATE_CLASS[state])} />
      ))}
    </div>
  );
}
