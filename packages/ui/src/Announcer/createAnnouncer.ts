import { ANNOUNCE_GAP_MS } from '../tokens';

/** Options for {@link Announcer.say}. */
export interface SayOptions {
  /**
   * The identity of what is said, such as a notice id. A message with a key that has been
   * said before on this surface is never said again.
   */
  key?: string;
  /**
   * Use the assertive region. Only for a danger banner arriving after open, a room's
   * failure line and a CastBar failure (DESIGN.md A-announcer).
   */
  urgent?: boolean;
}

/** The surface's announcer: says results and new problems to screen readers. */
export interface Announcer {
  /**
   * Says a message once.
   * @param message - The words to say
   * @param options - Dedupe key and urgency
   */
  say(message: string, options?: SayOptions): void;
}

/** A live region the announcer writes into: anything with `textContent`. */
export interface LiveRegion {
  /** The region's text. */
  textContent: string | null;
}

/** The scheduling the announcer needs, so tests can drive it. */
export interface AnnouncerClock {
  /** Runs a callback on the next frame. */
  nextFrame(callback: () => void): void;
  /** Runs a callback after a delay in ms. */
  after(ms: number, callback: () => void): void;
}

const browserClock: AnnouncerClock = {
  nextFrame: (cb) => {
    requestAnimationFrame(() => cb());
  },
  after: (ms, cb) => {
    setTimeout(cb, ms);
  },
};

/** The announcer's controls, for its provider. */
export interface AnnouncerController extends Announcer {
  /** Starts accepting messages. Until then (the surface opening) nothing is said. */
  open(): void;
  /** Stops saying anything, for an unmounted surface. */
  close(): void;
}

/**
 * Creates the announcer for one surface, writing into a polite and an assertive region.
 *
 * - Nothing is said until `open()`: the provider calls it a frame after it mounts, so what
 *   is on screen when the surface opens is never read out.
 * - Each message empties its region, then writes the words on the next frame, so the same
 *   words can be said twice in a row when the caller means it.
 * - Messages queue `ANNOUNCE_GAP_MS` apart, so two results never cut each other off.
 * - A `key` that has been said is never said again.
 * @param regions - The polite and assertive live regions
 * @param regions.polite - The `role="status"` region
 * @param regions.assertive - The `role="alert"` region
 * @param clock - Frame and timer scheduling; the browser's by default
 * @returns The announcer and its open and close controls
 */
export function createAnnouncer(
  regions: { polite: LiveRegion; assertive: LiveRegion },
  clock: AnnouncerClock = browserClock,
): AnnouncerController {
  const queue: { message: string; urgent: boolean }[] = [];
  const saidKeys = new Set<string>();
  let isOpen = false;
  let busy = false;

  const next = (): void => {
    const item = queue.shift();
    if (!item || !isOpen) {
      busy = false;
      return;
    }
    busy = true;
    const region = item.urgent ? regions.assertive : regions.polite;
    region.textContent = '';
    clock.nextFrame(() => {
      if (!isOpen) return;
      region.textContent = item.message;
      clock.after(ANNOUNCE_GAP_MS, next);
    });
  };

  return {
    say(message, { key, urgent = false } = {}) {
      if (!isOpen || !message) return;
      if (key !== undefined) {
        if (saidKeys.has(key)) return;
        saidKeys.add(key);
      }
      queue.push({ message, urgent });
      if (!busy) next();
    },
    open() {
      isOpen = true;
    },
    close() {
      isOpen = false;
      queue.length = 0;
      busy = false;
    },
  };
}
