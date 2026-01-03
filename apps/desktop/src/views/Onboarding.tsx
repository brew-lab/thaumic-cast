import { useState, useCallback } from 'preact/hooks';
import { Wizard } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { useOnboarding } from '../hooks/useOnboarding';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { FirewallStep } from '../components/onboarding/FirewallStep';
import { SpeakerStep } from '../components/onboarding/SpeakerStep';
import { ExtensionStep } from '../components/onboarding/ExtensionStep';
import { ReadyStep } from '../components/onboarding/ReadyStep';
import styles from './Onboarding.module.css';

const STEP_KEYS = ['welcome', 'firewall', 'speakers', 'extension', 'ready'] as const;

/**
 * Main onboarding view for first-time users.
 * Guides through firewall, speaker discovery, and extension setup.
 *
 * @returns The rendered Onboarding view
 */
export function Onboarding(): preact.JSX.Element {
  const { t } = useTranslation();
  const { completeOnboarding, skipOnboarding } = useOnboarding();
  const [currentStep, setCurrentStep] = useState(0);
  const [speakersFound, setSpeakersFound] = useState(false);

  const totalSteps = STEP_KEYS.length;
  const isLastStep = currentStep === totalSteps - 1;

  const handleNext = useCallback(() => {
    if (isLastStep) {
      completeOnboarding();
    } else {
      setCurrentStep((prev) => Math.min(prev + 1, totalSteps - 1));
    }
  }, [isLastStep, completeOnboarding, totalSteps]);

  const handleBack = useCallback(() => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  }, []);

  const handleSkip = useCallback(() => {
    skipOnboarding();
  }, [skipOnboarding]);

  const handleSpeakersFound = useCallback((found: boolean) => {
    setSpeakersFound(found);
  }, []);

  // Determine if next should be disabled based on current step
  const isNextDisabled = currentStep === 2 && !speakersFound;

  const labels = {
    next: t('onboarding.next'),
    back: t('onboarding.back'),
    skip: t('onboarding.skip'),
    finish: t('onboarding.finish'),
  };

  const stepLabels = [
    t('onboarding.step_welcome'),
    t('onboarding.step_firewall'),
    t('onboarding.step_speakers'),
    t('onboarding.step_extension'),
    t('onboarding.step_ready'),
  ];

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return <WelcomeStep />;
      case 1:
        return <FirewallStep />;
      case 2:
        return <SpeakerStep onSpeakersFound={handleSpeakersFound} />;
      case 3:
        return <ExtensionStep />;
      case 4:
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
      >
        {renderStep()}
      </Wizard>
    </div>
  );
}
