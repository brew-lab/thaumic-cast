/**
 * Sets the audio lead in a tab and keeps what each frame's hook says back.
 *
 * The lead goes to every frame of the tab at once (an embedded player sits in
 * its own frame), through the relay that runs beside the hook in each frame.
 * Each relay reports its frame's status separately, keyed here by frame ID.
 * The video sync controller drives this module.
 *
 * A relay holds a lead only on a lease (LEASE_MS): while a lead is wanted the
 * controller must call {@link setTabLead} again at least every
 * LEAD_REFRESH_MS. That also reaches frames and pages that loaded since (a
 * relay stays silent until it hears a lead) and rebuilds statuses dropped by
 * {@link forgetTab}. A cast that ends should still send a lead of 0 rather
 * than rely on the lease running out.
 */

import { createLogger } from '@thaumic-cast/shared';
import {
  LEAD_MESSAGE_TYPE,
  validateStatus,
  type HookStatus,
  type LeadMessage,
} from '../../video-sync-hook/protocol';
import type { VideoSyncHookStatusMessage } from '../../lib/message-schemas';

const log = createLogger('VideoSyncLead');

/**
 * What one frame's hook last said.
 */
export interface FrameHookStatus extends HookStatus {
  frameId: number;
  /** `Date.now()` when it arrived. */
  receivedAt: number;
}

/**
 * The lead wanted in a tab.
 */
export interface TabLead {
  enabled: boolean;
  /** Lead in ms of wall time; the hook scales it by each element's playback rate. */
  leadMs: number;
  /** Also clear the hooks' "turned off" latch (after a freeze or the live edge). */
  rearm?: boolean;
}

/**
 * Outcome of sending a lead to a tab.
 */
export interface SetLeadResult {
  /** At least one frame's relay answered: the page has the hook. */
  reached: boolean;
  /** The answering relay had paired with its hook. */
  paired: boolean;
}

/** Status listener signature. */
export type HookStatusListener = (
  tabId: number,
  frames: ReadonlyMap<number, FrameHookStatus>,
) => void;

const byTab = new Map<number, Map<number, FrameHookStatus>>();
const listeners = new Set<HookStatusListener>();

/**
 * Sends the wanted lead to every frame of a tab. Call it again at least
 * every LEAD_REFRESH_MS while the lead is wanted (see the module notes).
 * @param tabId - The tab
 * @param lead - The lead
 * @returns Whether any frame's relay answered
 */
export async function setTabLead(tabId: number, lead: TabLead): Promise<SetLeadResult> {
  const msg: LeadMessage = {
    type: LEAD_MESSAGE_TYPE,
    enabled: lead.enabled,
    leadMs: Math.round(Math.min(6000, Math.max(0, lead.leadMs))),
  };
  if (lead.rearm) msg.rearm = true;
  try {
    const res: unknown = await chrome.tabs.sendMessage(tabId, msg);
    const r = typeof res === 'object' && res !== null ? (res as Record<string, unknown>) : null;
    if (!r || typeof r.paired !== 'boolean') return { reached: false, paired: false };
    return { reached: true, paired: r.paired };
  } catch {
    // No relay in the tab: opened before video sync was on, or not a web page.
    return { reached: false, paired: false };
  }
}

/**
 * Records a frame's status from its relay.
 * @param msg - The validated message
 * @param sender - Who sent it
 */
export function handleHookStatus(
  msg: VideoSyncHookStatusMessage,
  sender: chrome.runtime.MessageSender,
): void {
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const status = validateStatus(msg.status);
  if (!status) return;
  const frameId = sender.frameId ?? 0;
  let frames = byTab.get(tabId);
  if (!frames) {
    frames = new Map();
    byTab.set(tabId, frames);
  }
  frames.set(frameId, { ...status, frameId, receivedAt: Date.now() });
  log.debug(
    `Tab ${tabId} frame ${frameId}: ${status.state}${status.reason ? ` (${status.reason})` : ''}`,
  );
  for (const fn of listeners) {
    try {
      fn(tabId, frames);
    } catch (err) {
      log.warn(`Hook status listener failed: ${String(err)}`);
    }
  }
}

/**
 * The latest status of each frame of a tab.
 * @param tabId - The tab
 * @returns Frame ID to status (empty when no frame has reported)
 */
export function getTabHookStatus(tabId: number): ReadonlyMap<number, FrameHookStatus> {
  return byTab.get(tabId) ?? new Map();
}

/**
 * Forgets a tab's frame statuses (closed, or navigated away).
 * @param tabId - The tab
 */
export function forgetTab(tabId: number): void {
  byTab.delete(tabId);
}

/**
 * Subscribes to frame status changes.
 * @param fn - Called with the tab and all its frames' statuses
 * @returns A function that unsubscribes
 */
export function onHookStatus(fn: HookStatusListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
