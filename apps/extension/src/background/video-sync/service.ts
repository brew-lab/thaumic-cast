/**
 * Video sync service: runs a {@link LeadController} for each cast started
 * with video sync, and connects it to the latency events, the capture delay
 * from the offscreen document, the per-speaker trims, the cast's toggle and
 * the page's hooks (through lead-api).
 *
 * A controller is made the first time anything about its cast arrives, so a
 * service-worker restart rebuilds it from the next latency event, about a
 * second later. The lead last sent is kept in session storage meanwhile, so
 * the rebuilt controller does not move the sound needlessly; the page's
 * relay keeps the lead for a while on its own (see LEASE_MS).
 *
 * While a lead is wanted the service sends it again every LEAD_REFRESH_MS:
 * the relay holds a lead only on that lease, and the refresh also reaches
 * pages loaded since and tells whether the page has the hook at all. When
 * the cast is gone the next refresh sends a lead of 0 and stops.
 */

import { createLogger } from '@thaumic-cast/shared';
import {
  PlayoutLatencySchema,
  type LatencyBroadcastEvent,
  type VideoSyncStatus,
} from '@thaumic-cast/protocol';
import { z } from 'zod';
import { LEAD_REFRESH_MS } from '../../video-sync-hook/protocol';
import { hasVideoSyncHostAccess } from '../../lib/video-sync-access';
import { loadSpeakerTrim, saveSpeakerTrim } from '../../lib/video-sync-trim';
import { getSession, getSessionByStreamId, setVideoSyncOn } from '../session-manager';
import { getSonosState } from '../sonos-state';
import { notifyPopup } from '../notification-service';
import {
  LeadController,
  type FollowedSpeaker,
  type LeadCommand,
  type LeadSnapshot,
} from './controller';
import { forgetTab, getTabHookStatus, onHookStatus, setTabLead } from './lead-api';

const log = createLogger('VideoSync');

/** Session-storage key of the leads in force, by tab. */
const LEADS_STORAGE_KEY = 'videoSyncLeads';

/** One stored lead. */
const StoredLeadSchema = z.object({
  streamId: z.string(),
  leadMs: z.number().int().nonnegative(),
  epoch: z.number().int().positive(),
});

/** The stored leads, tab ID to lead. */
const StoredLeadsSchema = z.record(z.string(), StoredLeadSchema);
type StoredLeads = z.infer<typeof StoredLeadsSchema>;

/** A running controller and what goes with it. */
interface Entry {
  tabId: number;
  streamId: string;
  controller: LeadController;
  timer: ReturnType<typeof setInterval> | null;
  /** The status last sent to the popup, as JSON. */
  lastStatus: string;
}

const entries = new Map<number, Entry>();

/**
 * Streams whose lead was taken off for good as their cast stopped, so a
 * latency event still in flight cannot bring the lead back.
 */
const stoppedStreams = new Set<string>();

/** How many stopped streams to remember. */
const STOPPED_STREAMS_KEPT = 32;
const pending = new Map<number, Promise<Entry | null>>();

/** Sends one command at a time per tab, in order. */
const sendQueues = new Map<number, Promise<unknown>>();

/** The lead that takes the lead off. */
const LEAD_OFF: LeadCommand = { enabled: false, leadMs: 0 };

/** Stops the hook-status subscription (tests). */
let unsubscribe: (() => void) | null = null;

/**
 * Starts listening for hook statuses. Call once when the background starts.
 */
export function initVideoSyncService(): void {
  if (unsubscribe) return;
  unsubscribe = onHookStatus((tabId, frames) => {
    const entry = entries.get(tabId);
    if (!entry) return;
    entry.controller.onFrames(frames.values());
    publish(entry);
  });
}

/**
 * The session's followed speaker: the first one.
 * @param session - The session
 * @param session.speakerIps - Its speakers
 * @param session.speakerNames - Their names
 * @returns The speaker's address and name, or null when it has none
 */
function firstSpeaker(session: {
  speakerIps: string[];
  speakerNames: string[];
}): { ip: string; name: string } | null {
  const ip = session.speakerIps[0];
  if (!ip) return null;
  return { ip, name: session.speakerNames[0] ?? ip };
}

/**
 * Reads the stored leads.
 * @returns The leads, by tab ID
 */
async function readLeads(): Promise<StoredLeads> {
  try {
    const raw = (await chrome.storage.session.get(LEADS_STORAGE_KEY))[LEADS_STORAGE_KEY];
    const parsed = StoredLeadsSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Stores (or clears) a tab's lead in force.
 * @param tabId - The tab
 * @param streamId - Its cast's stream
 * @param snapshot - The lead, or null to clear it
 */
async function writeLead(
  tabId: number,
  streamId: string,
  snapshot: LeadSnapshot | null,
): Promise<void> {
  try {
    const leads = await readLeads();
    const key = String(tabId);
    if (snapshot) leads[key] = { streamId, ...snapshot };
    else if (key in leads) delete leads[key];
    else return;
    await chrome.storage.session.set({ [LEADS_STORAGE_KEY]: leads });
  } catch {
    // Only a convenience across restarts.
  }
}

/**
 * Gets the controller for a tab's cast, making it if the cast has video sync.
 * @param tabId - The tab
 * @returns The entry, or null when the tab has no cast with video sync
 */
async function ensureEntry(tabId: number): Promise<Entry | null> {
  const session = getSession(tabId);
  const existing = entries.get(tabId);
  if (existing && session && existing.streamId === session.streamId) return existing;
  // The cast this entry ran for is gone (ended without stopVideoSync, say
  // by disconnection or losing its last speaker): take its lead off first.
  if (existing) void retire(existing);
  if (!session?.videoSync || stoppedStreams.has(session.streamId)) return null;

  const inFlight = pending.get(tabId);
  if (inFlight) return inFlight;

  const made = (async (): Promise<Entry | null> => {
    const speaker = firstSpeaker(session);
    if (!speaker) return null;
    const groups = getSonosState().groups;
    const trimMs = await loadSpeakerTrim(speaker.ip, groups);
    const stored = (await readLeads())[String(tabId)];
    const restored =
      stored && stored.streamId === session.streamId
        ? { leadMs: stored.leadMs, epoch: stored.epoch }
        : undefined;
    // The cast may have ended or changed while storage was read.
    const now = getSession(tabId);
    if (!now || now.streamId !== session.streamId || stoppedStreams.has(session.streamId)) {
      return null;
    }
    const controller = new LeadController(
      { captureMode: session.captureMode, codec: session.encoderConfig.codec },
      { ...speaker, trimMs },
      session.videoSyncOn,
      restored,
    );
    controller.onFrames(getTabHookStatus(tabId).values());
    const entry: Entry = {
      tabId,
      streamId: session.streamId,
      controller,
      timer: null,
      lastStatus: '',
    };
    entries.set(tabId, entry);
    entry.timer = setInterval(() => void refresh(entry), LEAD_REFRESH_MS);
    log.info(
      `Video sync for tab ${tabId} follows ${speaker.name}` +
        (restored ? ` (lead ${restored.leadMs} ms kept from before a restart)` : ''),
    );
    void send(entry, controller.keepAlive());
    return entry;
  })();
  pending.set(tabId, made);
  try {
    return await made;
  } finally {
    pending.delete(tabId);
  }
}

/**
 * Stops a controller's timer and forgets it.
 * @param entry - The entry
 */
function dispose(entry: Entry): void {
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = null;
  if (entries.get(entry.tabId) === entry) entries.delete(entry.tabId);
}

/**
 * Runs a job on a tab's send queue, after every job queued before it. Every
 * lead a tab hears goes through here, so a lead of 0 queued as a cast stops
 * cannot be overtaken by a lead queued earlier.
 * @param tabId - The tab
 * @param job - The job
 * @returns Resolves once the job has run
 */
function enqueue(tabId: number, job: () => Promise<void>): Promise<void> {
  const prev = sendQueues.get(tabId) ?? Promise.resolve();
  const run = prev.then(job);
  const tail = run.catch(() => undefined);
  sendQueues.set(tabId, tail);
  void tail.then(() => {
    if (sendQueues.get(tabId) === tail) sendQueues.delete(tabId);
  });
  return run;
}

/**
 * Whether the extension could have put its scripts into a tab: a web page it
 * holds access to. Without the tabs permission Chrome hides the address of
 * any page outside the granted hosts, so a missing address means a page no
 * script can enter (chrome://, the Web Store, a local file).
 * @param tabId - The tab
 * @returns True when the page is one a reload would give the scripts
 */
async function isScriptablePage(tabId: number): Promise<boolean> {
  try {
    const url = (await chrome.tabs.get(tabId)).url;
    if (!url) return false;
    const { protocol, hostname, pathname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    if (hostname === 'chromewebstore.google.com') return false;
    if (hostname === 'chrome.google.com' && pathname.startsWith('/webstore')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends a command to the tab, one at a time, and records whether it got there.
 * A command queued for an entry that has since been retired is dropped.
 * @param entry - The entry
 * @param cmd - The command, or null for nothing
 * @returns Resolves once sent
 */
function send(entry: Entry, cmd: LeadCommand | null): Promise<void> {
  if (!cmd) return Promise.resolve();
  return enqueue(entry.tabId, async () => {
    if (entries.get(entry.tabId) !== entry) return;
    const res = await setTabLead(entry.tabId, cmd);
    let access = true;
    let scriptable = true;
    if (!res.reached) {
      access = await hasVideoSyncHostAccess();
      scriptable = access && (await isScriptablePage(entry.tabId));
    }
    if (entries.get(entry.tabId) !== entry) return;
    entry.controller.onReach({ reached: res.reached, access, scriptable });
    publish(entry);
  });
}

/**
 * Sends a lead of 0 to a tab through its send queue, whatever entry it has.
 * @param tabId - The tab
 * @returns Resolves once sent
 */
function sendLeadOff(tabId: number): Promise<void> {
  return enqueue(tabId, async () => {
    await setTabLead(tabId, LEAD_OFF);
  });
}

/**
 * Ends an entry whose cast is gone: forgets it, clears its stored lead and
 * takes the lead off the tab after anything already queued.
 * @param entry - The entry
 * @returns Resolves once the lead of 0 is sent
 */
function retire(entry: Entry): Promise<void> {
  dispose(entry);
  void writeLead(entry.tabId, entry.streamId, null);
  return sendLeadOff(entry.tabId);
}

/**
 * Sends whatever the controller wants sent now, and keeps the stored lead
 * and the popup up to date.
 * @param entry - The entry
 */
function pump(entry: Entry): void {
  if (entries.get(entry.tabId) !== entry) return;
  const cmd = entry.controller.next(Date.now());
  if (cmd) {
    log.info(
      `Tab ${entry.tabId}: lead ${cmd.enabled ? `${cmd.leadMs} ms` : 'off'}` +
        (cmd.rearm ? ' (try again)' : ''),
    );
    void writeLead(entry.tabId, entry.streamId, entry.controller.snapshot());
    void send(entry, cmd);
  }
  publish(entry);
}

/**
 * The lease refresh: sends the lead again, or ends the controller (with a
 * lead of 0) once its cast is gone.
 * @param entry - The entry
 */
async function refresh(entry: Entry): Promise<void> {
  if (entries.get(entry.tabId) !== entry) return;
  const session = getSession(entry.tabId);
  if (!session || session.streamId !== entry.streamId) {
    await retire(entry);
    return;
  }
  const first = firstSpeaker(session);
  if (first && first.ip !== entry.controller.followed().ip) {
    const trimMs = await loadSpeakerTrim(first.ip, getSonosState().groups);
    // The cast may have stopped while the trim was read.
    if (entries.get(entry.tabId) !== entry) return;
    entry.controller.follow({ ...first, trimMs });
  }
  pump(entry);
  await send(entry, entry.controller.keepAlive());
}

/**
 * Tells the popup when a tab's status changed.
 * @param entry - The entry
 */
function publish(entry: Entry): void {
  const status = entry.controller.status();
  const json = JSON.stringify(status);
  if (json === entry.lastStatus) return;
  entry.lastStatus = json;
  notifyPopup({ type: 'VIDEO_SYNC_STATE_CHANGED', tabId: entry.tabId, status });
}

/**
 * Feeds a latency event to its cast's controller. Only the followed speaker's
 * events count.
 * @param event - The event (updated or stale)
 */
export async function handleVideoSyncLatency(event: LatencyBroadcastEvent): Promise<void> {
  const session = getSessionByStreamId(event.streamId);
  if (!session) return;
  const entry = await ensureEntry(session.tabId);
  if (!entry || event.speakerIp !== entry.controller.followed().ip) return;
  if (event.type === 'updated') {
    // Broadcast events reach here unvalidated: read the estimate with care.
    const parsed = PlayoutLatencySchema.safeParse(event.playout);
    entry.controller.onPlayout(parsed.success ? parsed.data : undefined);
  } else {
    entry.controller.onStale();
  }
  pump(entry);
}

/**
 * Records how long a tab's audio waits in the extension.
 * @param tabId - The tab
 * @param ms - The delay, in ms
 */
export async function handleCaptureDelay(tabId: number, ms: number): Promise<void> {
  const entry = await ensureEntry(tabId);
  if (!entry) return;
  entry.controller.onCaptureDelay(ms, Date.now());
}

/**
 * Switches video sync on or off for a cast.
 * @param tabId - The cast's tab
 * @param enabled - On or off
 * @returns The status afterwards, or null when the tab has no cast with video sync
 */
export async function setVideoSyncEnabled(
  tabId: number,
  enabled: boolean,
): Promise<VideoSyncStatus | null> {
  const entry = await ensureEntry(tabId);
  if (!entry) return null;
  setVideoSyncOn(tabId, enabled);
  entry.controller.setEnabled(enabled);
  if (!enabled) void writeLead(tabId, entry.streamId, null);
  pump(entry);
  return entry.controller.status();
}

/**
 * Sets the trim for a cast's followed speaker, stores it for that speaker
 * and applies it at once.
 * @param tabId - The cast's tab
 * @param trimMs - The trim, in ms
 * @returns The status afterwards, or null when the tab has no cast with video sync
 */
export async function setVideoSyncTrim(
  tabId: number,
  trimMs: number,
): Promise<VideoSyncStatus | null> {
  const entry = await ensureEntry(tabId);
  if (!entry) return null;
  const speaker: FollowedSpeaker = entry.controller.followed();
  const stored = await saveSpeakerTrim(speaker.ip, getSonosState().groups, trimMs);
  // Kept for the speaker either way; applied only if the cast still runs.
  if (entries.get(tabId) !== entry) return null;
  entry.controller.setTrim(stored);
  pump(entry);
  return entry.controller.status();
}

/**
 * Asks the page's hooks to try the lead again after they turned it off.
 * @param tabId - The cast's tab
 * @returns The status afterwards, or null when the tab has no cast with video sync
 */
export async function rearmVideoSync(tabId: number): Promise<VideoSyncStatus | null> {
  const entry = await ensureEntry(tabId);
  if (!entry) return null;
  entry.controller.requestRearm();
  pump(entry);
  return entry.controller.status();
}

/**
 * The status of a tab's video sync, for the popup.
 * @param tabId - The tab
 * @returns The status, or null when the tab has no cast with video sync
 */
export async function getVideoSyncStatus(tabId: number): Promise<VideoSyncStatus | null> {
  const entry = await ensureEntry(tabId);
  return entry ? entry.controller.status() : null;
}

/**
 * Takes the lead off a tab before its cast stops: every frame gets a lead of
 * 0 first, so the page's own sound is back in step when capture ends. The
 * hooks' dead-man switch is the backstop if this never arrives.
 * @param tabId - The tab
 */
export async function stopVideoSync(tabId: number): Promise<void> {
  const streamId = getSession(tabId)?.streamId;
  if (streamId) {
    stoppedStreams.add(streamId);
    if (stoppedStreams.size > STOPPED_STREAMS_KEPT) {
      stoppedStreams.delete(stoppedStreams.values().next().value as string);
    }
  }
  const entry = entries.get(tabId);
  // Retiring the entry first means any lead still queued for it is dropped,
  // and the lead of 0 goes after whatever is already on its way.
  await (entry ? retire(entry) : sendLeadOff(tabId));
  forgetTab(tabId);
}

/**
 * Forgets every controller (tests).
 */
export function resetVideoSyncService(): void {
  for (const entry of [...entries.values()]) dispose(entry);
  pending.clear();
  sendQueues.clear();
  stoppedStreams.clear();
}
