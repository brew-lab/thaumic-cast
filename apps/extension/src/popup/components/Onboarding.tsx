import { useState, useCallback } from 'preact/hooks';
import { Wizard } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { WelcomeStep } from './onboarding/WelcomeStep';
import { DesktopConnectionStep } from './onboarding/DesktopConnectionStep';
import { SpeakerStep } from './onboarding/SpeakerStep';
import { ReadyStep } from './onboarding/ReadyStep';
import styles from './Onboarding.module.css';

const STEP_KEYS = ['welcome', 'desktop', 'speakers', 'ready'] as const;

interface OnboardingProps {
  /** Called when onboarding is completed */
  onComplete: () => Promise<void>;
  /** Called when onboarding is skipped */
  onSkip: () => Promise<void>;
}

/**
 * Main onboarding flow for the extension popup.
 * Guides through desktop connection and speaker discovery.
 *
 * @param props - Component props
 * @param props.onComplete
 * @param props.onSkip
 * @returns The rendered Onboarding component
 */
export function Onboarding({ onComplete, onSkip }: OnboardingProps): preact.JSX.Element {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState(0);
  const [desktopConnected, setDesktopConnected] = useState(false);
  const [speakersFound, setSpeakersFound] = useState(false);

  const totalSteps = STEP_KEYS.length;
  const isLastStep = currentStep === totalSteps - 1;

  const handleNext = useCallback(() => {
    if (isLastStep) {
      onComplete();
    } else {
      setCurrentStep((prev) => Math.min(prev + 1, totalSteps - 1));
    }
  }, [isLastStep, onComplete, totalSteps]);

  const handleBack = useCallback(() => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  }, []);

  const handleSkip = useCallback(() => {
    onSkip();
  }, [onSkip]);

  const handleConnectionChange = useCallback((connected: boolean) => {
    setDesktopConnected(connected);
  }, []);

  const handleSpeakersFound = useCallback((found: boolean) => {
    setSpeakersFound(found);
  }, []);

  // Determine if next should be disabled based on current step
  const isNextDisabled =
    (currentStep === 1 && !desktopConnected) || (currentStep === 2 && !speakersFound);

  const labels = {
    next: t('onboarding.next'),
    back: t('onboarding.back'),
    skip: t('onboarding.skip'),
    finish: t('onboarding.finish'),
  };

  const stepLabels = [
    t('onboarding.step_welcome'),
    t('onboarding.step_desktop'),
    t('onboarding.step_speakers'),
    t('onboarding.step_ready'),
  ];

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return <WelcomeStep />;
      case 1:
        return <DesktopConnectionStep onConnectionChange={handleConnectionChange} />;
      case 2:
        return <SpeakerStep onSpeakersFound={handleSpeakersFound} />;
      case 3:
        return <ReadyStep />;
      default:
        return null;
    }
  };

  return (
    <div className={styles.onboarding}>
      <Wizard
        currentStep={currentStep}
        totalSteps={totalSteps}
        onNext={handleNext}
        onBack={handleBack}
        onSkip={handleSkip}
        showSkip={true}
        labels={labels}
        nextDisabled={isNextDisabled}
        isFinal={isLastStep}
        stepLabels={stepLabels}
        compact
      >
        {renderStep()}
      </Wizard>
    </div>
  );
}
