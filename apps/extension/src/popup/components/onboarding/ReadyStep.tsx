import { WizardStep } from '@thaumic-cast/ui';
import { Zap, Wifi } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import styles from './ReadyStep.module.css';

/**
 * Final onboarding step with performance tips.
 *
 * @returns The rendered ReadyStep component
 */
export function ReadyStep(): preact.JSX.Element {
  const { t } = useTranslation();

  return (
    <WizardStep
      title={t('onboarding.ready.title')}
      subtitle={t('onboarding.ready.subtitle')}
      icon={Zap}
    >
      <h3 className={styles.perfTitle}>{t('onboarding.ready.performance_title')}</h3>
      <p className={styles.perfBody}>{t('onboarding.ready.performance_body')}</p>

      <ul className={styles.tipList}>
        <li>
          <Wifi size={14} />
          {t('onboarding.ready.tip_1')}
        </li>
        <li>
          <Wifi size={14} />
          {t('onboarding.ready.tip_2')}
        </li>
        <li>
          <Wifi size={14} />
          {t('onboarding.ready.tip_3')}
        </li>
      </ul>
    </WizardStep>
  );
}
