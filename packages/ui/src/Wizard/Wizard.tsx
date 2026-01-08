import type { ComponentChildren } from 'preact';
import { ChevronLeft } from 'lucide-preact';
import { Button } from '../Button';
import { IconButton } from '../IconButton';
import { StepIndicator } from './StepIndicator';
import styles from './Wizard.module.css';

interface WizardLabels {
  next?: string;
  back?: string;
  skip?: string;
  finish?: string;
}

interface WizardProps {
  /** Current step index (0-based) */
  currentStep: number;
  /** Total number of steps */
  totalSteps: number;
  /** The current step content */
  children: ComponentChildren;
  /** Called when user clicks "Next" or "Finish" */
  onNext: () => void;
  /** Called when user clicks "Back" */
  onBack?: () => void;
  /** Called when user clicks "Skip" */
  onSkip?: () => void;
  /** Whether skip button should be shown */
  showSkip?: boolean;
  /** Custom labels for buttons (for i18n) */
  labels?: WizardLabels;
  /** Whether the next button is disabled (e.g., waiting for connection) */
  nextDisabled?: boolean;
  /** Whether we're on the final step */
  isFinal?: boolean;
  /** Optional step labels for accessibility */
  stepLabels?: string[];
  /** Use compact layout with icon-only back button in header (for popups) */
  compact?: boolean;
}

/**
 * A wizard component for multi-step flows.
 * Used for onboarding and setup experiences.
 *
 * @param props - Wizard configuration
 * @param props.currentStep
 * @param props.totalSteps
 * @param props.children
 * @param props.onNext
 * @param props.onBack
 * @param props.onSkip
 * @param props.showSkip
 * @param props.labels
 * @param props.nextDisabled
 * @param props.isFinal
 * @param props.stepLabels
 * @param props.compact
 * @returns The rendered Wizard component
 */
export function Wizard({
  currentStep,
  totalSteps,
  children,
  onNext,
  onBack,
  onSkip,
  showSkip = true,
  labels = {},
  nextDisabled = false,
  isFinal = false,
  stepLabels,
  compact = false,
}: WizardProps): preact.JSX.Element {
  const { next = 'Next', back = 'Back', skip = 'Skip', finish = 'Finish' } = labels;

  const isFirstStep = currentStep === 0;
  const nextLabel = isFinal ? finish : next;
  const showBackInHeader = compact && !isFirstStep && onBack;

  if (compact) {
    return (
      <div
        className={[styles.wizard, styles.compact].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label="Setup wizard"
      >
        <div className={styles.header}>
          <div className={styles.back}>
            {showBackInHeader && (
              <IconButton variant="ghost" size="sm" onClick={onBack} title={back} aria-label={back}>
                <ChevronLeft size={18} />
              </IconButton>
            )}
          </div>
          <StepIndicator
            current={currentStep}
            total={totalSteps}
            labels={stepLabels}
            className={styles.indicator}
          />
        </div>
        <div className={styles.content}>{children}</div>
        <div className={styles.footer}>
          <div className={styles.footerStart}>
            {showSkip && onSkip && (
              <button type="button" className={styles.skipBtn} onClick={onSkip} aria-label={skip}>
                {skip}
              </button>
            )}
          </div>
          <div className={styles.footerEnd}>
            <Button
              variant="primary"
              onClick={onNext}
              disabled={nextDisabled}
              className={styles.footerButton}
            >
              {nextLabel}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wizard} role="dialog" aria-modal="true" aria-label="Setup wizard">
      <StepIndicator
        current={currentStep}
        total={totalSteps}
        labels={stepLabels}
        className={styles.indicator}
      />

      <div className={styles.content}>{children}</div>

      <div className={styles.footer}>
        <div className={styles.footerStart}>
          {showSkip && onSkip && (
            <button type="button" className={styles.skipBtn} onClick={onSkip} aria-label={skip}>
              {skip}
            </button>
          )}
        </div>

        <div className={styles.footerEnd}>
          {!isFirstStep && onBack && (
            <Button variant="secondary" onClick={onBack} className={styles.footerButton}>
              {back}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={onNext}
            disabled={nextDisabled}
            className={styles.footerButton}
          >
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
