import { useEffect } from 'preact/hooks';
import { stats, fetchStats, clearAllConnections, restartServer, stopAll } from '../state/store';
import {
  Button,
  Card,
  CopyField,
  DescriptionList,
  PageHeader,
  SettingsRow,
} from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import styles from './Server.module.css';

/**
 * Server management page.
 *
 * Displays server status, connection info, and provides controls for:
 * - Restarting the server
 * - Disconnecting all clients
 * - Stopping all streams
 * @returns The rendered Server page
 */
export function Server() {
  const { t } = useTranslation();

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
    <div className={styles.server}>
      <PageHeader title={t('nav.server')} />

      {/* Status Section */}
      <Card title={t('server.running')}>
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
      </Card>

      {/* Actions Section */}
      <Card title={t('server.actions')}>
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
              onAction={clearAllConnections}
              labels={{ busy: t('server.disconnecting') }}
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
              onAction={stopAll}
              labels={{ busy: t('server.stopping') }}
              aria-label={t('server.stop_streams')}
            >
              {t('server.stop')}
            </Button>
          }
        />
      </Card>
    </div>
  );
}
