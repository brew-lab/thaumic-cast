/**
 * Toolbar Badge Runner
 *
 * Keeps the toolbar badge and icon in step with the background's state: it
 * gathers the sources `toolbar-badge.ts` reads, writes the badge, and lights
 * the icon (`toolbar-icon.ts`) while a cast runs, whenever something either
 * depends on may have changed.
 *
 * Triggers: every popup notification (they are sent exactly when casts,
 * health, gaps, capture health or the connection change), every change to
 * the away log, a dismissal the popup stores, and the browser theme. Nothing
 * is written before the background has restored its state, so a restarted
 * service worker never shows an idle icon over a running cast.
 */

import { createLogger } from '@thaumic-cast/shared';
import { getAwayEvents, onAwayEventsChanged, speakerNameOf } from './away-log';
import { getCaptureHealthState } from './capture-health-state';
import { getConnectionState } from './connection-state';
import { getIngestGaps } from './ingest-gaps-state';
import { notificationService } from './notification-service';
import type { BackgroundToPopupMessage } from '../lib/messages';
import { getAllSessions } from './session-manager';
import { getSpeakerHealth } from './speaker-health-state';
import {
  TOOLBAR_DARK_KEY,
  badgeFor,
  badgeItems,
  isToolbarDark,
  readDismissals,
  writeBadge,
  type BadgeSources,
} from './toolbar-badge';
import { isToolbarIconLit, toolbarIconFor, writeToolbarIcon } from './toolbar-icon';
import {
  CAPTURE_HEALTH_DISMISSED_KEY,
  INGEST_GAPS_DISMISSED_KEY,
  INGEST_GAPS_NOTICE_MS,
  NO_REPLY_DISMISSED_KEY,
  SPEAKER_NOTICES_DISMISSED_KEY,
} from '../lib/speaker-notices';

const log = createLogger('ToolbarBadge');

/** Changes this close together are written once. */
const REFRESH_DELAY_MS = 100;

/**
 * Gathers the badge's sources from the background's state now.
 * @returns The sources
 */
export async function currentBadgeSources(): Promise<BadgeSources> {
  const connection = getConnectionState();
  return {
    casts: getAllSessions().map(({ streamId, tabId }) => ({ streamId, tabId })),
    networkHealth: connection.networkHealth,
    networkHealthReason: connection.networkHealthReason,
    speakerHealth: getSpeakerHealth(),
    speakerName: speakerNameOf,
    ...(await readDismissals()),
    ingestGaps: getIngestGaps(),
    captureHealth: getCaptureHealthState(),
    away: await getAwayEvents(),
    now: Date.now(),
  };
}

/** Popup notifications that never change what the badge says. */
const IGNORED: ReadonlySet<BackgroundToPopupMessage['type']> = new Set([
  'TAB_STATE_CHANGED',
  'VOLUME_UPDATE',
  'MUTE_UPDATE',
  'TRANSPORT_STATE_UPDATE',
]);

let pending: ReturnType<typeof setTimeout> | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;

/** Resolves once the background has restored its state. */
let ready: Promise<unknown> = Promise.resolve();

/**
 * Recomputes the badge and the icon and writes what changed. A gaps report
 * ages out with no message to say so, so the badge is looked at again when
 * it does.
 * @returns Resolves when written
 */
export async function refreshToolbarBadge(): Promise<void> {
  await ready;
  const [sources, dark] = await Promise.all([currentBadgeSources(), isToolbarDark()]);
  await Promise.all([
    writeBadge(badgeFor(badgeItems(sources), dark)),
    writeToolbarIcon(toolbarIconFor(isToolbarIconLit(sources.casts), dark)),
  ]);

  if (expiry) clearTimeout(expiry);
  expiry = null;
  const ends = Object.values(sources.ingestGaps)
    .map((report) => report.receivedAt + INGEST_GAPS_NOTICE_MS - sources.now)
    .filter((left) => left > 0);
  if (ends.length > 0) expiry = setTimeout(scheduleRefresh, Math.min(...ends));
}

/**
 * Refreshes the badge soon, once for a burst of changes.
 */
function scheduleRefresh(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    refreshToolbarBadge().catch((err) => log.warn('Failed to refresh the toolbar badge:', err));
  }, REFRESH_DELAY_MS);
}

/** The stored values a change to which changes the badge. */
const WATCHED_KEYS = new Set([
  TOOLBAR_DARK_KEY,
  SPEAKER_NOTICES_DISMISSED_KEY,
  INGEST_GAPS_DISMISSED_KEY,
  CAPTURE_HEALTH_DISMISSED_KEY,
  NO_REPLY_DISMISSED_KEY,
]);

/**
 * Starts keeping the badge and the icon in step. Call once from the service
 * worker's start.
 * @param restored - Resolves once the background has restored its state
 * @returns Stops it (for tests)
 */
export function startToolbarBadge(restored: Promise<unknown> = Promise.resolve()): () => void {
  ready = restored.catch(() => undefined);
  const unsubscribe = notificationService.subscribe((msg) => {
    if (!IGNORED.has(msg.type)) scheduleRefresh();
  });
  const unwatchAway = onAwayEventsChanged(scheduleRefresh);
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>): void => {
    if (Object.keys(changes).some((key) => WATCHED_KEYS.has(key))) scheduleRefresh();
  };
  chrome.storage.onChanged.addListener(onStorage);
  scheduleRefresh();
  return () => {
    unsubscribe();
    unwatchAway();
    chrome.storage.onChanged.removeListener(onStorage);
  };
}
