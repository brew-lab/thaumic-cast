import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import type { TabMediaState, ZoneGroup } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { Button } from '@thaumic-cast/ui';
import { Cast, Loader2, Music, Volume2, VolumeX } from 'lucide-preact';
import styles from './CurrentTabCard.module.css';

interface CurrentTabCardProps {
  /** The tab's media state */
  state: TabMediaState;
  /** Available speaker groups */
  groups: ZoneGroup[];
  /** Currently selected speaker IP */
  selectedIp: string;
  /** Callback when speaker selection changes */
  onSelectSpeaker: (ip: string) => void;
  /** Callback to start casting */
  onStartCast: () => void;
  /** Whether cast is starting */
  isStarting: boolean;
  /** Whether controls are disabled (loading, no connection, etc.) */
  disabled: boolean;
  /** Whether speakers are loading */
  speakersLoading: boolean;
  /** Current volume (0-100) */
  volume: number;
  /** Whether speaker is muted */
  muted: boolean;
  /** Callback when volume changes */
  onVolumeChange: (volume: number) => void;
  /** Callback when mute is toggled */
  onMuteToggle: () => void;
  /** Whether volume controls should be shown */
  showVolumeControls: boolean;
  /** Function to get display name for a group */
  getGroupDisplayName: (group: ZoneGroup) => string;
}

/**
 * Displays the current tab's media information with cast controls.
 * @param props - Component props
 * @param props.state
 * @param props.groups
 * @param props.selectedIp
 * @param props.onSelectSpeaker
 * @param props.onStartCast
 * @param props.isStarting
 * @param props.disabled
 * @param props.speakersLoading
 * @param props.volume
 * @param props.muted
 * @param props.onVolumeChange
 * @param props.onMuteToggle
 * @param props.showVolumeControls
 * @param props.getGroupDisplayName
 * @returns The rendered CurrentTabCard component
 */
export function CurrentTabCard({
  state,
  groups,
  selectedIp,
  onSelectSpeaker,
  onStartCast,
  isStarting,
  disabled,
  speakersLoading,
  volume,
  muted,
  onVolumeChange,
  onMuteToggle,
  showVolumeControls,
  getGroupDisplayName,
}: CurrentTabCardProps): JSX.Element {
  const { t } = useTranslation();
  const title = getDisplayTitle(state);
  const image = getDisplayImage(state);
  const subtitle = getDisplaySubtitle(state);

  return (
    <div className={styles.card}>
      <div className={styles.mediaRow}>
        <div className={styles.artwork}>
          {image ? (
            <img src={image} alt="" className={styles.image} loading="lazy" />
          ) : (
            <div className={styles.placeholder} aria-hidden="true">
              <Music size={24} />
            </div>
          )}
        </div>
        <div className={styles.info}>
          <p className={styles.title}>{title}</p>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
      </div>

      <div className={styles.controls}>
        {/* Speaker Selection */}
        <div className={styles.field}>
          <label className={styles.label}>{t('target_speaker')}</label>
          <select
            value={selectedIp}
            onChange={(e) => onSelectSpeaker((e.target as HTMLSelectElement).value)}
            className={styles.select}
            disabled={disabled}
          >
            {speakersLoading ? <option>{t('loading_speakers')}</option> : null}
            {groups.map((g) => (
              <option key={g.id} value={g.coordinatorIp}>
                {getGroupDisplayName(g)}
              </option>
            ))}
            {!speakersLoading && groups.length === 0 && (
              <option value="">{t('no_speakers_found')}</option>
            )}
          </select>
        </div>

        {/* Volume Controls */}
        {showVolumeControls && selectedIp && (
          <div className={styles.volumeControl}>
            <div className={styles.volumeHeader}>
              <label className={styles.label}>{t('volume')}</label>
              <button
                type="button"
                className={`${styles.muteButton} ${muted ? styles.muted : ''}`}
                onClick={onMuteToggle}
                title={muted ? t('unmute') : t('mute')}
              >
                {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => onVolumeChange(parseInt((e.target as HTMLInputElement).value, 10))}
              className={styles.volumeSlider}
              disabled={muted}
            />
            <span className={styles.volumeValue}>{volume}</span>
          </div>
        )}

        {/* Cast Button */}
        <Button onClick={onStartCast} disabled={disabled || groups.length === 0}>
          {isStarting ? (
            <>
              <Loader2 size={16} className={styles.spinner} />
              {t('starting')}
            </>
          ) : (
            <>
              <Cast size={16} />
              {t('start_casting')}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
