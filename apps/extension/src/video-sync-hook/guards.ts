/**
 * Safety checks that turn the audio lead off rather than let it harm
 * playback: the live edge, starving audio, frozen playback, and a lost
 * extension (the dead-man switch). None of them ever seeks or writes
 * currentTime: they only take the lead away.
 */

/** Seconds of content beyond the lead a live stream must have. */
export const LIVE_MARGIN_S = 0.6;
/** Seconds the seekable end must move by to count as live. */
export const LIVE_EDGE_STEP_S = 0.5;
/** How often the seekable-end reference is refreshed, in ms. */
export const LIVE_EDGE_WINDOW_MS = 3000;
/** A duration above this many seconds is treated as live. */
export const LIVE_DURATION_S = 1e5;
/** Audio ahead of the playhead below this many seconds counts as starving. */
export const STARVE_AHEAD_S = 0.25;
/** Consecutive starving checks that turn the lead off. */
export const STARVE_CHECKS = 3;
/** Milliseconds stuck before the freeze watchdog acts. */
export const FREEZE_MS = 2500;
/** Milliseconds without a valid command before the dead-man switch trips. */
export const DEAD_MAN_MS = 10000;
/** Longest gap between checks counted towards the dead-man switch, in ms. */
export const DEAD_MAN_MAX_STEP_MS = 1000;

/**
 * Whether a live stream is too close to its edge for a shift: the audio
 * needs `shiftS` seconds of content beyond the playhead, plus a margin.
 * @param distS - Seconds from the playhead to the live edge
 * @param shiftS - The shift in seconds of media time
 * @returns True when the lead must not be applied (or must come off)
 */
export function liveTooClose(distS: number, shiftS: number): boolean {
  return distS < shiftS + LIVE_MARGIN_S;
}

/**
 * Remembered seekable end, to see whether it moves.
 */
export interface LiveEdgeState {
  edge: number | null;
  t: number;
  moving: boolean;
}

/**
 * Updates the seekable-end tracking: a seekable end that moves on by more
 * than {@link LIVE_EDGE_STEP_S} marks the stream live from then on.
 * @param prev - The state so far, or null on the first look
 * @param edge - The seekable end now, or null when nothing is seekable
 * @param now - Monotonic time in ms
 * @returns The new state
 */
export function trackLiveEdge(
  prev: LiveEdgeState | null,
  edge: number | null,
  now: number,
): LiveEdgeState {
  const st: LiveEdgeState = prev ? { ...prev } : { edge, t: now, moving: false };
  if (edge !== null && st.edge !== null && edge > st.edge + LIVE_EDGE_STEP_S) st.moving = true;
  if (now - st.t > LIVE_EDGE_WINDOW_MS) {
    st.edge = edge;
    st.t = now;
  }
  return st;
}

/**
 * Whether a stream is live: its duration is infinite or huge, or its
 * seekable end is moving.
 * @param elementDuration - HTMLMediaElement.duration
 * @param sourceDuration - MediaSource.duration
 * @param edgeMoving - The seekable end has been seen moving
 * @returns True for a live stream
 */
export function isLive(
  elementDuration: number,
  sourceDuration: number,
  edgeMoving: boolean,
): boolean {
  return (
    elementDuration === Infinity ||
    sourceDuration === Infinity ||
    sourceDuration > LIVE_DURATION_S ||
    edgeMoving
  );
}

/**
 * Advances the starve counter.
 * @param count - Consecutive starving checks so far
 * @param aheadS - Native audio buffered ahead of the playhead, in seconds
 * @returns The new count
 */
export function nextStarve(count: number, aheadS: number): number {
  return aheadS < STARVE_AHEAD_S ? count + 1 : 0;
}

/**
 * Whether the starve counter says the shifted audio cannot be fed.
 * @param count - Consecutive starving checks
 * @returns True at {@link STARVE_CHECKS} or more
 */
export function starved(count: number): boolean {
  return count >= STARVE_CHECKS;
}

/**
 * One look at an element for the freeze watchdog.
 */
export interface FreezeSample {
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  /** HTMLMediaElement.readyState. */
  readyState: number;
  currentTime: number;
  /** Monotonic time in ms. */
  now: number;
  /** The element reports at least 0.5 s buffered at the playhead. */
  hasData: boolean;
  /** A shifted buffer has no native data at the playhead (a hole the shift explains). */
  holeByShift: boolean;
}

/**
 * Where the watchdog last saw the playhead move.
 */
export interface FreezeState {
  ct: number;
  since: number;
}

/**
 * The watchdog's verdict on one sample.
 */
export interface FreezeVerdict {
  /** State to keep for the next sample; null when the element is not playing. */
  state: FreezeState | null;
  /** The lead must come off. */
  freeze: boolean;
}

/**
 * Judges whether playback froze because of the shift: stuck for
 * {@link FREEZE_MS} while playing, with data at the playhead (so the stall is
 * not the network) or with a hole only the shift explains. Paused, seeking,
 * ended and empty elements are never judged.
 * @param prev - The state from the previous sample, or null
 * @param s - This sample
 * @returns The verdict
 */
export function freezeVerdict(prev: FreezeState | null, s: FreezeSample): FreezeVerdict {
  if (s.paused || s.seeking || s.ended || s.readyState === 0) return { state: null, freeze: false };
  let st = prev ?? { ct: s.currentTime, since: s.now };
  if (Math.abs(s.currentTime - st.ct) > 0.01) st = { ct: s.currentTime, since: s.now };
  if (s.now - st.since > FREEZE_MS && (s.hasData || s.holeByShift)) {
    return { state: null, freeze: true };
  }
  return { state: st, freeze: false };
}

/**
 * The dead-man switch: counts time without a valid command from the
 * extension, but only time during which the page's own timers ran on
 * schedule. A hidden, throttled page may run its timers once a minute, and
 * the relay's re-sends with them, so a long gap between two checks counts as
 * at most {@link DEAD_MAN_MAX_STEP_MS}.
 */
export class DeadMan {
  private silentMs = 0;
  private lastCheck: number | null = null;

  /**
   * Records a valid command.
   * @param now - Monotonic time in ms
   */
  heard(now: number): void {
    this.silentMs = 0;
    this.lastCheck = now;
  }

  /**
   * Advances the silence count.
   * @param now - Monotonic time in ms
   * @returns True once the silence passed {@link DEAD_MAN_MS}
   */
  check(now: number): boolean {
    if (this.lastCheck !== null) {
      this.silentMs += Math.min(Math.max(0, now - this.lastCheck), DEAD_MAN_MAX_STEP_MS);
    }
    this.lastCheck = now;
    return this.silentMs > DEAD_MAN_MS;
  }
}
