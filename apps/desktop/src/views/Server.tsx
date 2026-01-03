import { useEffect, useState } from 'preact/hooks';
import { stats, fetchStats, clearAllConnections, restartServer, stopAll } from '../state/store';
import { Button, Card } from '@thaumic-cast/ui';
import { ActionButton } from '../components/ActionButton';
import { useTranslation } from 'react-i18next';
import { Copy, Check, RefreshCcw, Unplug, Square, Circle } from 'lucide-preact';
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
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={styles.server}>
      <h2 className={styles.title}>{t('nav.server')}</h2>

      {/* Status Section */}
      <Card noPadding className={styles.section}>
        <div className={styles.statusHeader}>
          <div className={styles.statusIndicator}>
            <Circle size={10} fill="var(--color-success)" color="var(--color-success)" />
            <span>{t('server.running')}</span>
          </div>
        </div>

        <div className={styles.statusGrid}>
          <div className={styles.statusItem}>
            <span className={styles.statusLabel}>{t('server.address')}</span>
            <div className={styles.addressRow}>
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
            </div>
          </div>

          <div className={styles.statusItem}>
            <span className={styles.statusLabel}>{t('server.clients')}</span>
            <span className={styles.statusValue}>{stats.value?.connectionCount ?? 0}</span>
          </div>

          <div className={styles.statusItem}>
            <span className={styles.statusLabel}>{t('server.streams')}</span>
            <span className={styles.statusValue}>{stats.value?.streamCount ?? 0}</span>
          </div>
        </div>
      </Card>

      {/* Actions Section */}
      <Card noPadding className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('server.actions')}</h3>

        <div className={styles.actionList}>
          <div className={styles.actionRow}>
            <div className={styles.actionInfo}>
              <span className={styles.actionTitle}>{t('server.restart')}</span>
              <span className={styles.actionDescription}>{t('server.restart_description')}</span>
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
              <span className={styles.actionTitle}>{t('server.disconnect_all')}</span>
              <span className={styles.actionDescription}>{t('server.disconnect_description')}</span>
            </div>
            <ActionButton
              action={async () => {
                await clearAllConnections();
              }}
              label={t('server.disconnect')}
              loadingLabel={t('server.disconnecting')}
              icon={Unplug}
              variant="danger"
              className={styles.actionButton}
            />
          </div>

          <div className={styles.actionRow}>
            <div className={styles.actionInfo}>
              <span className={styles.actionTitle}>{t('server.stop_streams')}</span>
              <span className={styles.actionDescription}>
                {t('server.stop_streams_description')}
              </span>
            </div>
            <ActionButton
              action={stopAll}
              label={t('server.stop')}
              loadingLabel={t('server.stopping')}
              icon={Square}
              variant="danger"
              className={styles.actionButton}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
