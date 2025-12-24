import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { TransportIcon } from './TransportIcon';
import styles from './ActiveCastCard.module.css';

interface ActiveCastCardProps {
  /** The active cast session */
  cast: ActiveCast;
  /** Transport state for the target speaker */
  transportState?: TransportState;
  /** Callback when stop button is clicked */
  onStop: () => void;
}

/**
 * Displays an active cast session with stop button.
 * Pure presentation component - receives data, emits events.
 * @param props - Component props
 * @param props.cast - Active cast session data
 * @param props.transportState - Transport state for the target speaker
 * @param props.onStop - Callback when stop button is clicked
 * @returns The rendered ActiveCastCard component
 */
export function ActiveCastCard({ cast, transportState, onStop }: ActiveCastCardProps) {
  const { t } = useTranslation();

  const title = getDisplayTitle(cast.mediaState);
  const image = getDisplayImage(cast.mediaState);
  const subtitle = getDisplaySubtitle(cast.mediaState);

  return (
    <div className={styles.card}>
      <div className={styles.artwork}>
        {image ? (
          <img src={image} alt="" className={styles.image} loading="lazy" />
        ) : (
          <div className={styles.placeholder} aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        )}
        {transportState && (
          <div className={styles.transportOverlay}>
            <TransportIcon state={transportState} size={18} />
          </div>
        )}
      </div>

      <div className={styles.info}>
        <p className={styles.title}>{title}</p>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        <p className={styles.speaker}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={styles.speakerIcon}
          >
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
          {cast.speakerName || cast.speakerIp}
        </p>
      </div>

      <button
        type="button"
        className={styles.stopButton}
        onClick={onStop}
        aria-label={t('stop_cast')}
        title={t('stop_cast')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
    </div>
  );
}
