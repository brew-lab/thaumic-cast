import type { JSX } from 'preact';
import { NoticeLine } from '@thaumic-cast/ui';
import type { AwayEvent } from '../../lib/away-events';
import type { PopupWords } from '../hooks/useWords';
import styles from './AwayLine.module.css';

/** The lead each kind of away event is named by (the toolbar badge names them the same). */
const LEADS: Record<AwayEvent['kind'], string> = {
  cast_ended: 'cast_ended',
  speaker_left: 'room_left_cast',
  connection_lost: 'notice_lead_connection_lost',
  stop_failed: 'room_still_playing',
  join_failed: 'room_join_failed',
};

/** Props for {@link AwayLine}. */
export interface AwayLineProps {
  /** The unseen events, newest first. */
  events: AwayEvent[];
  /** X: the line goes for this popup session. */
  onDismiss: () => void;
  /** The words. */
  words: PopupWords;
}

/**
 * "While you were away" in one line (DESIGN.md P-away): the newest event's
 * lead, with the `history` glyph standing for the words, which are spoken.
 * "{{count}} more" (Details for one event) opens every event in place, newest
 * first: its time, its lead and the shipped sentence.
 * @param props - Component props
 * @param props.events - The events
 * @param props.onDismiss - Dismisses the line
 * @param props.words - The words
 * @returns The line, or nothing
 */
export function AwayLine({ events, onDismiss, words }: AwayLineProps): JSX.Element | null {
  const { t } = words;
  const [newest] = events;
  if (!newest) return null;
  const lead = (event: AwayEvent): string => t(LEADS[event.kind], { name: event.subject });
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const prefix = t('away_line', { lead: '' }).trim();
  return (
    <NoticeLine
      tone="info"
      glyph="history"
      srPrefix={prefix}
      lead={lead(newest)}
      details={{
        label: events.length > 1 ? t('away_more', { count: events.length - 1 }) : t('details'),
        content: (
          <ul className={styles.events}>
            {events.map((event) => (
              <li key={event.id}>
                <time className={`num ${styles.time}`} dateTime={new Date(event.at).toISOString()}>
                  {time.format(event.at)}
                </time>{' '}
                <strong>{lead(event)}</strong>
                {event.key && ` ${t(event.key, event.params)}`}
              </li>
            ))}
          </ul>
        ),
      }}
      onDismiss={onDismiss}
      dismissLabel={t('dismiss')}
    />
  );
}
