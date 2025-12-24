import type { TabMediaState } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import styles from './CurrentTabCard.module.css';

interface CurrentTabCardProps {
  /** The tab's media state */
  state: TabMediaState;
}

/**
 * Displays the current tab's media information.
 * Pure presentation component - receives data, no business logic.
 * @param props - Component props
 * @param props.state - The tab's media state
 * @returns The rendered CurrentTabCard component
 */
export function CurrentTabCard({ state }: CurrentTabCardProps) {
  const title = getDisplayTitle(state);
  const image = getDisplayImage(state);
  const subtitle = getDisplaySubtitle(state);

  return (
    <div className={styles.card}>
      <div className={styles.artwork}>
        {image ? (
          <img src={image} alt="" className={styles.image} loading="lazy" />
        ) : (
          <div className={styles.placeholder} aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        )}
      </div>
      <div className={styles.info}>
        <p className={styles.title}>{title}</p>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
    </div>
  );
}
