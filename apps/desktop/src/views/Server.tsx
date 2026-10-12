import { useEffect, useState } from 'preact/hooks';
import {
  stats,
  fetchStats,
  clearAllConnections,
  restartServer,
  anythingCasting,
} from '../state/store';
import {
  Button,
  CopyField,
  DescriptionList,
  Dialog,
  PageHeader,
  SettingsRow,
  SettingsSection,
} from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { StopAllDialog } from '../components/StopAllDialog';

/**
 * Server management page (DESIGN.md L-desktop): the address and the counts, then the three
 * server-wide actions, whose Buttons share one width. Disconnect and Stop ask first in a
 * Dialog; Stop is disabled while nothing casts, as in the tray.
 * @returns The rendered Server page
 */
export function Server() {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState<'disconnect' | 'stop' | null>(null);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  const address = stats.value ? `${stats.value.localIp}:${stats.value.port}` : undefined;

  /**
   * The address with its scheme, as copied: what a browser or a player can open.
   * @returns The address, or nothing while it is not known
   */
  const copyValue = async (): Promise<string> =>
    stats.value ? `http://${stats.value.localIp}:${stats.value.port}` : '';

  return (
    <>
      <PageHeader title={t('nav.server')} />

      <SettingsSection title={t('server.running')}>
        <DescriptionList
          kind="stat"
          rows={[
            {
              key: 'address',
              term: t('server.address'),
              value: (
                <CopyField
                  value={address}
                  getValue={address ? copyValue : undefined}
                  action={t('server.copy_address')}
                  done={t('device.listen_url_copied')}
                  refusedNote={t('device.listen_url_copy_failed')}
                  unavailableNote={t('device.listen_url_unavailable')}
                />
              ),
            },
            {
              key: 'clients',
              term: t('server.clients'),
              value: stats.value?.connectionCount ?? 0,
              count: true,
            },
            {
              key: 'streams',
              term: t('server.streams'),
              value: stats.value?.streamCount ?? 0,
              count: true,
            },
          ]}
        />
      </SettingsSection>

      <SettingsSection title={t('server.actions')}>
        <SettingsRow
          label={t('server.restart')}
          help={t('server.restart_description')}
          controlWidth="action"
          control={
            <Button
              icon="refresh"
              onAction={restartServer}
              labels={{ busy: t('server.restarting') }}
            >
              {t('server.restart')}
            </Button>
          }
        />
        <SettingsRow
          label={t('server.disconnect_all')}
          help={t('server.disconnect_description')}
          controlWidth="action"
          control={
            <Button
              kind="outline"
              onClick={() => setConfirm('disconnect')}
              aria-label={t('server.disconnect_all')}
            >
              {t('server.disconnect')}
            </Button>
          }
        />
        <SettingsRow
          label={t('server.stop_streams')}
          help={t('server.stop_streams_description')}
          controlWidth="action"
          control={
            <Button
              kind="filled"
              danger
              icon="stop"
              disabled={!anythingCasting.value}
              onClick={() => setConfirm('stop')}
              aria-label={t('server.stop_streams')}
            >
              {t('server.stop')}
            </Button>
          }
        />
      </SettingsSection>

      <Dialog
        open={confirm === 'disconnect'}
        title={t('server.disconnect_all')}
        description={t('server.disconnect_description')}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirm={{
          label: t('server.disconnect'),
          busy: t('server.disconnecting'),
          onAction: clearAllConnections,
        }}
        onClose={() => setConfirm(null)}
      />
      <StopAllDialog open={confirm === 'stop'} onClose={() => setConfirm(null)} />
    </>
  );
}
