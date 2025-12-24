import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState } from '@thaumic-cast/protocol';
import { ActiveCastCard } from './ActiveCastCard';
import styles from './ActiveCastsList.module.css';

interface ActiveCastsListProps {
  /** Array of active cast sessions */
  casts: ActiveCast[];
  /** Function to get transport state for a speaker IP */
  getTransportState?: (speakerIp: string) => TransportState | undefined;
  /** Callback when a cast stop is requested */
  onStopCast: (tabId: number) => void;
}

/**
 * List of active cast sessions.
 * Pure container - maps data to cards.
 * @param props - Component props
 * @param props.casts - Array of active cast sessions
 * @param props.getTransportState - Function to get transport state by speaker IP
 * @param props.onStopCast - Callback when a cast stop is requested
 * @returns The rendered ActiveCastsList component or null if empty
 */
export function ActiveCastsList({ casts, getTransportState, onStopCast }: ActiveCastsListProps) {
  const { t } = useTranslation();

  if (casts.length === 0) return null;

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{t('active_casts')}</h2>
      <ul className={styles.list}>
        {casts.map((cast) => (
          <li key={cast.tabId} className={styles.item}>
            <ActiveCastCard
              cast={cast}
              transportState={getTransportState?.(cast.speakerIp)}
              onStop={() => onStopCast(cast.tabId)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
