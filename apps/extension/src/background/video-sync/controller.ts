/**
 * Video sync lead controller: decides how early a casting tab plays its sound.
 *
 * The speakers play behind the page by the companion's playout delay (the
 * cadence queue plus the speaker's reserve), the time the audio spends in
 * the extension before the companion has it, and the speaker's own output
 * delay. The page's audio-lead hook plays the sound that much early, minus a
 * little (sound a touch late is far less noticeable than sound early), so
 * picture and sound arrive together.
 *
 *   L = companion + median(capture delay, last 10 s) + K + trim(speaker) − 40
 *
 * clamped to 0..6000 ms of wall time. The hook scales it by each element's
 * playback rate itself.
 *
 * A lead is applied as one jump, never slewed, and only when it is worth it:
 * when the estimate moves by more than {@link LEAD_STEP_THRESHOLD_MS} (at most
 * once every {@link LEAD_STEP_MIN_INTERVAL_MS}), and at once when the
 * estimate's epoch steps, the trim changes or video sync is switched on.
 * Losing the measurement keeps the lead where it is. The first lead waits
 * up to {@link CAPTURE_DELAY_FIRST_WAIT_MS} for a capture-delay sample, so it
 * does not go out short and jump again a few seconds later.
 *
 * This module is pure: the caller passes the time in and sends what
 * {@link LeadController.next} and {@link LeadController.keepAlive} return.
 */

import type {
  AudioCodec,
  PlayoutLatency,
  VideoSyncReason,
  VideoSyncStatus,
} from '@thaumic-cast/protocol';
import { MAX_LEAD_MS } from '../../video-sync-hook/protocol';
import type { FrameHookStatus } from './lead-api';

/** How late the sound is aimed to arrive, in ms (sound late is the gentler error). */
export const TARGET_AUDIO_LATE_MS = 40;

/**
 * The speaker's own output delay K, in ms. Not measured yet, so 0; the
 * per-speaker trim covers it until a measured default per model exists.
 */
export const SPEAKER_OUTPUT_DELAY_MS = 0;

/** A new lead is sent only when it differs from the last by more than this, in ms. */
export const LEAD_STEP_THRESHOLD_MS = 40;

/** Shortest time between leads sent for routine estimate changes, in ms. */
export const LEAD_STEP_MIN_INTERVAL_MS = 5000;

/** Window the capture delay's median is taken over, in ms. */
export const CAPTURE_DELAY_WINDOW_MS = 10_000;

/**
 * Updated latency events in a row without a playout estimate, from a
 * companion that never sent one, before it is taken to be too old.
 */
export const COMPANION_OLD_AFTER_EVENTS = 15;

/**
 * How long the first lead waits for a capture-delay sample, in ms. The
 * offscreen document reports one a second; without one the lead would go
 * out short and then jump again once the delay arrived.
 */
export const CAPTURE_DELAY_FIRST_WAIT_MS = 3000;

/**
 * How far the hook's applied lead may sit from the lead sent and still count
 * as the same, in ms (whole-frame rounding on encrypted audio: 900 → 896).
 */
export const LEAD_MATCH_TOLERANCE_MS = 50;

/** Hook reasons that mean the page cannot be synced. */
const HOOK_UNAVAILABLE: ReadonlySet<string> = new Set(['muxed', 'worker', 'no-mse', 'format']);

/** Hook reasons that mean the hook turned the lead off. */
const HOOK_TURNED_OFF: ReadonlySet<string> = new Set(['freeze', 'live-edge']);

/** Hook states that mean the frame has a Media Source element. */
const HOOK_HAS_MSE: ReadonlySet<string> = new Set([
  'ready',
  'switching',
  'applied',
  'pending',
  'off',
]);

/**
 * The facts about a cast that decide whether its sound can be led at all.
 */
export interface CastFacts {
  /** How the cast captures audio. */
  captureMode: 'tab' | 'browser';
  /** The cast's codec. */
  codec: AudioCodec;
}

/**
 * The speaker whose delay the lead follows.
 */
export interface FollowedSpeaker {
  /** The speaker's address. */
  ip: string;
  /** Its display name. */
  name: string;
  /** The user's trim for it, in ms. */
  trimMs: number;
}

/**
 * A lead to send to every frame of the tab.
 */
export interface LeadCommand {
  /** Whether a lead is wanted at all; false takes it off every frame. */
  enabled: boolean;
  /** Lead in ms of wall time. */
  leadMs: number;
  /** Also clear the hooks' "turned off" latch. */
  rearm?: boolean;
}

/**
 * What a controller remembers across a service-worker restart.
 */
export interface LeadSnapshot {
  /** The lead last sent, in ms. */
  leadMs: number;
  /** The playout epoch it was computed from. */
  epoch: number;
}

/**
 * Whether a send reached the tab, and whether the hook could have got there.
 */
export interface ReachResult {
  /** A relay in the tab answered. */
  reached: boolean;
  /** The extension holds the host permission the page scripts need. */
  access: boolean;
  /**
   * The page is one the scripts can enter, so a reload would give it them
   * (not chrome://, the Web Store or a local file).
   */
  scriptable: boolean;
}

/**
 * Computes the lead to apply.
 * @param companionMs - The companion's playout estimate, in ms
 * @param captureDelayMs - The time audio waits in the extension, in ms
 * @param trimMs - The user's trim for the speaker, in ms
 * @returns The lead in ms of wall time, whole, clamped to 0..MAX_LEAD_MS
 */
export function leadFor(companionMs: number, captureDelayMs: number, trimMs: number): number {
  const l = companionMs + captureDelayMs + SPEAKER_OUTPUT_DELAY_MS + trimMs - TARGET_AUDIO_LATE_MS;
  return Math.round(Math.min(MAX_LEAD_MS, Math.max(0, l)));
}

/**
 * The median of some numbers.
 * @param values - The numbers
 * @returns Their median, or 0 when there are none
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Ranks a frame's status for {@link pickFrame}.
 * @param f - The frame's status
 * @returns Higher for the frame most likely to hold the video being watched
 */
function frameRank(f: FrameHookStatus): number {
  const mse = HOOK_HAS_MSE.has(f.state);
  const unavailable = f.state === 'unavailable';
  if (f.playing && mse) return 4;
  if (f.playing && unavailable) return 3;
  if (mse) return 2;
  if (unavailable) return 1;
  return 0;
}

/**
 * Picks the frame whose hook speaks for the tab: a playing one with a Media
 * Source element first, then a playing one that cannot be synced, then any
 * with a Media Source element, then any that cannot be synced. Ties go to
 * the most recent report.
 * @param frames - Each frame's latest status
 * @returns The frame, or null when no frame has any media to speak of
 */
export function pickFrame(frames: Iterable<FrameHookStatus>): FrameHookStatus | null {
  let best: FrameHookStatus | null = null;
  let bestRank = 0;
  for (const f of frames) {
    const rank = frameRank(f);
    if (rank === 0) continue;
    if (!best || rank > bestRank || (rank === bestRank && f.receivedAt > best.receivedAt)) {
      best = f;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * The lead controller for one cast's tab.
 */
export class LeadController {
  private readonly facts: CastFacts;
  private speaker: FollowedSpeaker;
  private enabled: boolean;

  /** The latest playout estimate for the followed speaker. */
  private playout: PlayoutLatency | null = null;
  /** The measurement went stale since the latest estimate. */
  private stale = false;
  /** An estimate has ever arrived (so the companion is new enough). */
  private everEstimated = false;
  /** Updated events in a row without an estimate. */
  private missingEstimates = 0;
  /** The epoch the last lead was computed from. */
  private lastEpoch: number | null = null;

  /** Capture-delay samples: [time, ms]. */
  private captureDelays: Array<[number, number]> = [];
  /** A capture-delay sample has ever arrived. */
  private everCaptureDelay = false;
  /** When an estimate was first there to compute a lead from. */
  private firstTargetAt: number | null = null;

  /** The lead last sent while enabled (0 before any). */
  private leadSent = 0;
  /** Whether a lead computed from an estimate has been sent. */
  private hasSentLead = false;
  /** When the last estimate-driven lead was sent. */
  private lastSentAt = Number.NEGATIVE_INFINITY;
  /** Whether the hooks were last told enabled, or nothing told yet. */
  private sentEnabled: boolean | null = null;
  /** Send the next computed lead at once (epoch, trim, switched on, new speaker). */
  private immediate = true;
  /** Ask the hooks to clear their latch with the next send. */
  private rearm = false;

  /** The latest reach result, or null before any send. */
  private reach: ReachResult | null = null;
  /** Each frame's latest hook status. */
  private frames: FrameHookStatus[] = [];

  /**
   * Creates a controller.
   * @param facts - The cast's capture mode and codec
   * @param speaker - The speaker followed and its trim
   * @param enabled - Whether video sync is on for the cast
   * @param restored - The lead in force before a service-worker restart
   */
  constructor(
    facts: CastFacts,
    speaker: FollowedSpeaker,
    enabled: boolean,
    restored?: LeadSnapshot,
  ) {
    this.facts = facts;
    this.speaker = { ...speaker };
    this.enabled = enabled;
    if (restored && enabled) {
      this.leadSent = restored.leadMs;
      this.lastEpoch = restored.epoch;
      this.hasSentLead = true;
      this.sentEnabled = true;
      // Keep the restored lead unless the estimate says otherwise.
      this.immediate = false;
    }
  }

  /**
   * The reason the cast itself cannot be led, before any page is asked.
   * @returns The reason, or null when the cast qualifies
   */
  private castGate(): VideoSyncReason | null {
    if (this.facts.captureMode !== 'tab') return 'browser-capture';
    if (this.facts.codec !== 'pcm') return 'pcm-only';
    if (this.missingEstimates >= COMPANION_OLD_AFTER_EVENTS && !this.everEstimated) {
      return 'companion-old';
    }
    return null;
  }

  /**
   * The speaker the lead follows.
   * @returns Its address, name and trim
   */
  followed(): FollowedSpeaker {
    return { ...this.speaker };
  }

  /**
   * Records an updated latency event for the followed speaker.
   * @param playout - Its playout estimate, if it carried one
   */
  onPlayout(playout: PlayoutLatency | undefined): void {
    if (!playout) {
      this.missingEstimates += 1;
      return;
    }
    this.missingEstimates = 0;
    this.everEstimated = true;
    this.stale = false;
    if (playout.epoch !== this.lastEpoch) this.immediate = true;
    this.playout = playout;
  }

  /** Records that the followed speaker's measurement went stale. */
  onStale(): void {
    this.stale = true;
  }

  /**
   * Records how long audio waited in the extension.
   * @param ms - The delay, in ms
   * @param now - The time now, in ms
   */
  onCaptureDelay(ms: number, now: number): void {
    this.everCaptureDelay = true;
    this.captureDelays.push([now, ms]);
    const from = now - CAPTURE_DELAY_WINDOW_MS;
    while (this.captureDelays.length && this.captureDelays[0][0] < from) {
      this.captureDelays.shift();
    }
  }

  /**
   * The capture delay to use: the median over the window.
   * @param now - The time now, in ms
   * @returns The delay, in ms (0 before any sample)
   */
  captureDelay(now: number): number {
    const from = now - CAPTURE_DELAY_WINDOW_MS;
    return median(this.captureDelays.filter(([t]) => t >= from).map(([, ms]) => ms));
  }

  /**
   * Sets the trim for the followed speaker; applies at once.
   * @param trimMs - The trim, in ms
   */
  setTrim(trimMs: number): void {
    if (trimMs === this.speaker.trimMs) return;
    this.speaker.trimMs = trimMs;
    this.immediate = true;
  }

  /**
   * Switches video sync on or off for the cast.
   * @param enabled - On or off
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.immediate = true;
  }

  /**
   * Whether video sync is on for the cast.
   * @returns On or off
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Follows another speaker (the first one left the cast). Its estimate is
   * awaited afresh and the first one applies at once.
   * @param speaker - The speaker and its trim
   */
  follow(speaker: FollowedSpeaker): void {
    if (speaker.ip === this.speaker.ip) return;
    this.speaker = { ...speaker };
    this.playout = null;
    this.stale = false;
    this.lastEpoch = null;
    this.immediate = true;
  }

  /** Asks the hooks to clear a "turned off" latch with the next send. */
  requestRearm(): void {
    this.rearm = true;
  }

  /**
   * Records whether the last send reached the tab.
   * @param result - What the send found
   */
  onReach(result: ReachResult): void {
    this.reach = { ...result };
  }

  /**
   * Records each frame's latest hook status.
   * @param frames - The statuses
   */
  onFrames(frames: Iterable<FrameHookStatus>): void {
    this.frames = [...frames];
  }

  /**
   * The lead the current estimate calls for.
   * @param now - The time now, in ms
   * @returns The lead in ms, or null with no estimate yet
   */
  target(now: number): number | null {
    if (!this.playout) return null;
    return leadFor(this.playout.companionMs, this.captureDelay(now), this.speaker.trimMs);
  }

  /**
   * The command to send now, if anything changed enough to send one.
   * Records it as sent.
   * @param now - The time now, in ms
   * @returns The command, or null when nothing needs sending
   */
  next(now: number): LeadCommand | null {
    if (this.castGate()) return null;
    if (!this.enabled) {
      if (this.sentEnabled === false || this.sentEnabled === null) return null;
      this.sentEnabled = false;
      this.leadSent = 0;
      this.hasSentLead = false;
      this.rearm = false;
      return { enabled: false, leadMs: 0 };
    }

    let target = this.target(now);
    if (target !== null) {
      this.firstTargetAt ??= now;
      // Give the capture delay a moment to arrive, so the first lead is whole.
      if (!this.everCaptureDelay && now - this.firstTargetAt < CAPTURE_DELAY_FIRST_WAIT_MS) {
        target = null;
      }
    }
    let send = false;
    if (target !== null) {
      if (this.immediate || !this.hasSentLead) {
        send = true;
      } else if (
        !this.stale &&
        Math.abs(target - this.leadSent) > LEAD_STEP_THRESHOLD_MS &&
        now - this.lastSentAt >= LEAD_STEP_MIN_INTERVAL_MS
      ) {
        send = true;
      }
    }

    if (send && target !== null) {
      this.leadSent = target;
      this.hasSentLead = true;
      this.lastSentAt = now;
      this.lastEpoch = this.playout?.epoch ?? this.lastEpoch;
      this.immediate = false;
    } else if (this.sentEnabled === true && !this.rearm) {
      return null;
    }

    this.sentEnabled = true;
    const cmd: LeadCommand = { enabled: true, leadMs: this.leadSent };
    if (this.rearm) cmd.rearm = true;
    this.rearm = false;
    return cmd;
  }

  /**
   * The command that keeps the page's lead alive (its relay holds a lead
   * only on a lease) and finds out whether the page has the hook at all.
   * @returns The command, or null when no lead is wanted
   */
  keepAlive(): LeadCommand | null {
    if (this.castGate() || !this.enabled) return null;
    this.sentEnabled = true;
    return { enabled: true, leadMs: this.leadSent };
  }

  /**
   * What to remember across a service-worker restart.
   * @returns The lead in force and its epoch, or null when none is
   */
  snapshot(): LeadSnapshot | null {
    if (!this.enabled || !this.hasSentLead || this.lastEpoch === null) return null;
    return { leadMs: this.leadSent, epoch: this.lastEpoch };
  }

  /**
   * The status for the popup.
   * @returns The status
   */
  status(): VideoSyncStatus {
    const base: VideoSyncStatus = {
      enabled: this.enabled,
      state: 'off',
      speakerIp: this.speaker.ip,
      speakerName: this.speaker.name,
      trimMs: this.speaker.trimMs,
    };
    if (!this.enabled) return base;
    if (this.playout) base.source = this.playout.source;
    if (this.hasSentLead) base.leadMs = this.leadSent;

    const gate = this.castGate();
    if (gate) return { ...base, state: 'unavailable', reason: gate };
    if (this.reach && !this.reach.reached) {
      const reason: VideoSyncReason = !this.reach.access
        ? 'no-access'
        : this.reach.scriptable
          ? 'reload'
          : 'not-web-page';
      return { ...base, state: 'unavailable', reason };
    }

    const frame = pickFrame(this.frames);
    if (!frame && this.frames.some((f) => f.state === 'no-media')) {
      return { ...base, state: 'no-video' };
    }
    if (frame?.state === 'unavailable' && frame.reason && HOOK_UNAVAILABLE.has(frame.reason)) {
      return { ...base, state: 'unavailable', reason: frame.reason as VideoSyncReason };
    }
    if (frame?.state === 'off' && frame.reason && HOOK_TURNED_OFF.has(frame.reason)) {
      return { ...base, state: 'turned-off', reason: frame.reason as VideoSyncReason };
    }

    const measured = !!this.playout && !this.stale && this.playout.source === 'reserve';
    // A lead of 0 (the estimate clamped there) leaves the hook 'ready'.
    const atLead = frame?.state === 'applied' || (frame?.state === 'ready' && this.leadSent === 0);
    const applied =
      !!frame &&
      atLead &&
      this.hasSentLead &&
      Math.abs(frame.appliedLeadMs - this.leadSent) <= LEAD_MATCH_TOLERANCE_MS;
    return { ...base, state: measured && applied ? 'in-step' : 'locking' };
  }
}
