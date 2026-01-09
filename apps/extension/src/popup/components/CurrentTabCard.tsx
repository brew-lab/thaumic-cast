import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import type { TabMediaState, SpeakerAvailability } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplaySubtitle } from '@thaumic-cast/protocol';
import {
  ActionButton,
  SpeakerMultiSelect,
  SpeakerVolumeRow,
  Card,
  type SpeakerGroupLike,
} from '@thaumic-cast/ui';
import { Cast, Music } from 'lucide-preact';
import styles from './CurrentTabCard.module.css';

interface CurrentTabCardProps<T extends SpeakerGroupLike> {
  /** The tab's media state */
  state: TabMediaState;
  /** Available speaker groups (sorted) */
  groups: readonly T[];
  /** Currently selected speaker IPs */
  selectedIps: string[];
  /** Callback when speaker selection changes */
  onSelectSpeakers: (ips: string[]) => void;
  /** Async callback to start casting */
  onStartCast: () => Promise<void>;
  /** Whether controls are disabled (loading, no connection, etc.) */
  disabled: boolean;
  /** Whether speakers are loading */
  speakersLoading: boolean;
  /** Function to get volume for a speaker IP */
  getVolume: (speakerIp: string) => number;
  /** Function to check if a speaker is muted */
  isMuted: (speakerIp: string) => boolean;
  /** Callback when volume changes for a speaker */
  onVolumeChange: (speakerIp: string, volume: number) => void;
  /** Callback when mute is toggled for a speaker */
  onMuteToggle: (speakerIp: string) => void;
  /** Whether volume controls should be shown */
  showVolumeControls: boolean;
  /** Function to get display name for a group */
  getGroupDisplayName: (group: T) => string;
  /** Function to get speaker name by IP */
  getSpeakerName: (speakerIp: string) => string;
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
 * @param props.disabled
 * @param props.speakersLoading
 * @param props.getVolume
 * @param props.isMuted
 * @param props.onVolumeChange
 * @param props.onMuteToggle
 * @param props.showVolumeControls
 * @param props.getGroupDisplayName
 * @param props.getSpeakerName
 * @param props.selectedAvailability
 * @returns The rendered CurrentTabCard component
 */
export function CurrentTabCard<T extends SpeakerGroupLike>({
  state,
  groups,
  selectedIps,
  onSelectSpeakers,
  onStartCast,
  disabled,
  speakersLoading,
  getVolume,
  isMuted,
  onVolumeChange,
  onMuteToggle,
  showVolumeControls,
  getGroupDisplayName,
  getSpeakerName,
  selectedAvailability,
}: CurrentTabCardProps<T>): JSX.Element {
  const { t } = useTranslation();
  const title = getDisplayTitle(state);
  // Use metadata artwork if available, otherwise favicon (skip og:image)
  const image = state.metadata?.artwork || state.tabFavicon;
  const subtitle = getDisplaySubtitle(state);

  return (
    <Card noPadding className={styles.card}>
      <div className={styles.cardInner}>
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

          {/* Per-speaker Volume Controls */}
          {showVolumeControls && selectedIps.length > 0 && (
            <div className={styles.speakerRows}>
              {selectedIps.map((ip) => (
                <SpeakerVolumeRow
                  key={ip}
                  speakerName={getSpeakerName(ip)}
                  speakerIp={ip}
                  volume={getVolume(ip)}
                  muted={isMuted(ip)}
                  onVolumeChange={(vol) => onVolumeChange(ip, vol)}
                  onMuteToggle={() => onMuteToggle(ip)}
                  muteLabel={t('mute')}
                  unmuteLabel={t('unmute')}
                  volumeLabel={t('volume')}
                />
              ))}
            </div>
          )}

          {/* Cast Button */}
          <ActionButton
            action={onStartCast}
            label={
              selectedIps.length > 1
                ? t('cast_to_n_speakers', { count: selectedIps.length })
                : t('start_casting')
            }
            loadingLabel={t('starting')}
            errorLabel={t('cast_failed')}
            icon={Cast}
            disabled={disabled || selectedIps.length === 0}
            aria-describedby="cast-hint"
            fullWidth
          />

          {/* Hint text - reserved space prevents layout shift */}
          <p id="cast-hint" className={styles.castHint} aria-live="polite">
            {selectedAvailability === 'in_use' && t('hint_replace_source')}
            {selectedAvailability === 'casting' && t('hint_replace_cast')}
          </p>
        </div>
      </div>
    </Card>
  );
}
