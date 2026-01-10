import { useEffect, useState } from 'preact/hooks';
import { WizardStep, Alert } from '@thaumic-cast/ui';
import { Zap, Check, Timer } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { groups, stats, getAutostartEnabled, setAutostartEnabled } from '../../state/store';
import styles from './ReadyStep.module.css';

/** Maximum concurrent streams allowed (matches backend constant) */
const MAX_STREAMS = 10;

/**
 * Final onboarding step confirming setup is complete.
 * Shows summary, performance expectations, and autostart toggle.
 *
 * @returns The rendered ReadyStep component
 */
export function ReadyStep(): preact.JSX.Element {
  const { t } = useTranslation();
  const speakerCount = groups.value.length;
  const connectionCount = stats.value?.connectionCount ?? 0;
  const extensionStatus = connectionCount > 0 ? 'Connected' : 'Pending';
  const [autostartEnabled, setAutostartState] = useState(true);

  useEffect(() => {
    getAutostartEnabled().then(setAutostartState);
  }, []);

  const handleAutostartChange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const enabled = target.checked;
    setAutostartState(enabled);
    await setAutostartEnabled(enabled);
  };

  return (
    <WizardStep
      title={t('onboarding.ready.title')}
      subtitle={t('onboarding.ready.subtitle')}
      icon={Zap}
    >
      <div className={styles['summary-box']}>
        <div className={styles['summary-item']}>
          <Check size={16} className={styles['check-icon']} />
          <span>Desktop App: Running</span>
        </div>
        <div className={styles['summary-item']}>
          <Check size={16} className={styles['check-icon']} />
          <span>Speakers: {speakerCount} found</span>
        </div>
        <div className={styles['summary-item']}>
          {connectionCount > 0 ? (
            <Check size={16} className={styles['check-icon']} />
          ) : (
            <Timer size={16} className={styles['pending-icon']} />
          )}
          <span>Extension: {extensionStatus}</span>
        </div>
      </div>

      <p className={styles['intro-text']}>
        {t('onboarding.ready.intro', { maxStreams: MAX_STREAMS })}
      </p>

      <h3 className={styles['section-title']}>{t('onboarding.ready.performance_title')}</h3>
      <p className={styles['section-body']}>{t('onboarding.ready.performance_body')}</p>

      <Alert variant="warning">{t('onboarding.ready.battery_warning')}</Alert>

      <label className={styles['autostart-toggle']}>
        <input type="checkbox" checked={autostartEnabled} onChange={handleAutostartChange} />
        <div className={styles['autostart-content']}>
          <span className={styles['autostart-label']}>{t('onboarding.ready.autostart_label')}</span>
          <span className={styles['autostart-description']}>
            {t('onboarding.ready.autostart_description')}
          </span>
        </div>
      </label>
    </WizardStep>
  );
}
