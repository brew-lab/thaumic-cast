import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { useTranslation } from 'react-i18next';
import { Alert } from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
import {
  castingStreams,
  dismissSpeakerNotice,
  getHeadStart,
  groups,
  speakerNoticeDismissals,
  speakerNoticeReadings,
  type ZoneGroup,
} from '../state/store';
import {
  currentReadings,
  isNoticeDismissed,
  noticeOffersSettings,
  speakerNoticeLines,
} from '../lib/speaker-notices';
import styles from './SpeakerNotices.module.css';

const log = createLogger('SpeakerNotices');

/**
 * Names a speaker for a notice: its group's name when it leads the group,
 * else its room name, else its IP.
 * @param speakerIp - The speaker to name
 * @param zoneGroups - Current Sonos topology
 * @returns The best available display name
 */
function speakerName(speakerIp: string, zoneGroups: ZoneGroup[]): string {
  for (const group of zoneGroups) {
    if (group.coordinatorIp === speakerIp) return group.name;
    const member = group.members.find((m) => m.ip === speakerIp);
    if (member) return member.zoneName;
  }
  return speakerIp;
}

/**
 * The core's speaker notices for the speakers playing a stream, one card per
 * speaker, each dismissible. A head-start notice with a suggestion offers a
 * button to Settings > Speakers, where the head start is changed.
 * @returns The notice cards, or nothing when none stands
 */
export function SpeakerNotices() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const [headStartFixed, setHeadStartFixed] = useState(false);

  useEffect(() => {
    getHeadStart()
      .then((setting) => setHeadStartFixed(setting.envOverride !== null))
      .catch((error) => log.error('Failed to read the speaker head start setting:', error));
  }, []);

  const now = Date.now();
  const dismissals = speakerNoticeDismissals.value;
  // Only a reading about the stream the speaker plays now: a notice from an
  // earlier cast must not come back when the speaker starts a new one.
  const readings = currentReadings(speakerNoticeReadings.value, castingStreams.value);
  const cards = Object.entries(readings).flatMap(([speakerIp, reading]) => {
    const notice = reading.notice;
    if (!notice) return [];
    if (isNoticeDismissed(dismissals, reading.streamId, speakerIp, notice, now)) return [];
    const lines = speakerNoticeLines(notice, {
      speakerName: speakerName(speakerIp, groups.value),
      headStartFixed,
    });
    return [
      {
        speakerIp,
        offersSettings: noticeOffersSettings(notice, headStartFixed),
        message: lines.map((line) => t(line.key, line.params)).join(' '),
      },
    ];
  });

  if (cards.length === 0) return null;

  return (
    <div className={styles.notices}>
      {cards.map(({ speakerIp, offersSettings, message }) => (
        <Alert
          key={speakerIp}
          variant="warning"
          onDismiss={() => dismissSpeakerNotice(speakerIp)}
          dismissLabel={t('dashboard.speaker_notice_dismiss')}
          action={offersSettings ? t('dashboard.speaker_notice_open_settings') : undefined}
          onAction={offersSettings ? () => navigate('/settings#speakers') : undefined}
        >
          {message}
        </Alert>
      ))}
    </div>
  );
}
