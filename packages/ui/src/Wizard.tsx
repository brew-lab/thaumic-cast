import type { ComponentChildren } from 'preact';
import { Button } from './Button';
import { StepIndicator } from './StepIndicator';

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
}: WizardProps): preact.JSX.Element {
  const { next = 'Next', back = 'Back', skip = 'Skip', finish = 'Finish' } = labels;

  const isFirstStep = currentStep === 0;
  const nextLabel = isFinal ? finish : next;

  return (
    <div className="wizard" role="dialog" aria-modal="true" aria-label="Setup wizard">
      <StepIndicator current={currentStep} total={totalSteps} labels={stepLabels} />

      <div className="wizardContent">{children}</div>

      <div className="wizardFooter">
        <div className="wizardFooterStart">
          {showSkip && onSkip && (
            <button type="button" className="wizardSkipBtn" onClick={onSkip} aria-label={skip}>
              {skip}
            </button>
          )}
        </div>

        <div className="wizardFooterEnd">
          {!isFirstStep && onBack && (
            <Button variant="secondary" onClick={onBack}>
              {back}
            </Button>
          )}
          <Button variant="primary" onClick={onNext} disabled={nextDisabled}>
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
