import { useEffect, useState } from 'preact/hooks';
import { WizardStep, Card, DescriptionList, Notice, Switch } from '@thaumic-cast/ui';
import { DEFAULT_MAX_CONCURRENT_STREAMS } from '@thaumic-cast/protocol';
import { useTranslation } from 'react-i18next';
import { roomsOf } from '@thaumic-cast/protocol';
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
  const roomCount = roomsOf(groups.value).length;
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

      <Card>
        <DescriptionList
          kind="checklist"
          rows={[
            { key: 'app', state: 'connected', text: t('onboarding.ready.summary_app') },
            {
              key: 'rooms',
              state: 'connected',
              text: t('onboarding.ready.summary_rooms', { count: roomCount }),
            },
            {
              key: 'extension',
              state: connectionCount > 0 ? 'connected' : 'checking',
              text:
                connectionCount > 0
                  ? t('onboarding.ready.summary_extension_connected')
                  : t('onboarding.ready.summary_extension_pending'),
            },
          ]}
        />
      </Card>

      <Card>
        <Switch
          label={t('onboarding.ready.autostart_label')}
          description={t('onboarding.ready.autostart_description')}
          checked={autostartEnabled}
          onChange={handleAutostartChange}
        />
      </Card>

      <Card title={t('onboarding.ready.performance_title')} level={3}>
        <p className={styles.sectionBody}>{t('onboarding.ready.performance_body')}</p>
      </Card>

      <Notice tone="warning" text={t('onboarding.ready.battery_warning')} />
    </WizardStep>
  );
}
