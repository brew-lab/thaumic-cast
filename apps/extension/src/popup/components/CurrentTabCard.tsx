import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import type { TabMediaState, ZoneGroup, SpeakerAvailability } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { Button, VolumeControl } from '@thaumic-cast/ui';
import { Cast, Loader2, Music } from 'lucide-preact';
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
  /** Availability status of the selected speaker */
  selectedAvailability: SpeakerAvailability;
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
 * @param props.selectedAvailability
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
  selectedAvailability,
}: CurrentTabCardProps): JSX.Element {
  const { t } = useTranslation();
  const title = getDisplayTitle(state);
  // Use metadata artwork if available, otherwise favicon (skip og:image)
  const image = state.metadata?.artwork || state.tabFavicon;
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
          <label htmlFor="speaker-select" className={styles.label}>
            {t('target_speaker')}
          </label>
          <select
            id="speaker-select"
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

        {/* Volume Controls - always rendered to prevent layout shift */}
        <div
          className={styles.volumeWrapper}
          style={{ visibility: showVolumeControls && selectedIp ? 'visible' : 'hidden' }}
          inert={!showVolumeControls || !selectedIp ? true : undefined}
        >
          <VolumeControl
            volume={volume}
            muted={muted}
            onVolumeChange={onVolumeChange}
            onMuteToggle={onMuteToggle}
            muteLabel={t('mute')}
            unmuteLabel={t('unmute')}
            volumeLabel={t('volume')}
          />
        </div>

        {/* Cast Button */}
        <Button
          onClick={onStartCast}
          disabled={disabled || groups.length === 0}
          aria-describedby="cast-hint"
          aria-busy={isStarting}
        >
          {isStarting ? (
            <>
              <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
              {t('starting')}
            </>
          ) : (
            <>
              <Cast size={16} aria-hidden="true" />
              {t('start_casting')}
            </>
          )}
        </Button>

        {/* Hint text - reserved space prevents layout shift */}
        <p id="cast-hint" className={styles.castHint} aria-live="polite">
          {selectedAvailability === 'in_use' && t('hint_replace_source')}
          {selectedAvailability === 'casting' && t('hint_replace_cast')}
        </p>
      </div>
    </div>
  );
}
