import { WizardStep } from '@thaumic-cast/ui';
import { Zap, Check, Wifi, Timer } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { groups, stats } from '../../state/store';
import styles from './ReadyStep.module.css';

/**
 * Final onboarding step confirming setup is complete.
 * Shows summary and performance expectations.
 *
 * @returns The rendered ReadyStep component
 */
export function ReadyStep(): preact.JSX.Element {
  const { t } = useTranslation();
  const speakerCount = groups.value.length;
  const connectionCount = stats.value?.connectionCount ?? 0;
  const extensionStatus = connectionCount > 0 ? 'Connected' : 'Pending';

  return (
    <WizardStep
      title={t('onboarding.ready.title')}
      subtitle={t('onboarding.ready.subtitle')}
      icon={Zap}
    >
      <div className={styles.summaryBox}>
        <div className={styles.summaryItem}>
          <Check size={16} className={styles.checkIcon} />
          <span>Desktop App: Running</span>
        </div>
        <div className={styles.summaryItem}>
          <Check size={16} className={styles.checkIcon} />
          <span>Speakers: {speakerCount} found</span>
        </div>
        <div className={styles.summaryItem}>
          {connectionCount > 0 ? (
            <Check size={16} className={styles.checkIcon} />
          ) : (
            <Timer size={16} className={styles.pendingIcon} />
          )}
          <span>Extension: {extensionStatus}</span>
        </div>
      </div>

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
