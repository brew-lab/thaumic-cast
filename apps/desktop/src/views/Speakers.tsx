import { useEffect, useState } from 'preact/hooks';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Link } from 'wouter-preact';
import { Trans, useTranslation } from 'react-i18next';
import {
  groups,
  transportStates,
  castingSpeakers,
  castingCasts,
  castingStreams,
  networkHealth,
  fetchGroups,
  debouncedFetchGroups,
  refreshTopology,
  anythingCasting,
  showDiagnostics,
  speakerNoticeReadings,
  updateTransportState,
  updateNetworkHealth,
} from '../state/store';
import { type NetworkHealthPayload, type TransportStatePayload } from '../lib/events';
import { reserveMeter, roomCards } from '../lib/rooms';
import { currentReadings } from '../lib/speaker-notices';
import { ListenUrl } from '../components/ListenUrl';
import { SpeakerNotices } from '../components/SpeakerNotices';
import { StopAllDialog } from '../components/StopAllDialog';
import { Button, Card, EmptyState, Notice, PageHeader, RoomCard } from '@thaumic-cast/ui';
import styles from './Speakers.module.css';

/**
 * Speakers page (DESIGN.md L-desktop, C-roomcard): one read-only RoomCard per room, casting
 * rooms first. Ask again asks the network once more; Stop all casts, shown only while
 * something casts, asks first in a Dialog.
 * @returns The rendered Speakers page
 */
export function Speakers() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    // Initial fetch (immediate, no debounce)
    fetchGroups();

    // Listen for discovery-complete event (topology changes)
    // Uses debounced fetch since discovery may trigger multiple events
    listen('discovery-complete', () => {
      debouncedFetchGroups();
    }).then((fn) => unlisteners.push(fn));

    // Listen for network health changes (direct state update, no fetch needed)
    listen<NetworkHealthPayload>('network-health-changed', (event) => {
      updateNetworkHealth(event.payload.health, event.payload.reason);
    }).then((fn) => unlisteners.push(fn));

    // Listen for stream/playback events (casting status changes)
    // Uses debounced fetch to coalesce rapid bursts (e.g., multi-speaker start/stop)
    listen('stream-created', debouncedFetchGroups).then((fn) => unlisteners.push(fn));
    listen('stream-ended', debouncedFetchGroups).then((fn) => unlisteners.push(fn));
    listen('playback-started', debouncedFetchGroups).then((fn) => unlisteners.push(fn));
    listen('playback-stopped', debouncedFetchGroups).then((fn) => unlisteners.push(fn));

    // Listen for transport state changes (direct state update, no fetch needed)
    listen<TransportStatePayload>('transport-state-changed', (event) => {
      updateTransportState(event.payload.speakerIp, event.payload.state);
    }).then((fn) => unlisteners.push(fn));

    // Fallback polling at longer interval (30s) for any missed events
    const interval = setInterval(fetchGroups, 30000);

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
      clearInterval(interval);
    };
  }, []);

  const cards = roomCards(groups.value, castingSpeakers.value, transportStates.value);
  const readings = currentReadings(speakerNoticeReadings.value, castingStreams.value);

  return (
    <>
      <PageHeader
        title={t('nav.speakers')}
        summary={t('speakers.summary', {
          rooms: t('speakers.summary_rooms', { count: cards.length }),
          streams: t('speakers.summary_streaming', {
            count: cards.filter((c) => c.casting).length,
          }),
        })}
        actions={
          <>
            <Button
              size="md"
              icon="refresh"
              onAction={refreshTopology}
              labels={{ busy: t('speakers.scanning') }}
            >
              {t('speakers.scan')}
            </Button>
            {anythingCasting.value && (
              <Button
                size="md"
                kind="filled"
                danger
                icon="stop"
                onClick={() => setConfirming(true)}
              >
                {t('speakers.stop_all')}
              </Button>
            )}
          </>
        }
      />

      {networkHealth.value.health === 'degraded' && (
        <Notice
          tone="warning"
          text={t(`network.${networkHealth.value.reason}`, {
            defaultValue: t('network.speakers_not_responding'),
          })}
        />
      )}

      <SpeakerNotices />

      {cards.length === 0 ? (
        <Card>
          <EmptyState
            body={`${t('speakers.none')} ${t('speakers.scan_hint')}`}
            link={
              <Trans
                i18nKey="speakers.manual_add_hint"
                components={[<Link key={0} href="/settings#speakers" />]}
              />
            }
          />
        </Card>
      ) : (
        <div className={styles.grid}>
          {cards.map(({ room, model, casting, badge }) => {
            const cast = castingCasts.value[room.ip];
            const meter = showDiagnostics.value && casting ? reserveMeter(readings[room.ip]) : null;
            return (
              <RoomCard
                key={room.id}
                name={room.name}
                sub={
                  room.groupedWith.length > 0
                    ? t('device.grouped_with', { names: room.groupedWith.join(', ') })
                    : [model, room.ip].filter(Boolean).join(' · ')
                }
                badge={badge && { tone: badge.tone, label: t(badge.key) }}
                copy={cast && <ListenUrl cast={cast} />}
                meter={
                  meter && {
                    name: t('device.reserve'),
                    label: t('device.reserve_label', { name: room.name }),
                    value: meter.value,
                    max: meter.max,
                    low: meter.low,
                    valueText: t('device.reserve_ms', { value: meter.value }),
                  }
                }
              />
            );
          })}
        </div>
      )}

      <StopAllDialog open={confirming} onClose={() => setConfirming(false)} />
    </>
  );
}
