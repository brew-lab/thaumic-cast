import { useEffect, useState } from 'preact/hooks';
import { WizardStep, Alert, StatusDot, Switch } from '@thaumic-cast/ui';
import { DEFAULT_MAX_CONCURRENT_STREAMS } from '@thaumic-cast/protocol';
import { useTranslation } from 'react-i18next';
import { groups, stats, getAutostartEnabled, setAutostartEnabled } from '../../state/store';
import styles from './ReadyStep.module.css';

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
  const [autostartEnabled, setAutostartState] = useState(true);

  useEffect(() => {
    getAutostartEnabled().then(setAutostartState);
  }, []);

  const handleAutostartChange = async (enabled: boolean) => {
    setAutostartState(enabled);
    await setAutostartEnabled(enabled);
  };

  return (
    <WizardStep
      title={t('onboarding.ready.title')}
      subtitle={t('onboarding.ready.subtitle')}
      glyph="check"
    >
      <p className={styles.introText}>
        {t('onboarding.ready.intro', {
          maxStreams: stats.value?.maxStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS,
        })}
      </p>

      <ul className={styles.summaryBox}>
        <li className={styles.summaryItem}>
          <StatusDot state="connected" size="md" />
          <span>{t('onboarding.ready.summary_app')}</span>
        </li>
        <li className={styles.summaryItem}>
          <StatusDot state="connected" size="md" />
          <span>{t('onboarding.ready.summary_speakers', { count: speakerCount })}</span>
        </li>
        <li className={styles.summaryItem}>
          <StatusDot state={connectionCount > 0 ? 'connected' : 'checking'} size="md" />
          <span>
            {connectionCount > 0
              ? t('onboarding.ready.summary_extension_connected')
              : t('onboarding.ready.summary_extension_pending')}
          </span>
        </li>
      </ul>

      <div className={styles.autostart}>
        <Switch
          label={t('onboarding.ready.autostart_label')}
          description={t('onboarding.ready.autostart_description')}
          checked={autostartEnabled}
          onChange={handleAutostartChange}
        />
      </div>

      <h3 className={styles.sectionTitle}>{t('onboarding.ready.performance_title')}</h3>
      <p className={styles.sectionBody}>{t('onboarding.ready.performance_body')}</p>

      <Alert variant="warning">{t('onboarding.ready.battery_warning')}</Alert>
    </WizardStep>
  );
}
