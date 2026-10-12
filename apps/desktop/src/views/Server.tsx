import { useEffect, useState } from 'preact/hooks';
import { stats, fetchStats, clearAllConnections, restartServer, stopAll } from '../state/store';
import { Button, Card, IconButton } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import styles from './Server.module.css';

/** Duration to show "copied" feedback before reverting to copy icon (ms). */
const COPIED_FEEDBACK_DURATION_MS = 2000;

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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  const copyAddress = () => {
    if (stats.value) {
      const url = `http://${stats.value.localIp}:${stats.value.port}`;
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_DURATION_MS);
    }
  };

  return (
    <div className={styles.server}>
      <h2 className={styles.pageTitle}>{t('nav.server')}</h2>

      {/* Status Section */}
      <Card
        title={t('server.running')}
        titleLevel="h3"
        className={`${styles.section} ${styles.statusCard}`}
      >
        <dl className={styles.statusGrid}>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>{t('server.address')}</dt>
            <dd className={styles.addressRow}>
              <code className={styles.statusValue}>
                {stats.value ? `${stats.value.localIp}:${stats.value.port}` : '---'}
              </code>
              <IconButton
                glyph={copied ? 'check' : 'copy'}
                label={t('server.copy_address')}
                tooltip
                onPress={copyAddress}
              />
            </dd>
          </div>

          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>{t('server.clients')}</dt>
            <dd className={styles.statusValue}>{stats.value?.connectionCount ?? 0}</dd>
          </div>

          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>{t('server.streams')}</dt>
            <dd className={styles.statusValue}>{stats.value?.streamCount ?? 0}</dd>
          </div>
        </dl>
      </Card>

      {/* Actions Section */}
      <Card title={t('server.actions')} titleLevel="h3" className={styles.section}>
        <div className={styles.actionList}>
          <div className={styles.actionRow}>
            <div className={styles.actionInfo}>
              <h4 className={styles.actionTitle}>{t('server.restart')}</h4>
              <p className={styles.actionDescription}>{t('server.restart_description')}</p>
            </div>
            <Button
              icon="refresh"
              onAction={restartServer}
              labels={{ busy: t('server.restarting') }}
            >
              {t('server.restart')}
            </Button>
          </div>

          <div className={styles.actionRow}>
            <div className={styles.actionInfo}>
              <h4 className={styles.actionTitle}>{t('server.disconnect_all')}</h4>
              <p className={styles.actionDescription}>{t('server.disconnect_description')}</p>
            </div>
            <Button
              kind="outline"
              onAction={clearAllConnections}
              labels={{ busy: t('server.disconnecting') }}
            >
              {t('server.disconnect')}
            </Button>
          </div>

          <div className={styles.actionRow}>
            <div className={styles.actionInfo}>
              <h4 className={styles.actionTitle}>{t('server.stop_streams')}</h4>
              <p className={styles.actionDescription}>{t('server.stop_streams_description')}</p>
            </div>
            <Button
              kind="filled"
              danger
              icon="stop"
              onAction={stopAll}
              labels={{ busy: t('server.stopping') }}
            >
              {t('server.stop')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
