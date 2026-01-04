import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import type { TabMediaState, ZoneGroup, SpeakerAvailability } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { Button, SpeakerMultiSelect, VolumeControl } from '@thaumic-cast/ui';
import { Cast, Loader2, Music } from 'lucide-preact';
import styles from './CurrentTabCard.module.css';

interface CurrentTabCardProps {
  /** The tab's media state */
  state: TabMediaState;
  /** Available speaker groups */
  groups: ZoneGroup[];
  /** Currently selected speaker IPs */
  selectedIps: string[];
  /** Callback when speaker selection changes */
  onSelectSpeakers: (ips: string[]) => void;
  /** Callback to start casting */
  onStartCast: () => void;
  /** Whether cast is starting */
  isStarting: boolean;
  /** Whether controls are disabled (loading, no connection, etc.) */
  disabled: boolean;
  /** Whether speakers are loading */
  speakersLoading: boolean;
  /** Current volume (0-100) - for primary selected speaker */
  volume: number;
  /** Whether primary selected speaker is muted */
  muted: boolean;
  /** Callback when volume changes */
  onVolumeChange: (volume: number) => void;
  /** Callback when mute is toggled */
  onMuteToggle: () => void;
  /** Whether volume controls should be shown */
  showVolumeControls: boolean;
  /** Function to get display name for a group */
  getGroupDisplayName: (group: ZoneGroup) => string;
  /** Availability status of the primary selected speaker */
  selectedAvailability: SpeakerAvailability;
}

/**
 * Displays the current tab's media information with cast controls.
 * @param props - Component props
 * @param props.state
 * @param props.groups
 * @param props.selectedIps
 * @param props.onSelectSpeakers
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
  selectedIps,
  onSelectSpeakers,
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
        {speakersLoading ? (
          <p className={styles.label}>{t('loading_speakers')}</p>
        ) : groups.length === 0 ? (
          <p className={styles.label}>{t('no_speakers_placeholder')}</p>
        ) : (
          <SpeakerMultiSelect
            groups={groups}
            selectedIps={selectedIps}
            onSelectionChange={onSelectSpeakers}
            disabled={disabled}
            getGroupDisplayName={getGroupDisplayName}
            label={t('target_speaker')}
          />
        )}

        {/* Volume Controls - always rendered to prevent layout shift */}
        <div
          className={styles.volumeWrapper}
          style={{
            visibility: showVolumeControls && selectedIps.length > 0 ? 'visible' : 'hidden',
          }}
          inert={!showVolumeControls || selectedIps.length === 0 ? true : undefined}
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
          disabled={disabled || selectedIps.length === 0}
          aria-describedby="cast-hint"
          aria-busy={isStarting}
          fullWidth
        >
          {isStarting ? (
            <>
              <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
              {t('starting')}
            </>
          ) : (
            <>
              <Cast size={16} aria-hidden="true" />
              {selectedIps.length > 1
                ? t('cast_to_n_speakers', { count: selectedIps.length })
                : t('start_casting')}
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
