import { useEffect, useState } from 'preact/hooks';
import { stats, fetchStats, clearAllConnections, restartServer, stopAll } from '../state/store';
import { ActionButton, Button, Card } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { Copy, Check, RefreshCcw, Unplug, Square, Circle } from 'lucide-preact';
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
        icon={Circle}
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
              <Button
                variant="secondary"
                onClick={copyAddress}
                className={styles.copyButton}
                title={t('server.copy_address')}
              >
                {copied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
              </Button>
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
            <ActionButton
              action={restartServer}
              label={t('server.restart')}
              loadingLabel={t('server.restarting')}
              successLabel={t('server.restarting')}
              icon={RefreshCcw}
              variant="secondary"
              className={styles.actionButton}
            />
          </div>

          <div className={styles.actionRow}>
            <div className={styles.actionInfo}>
              <h4 className={styles.actionTitle}>{t('server.disconnect_all')}</h4>
              <p className={styles.actionDescription}>{t('server.disconnect_description')}</p>
            </div>
            <ActionButton
              action={async () => {
                await clearAllConnections();
              }}
              label={t('server.disconnect')}
              loadingLabel={t('server.disconnecting')}
              icon={Unplug}
              variant="primary"
              className={styles.actionButton}
            />
          </div>

          <div className={styles.actionRow}>
            <div className={styles.actionInfo}>
              <h4 className={styles.actionTitle}>{t('server.stop_streams')}</h4>
              <p className={styles.actionDescription}>{t('server.stop_streams_description')}</p>
            </div>
            <ActionButton
              action={stopAll}
              label={t('server.stop')}
              loadingLabel={t('server.stopping')}
              icon={Square}
              variant="primary"
              className={styles.actionButton}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
