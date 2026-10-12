import type { ComponentChildren } from 'preact';
import { Button } from '../Button';
import { Card } from '../Card';
import { Cluster } from '../Cluster';
import { IconButton } from '../IconButton';
import { PopupShell } from '../PopupShell';
import { StepIndicator, type StepOfLabel } from '../StepIndicator';
import { StickyActionBar } from '../StickyActionBar';
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
  /** Words the step indicator's accessible name (for i18n); English when omitted */
  stepOfLabel?: StepOfLabel;
  /**
   * The popup's form: a PopupShell as tall as the popup can be, Back (icon only) and the step
   * indicator in its header row, the step in a Card, and Skip and Carry on in a StickyActionBar.
   */
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
 * @param props.stepOfLabel
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
  stepOfLabel,
  compact = false,
}: WizardProps): preact.JSX.Element {
  const { next = 'Next', back = 'Back', skip = 'Skip', finish = 'Finish' } = labels;

  const isFirstStep = currentStep === 0;
  const nextLabel = isFinal ? finish : next;
  const showBackInHeader = compact && !isFirstStep && onBack;

  if (compact) {
    // The popup's onboarding (L-wizard compact) is the main popup's frame: a PopupShell as
    // tall as the popup can be, so it never changes size from one step to the next. Its
    // header row (Back and the step indicator) takes the PopupHeader's block size, the step
    // sits in a Card on the cards' edges, and Skip and Carry on sit in the StickyActionBar,
    // as the main popup's Cast does.
    return (
      <div className={styles.frame} role="dialog" aria-modal="true" aria-labelledby="wizard-title">
        <PopupShell
          fill
          header={
            <div className={styles.header}>
              <div className={styles.back}>
                {showBackInHeader && (
                  <IconButton kind="tonal" glyph="chevron-start" label={back} onPress={onBack} />
                )}
              </div>
              <StepIndicator
                current={currentStep}
                total={totalSteps}
                labels={stepLabels}
                stepOfLabel={stepOfLabel}
              />
            </div>
          }
          bar={
            <StickyActionBar>
              <div className={styles.actions}>
                <div className={styles.footerStart}>
                  {showSkip && onSkip && (
                    <Button size="md" kind="quiet" flush onClick={onSkip}>
                      {skip}
                    </Button>
                  )}
                </div>
                <Button size="md" kind="filled" onClick={onNext} disabled={nextDisabled}>
                  {nextLabel}
                </Button>
              </div>
            </StickyActionBar>
          }
        >
          <Card>{children}</Card>
        </PopupShell>
      </div>
    );
  }

  return (
    <div className={styles.wizard} role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div class={styles.indicator}>
        <StepIndicator
          current={currentStep}
          total={totalSteps}
          labels={stepLabels}
          stepOfLabel={stepOfLabel}
        />
      </div>

      {/* The full Wizard's one scroller; the compact one is as tall as its step. */}
      <div className={styles.content} data-scroller="">
        {children}
      </div>

      <div className={styles.footer}>
        <div className={styles.footerStart}>
          {showSkip && onSkip && (
            <Button size="md" kind="quiet" flush onClick={onSkip}>
              {skip}
            </Button>
          )}
        </div>

        <Cluster gap="3">
          {!isFirstStep && onBack && (
            <Button size="md" kind="outline" onClick={onBack}>
              {back}
            </Button>
          )}
          <Button size="md" kind="filled" onClick={onNext} disabled={nextDisabled}>
            {nextLabel}
          </Button>
        </Cluster>
      </div>
    </div>
  );
}
