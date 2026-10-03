/**
 * What the status badge on a speaker card reads, worked out from the speaker's
 * transport state and whether one of our casts is on it.
 */

/** How the badge is coloured: our cast, something else holding the speaker, or neither. */
export type SpeakerBadgeTone = 'casting' | 'busy' | 'idle';

/** The badge's label, as an i18n key with a fallback, and its tone. */
export interface SpeakerBadge {
  /** The i18n key of the label. */
  key: string;
  /** What to show if the key has no entry, such as a state the core added later. */
  defaultValue: string;
  /** How the badge is coloured. */
  tone: SpeakerBadgeTone;
}

/**
 * Works out the speaker card's badge.
 *
 * Our own cast keeps its reading. When the speaker is playing something else,
 * the badge says it is in use rather than "Playing", which read as if it were
 * ours. "Loading" stays as it is: when we start a cast the speaker can report
 * it before the card knows the cast is ours, and calling that "In use" would
 * flash amber over our own start.
 * @param transportState - The transport state the core reports, such as "Playing"
 * @param isCasting - Whether one of our casts is on this speaker
 * @returns The badge, or null when there is no state to show
 */
export function speakerBadge(
  transportState: string | undefined,
  isCasting: boolean,
): SpeakerBadge | null {
  if (!transportState) return null;
  const isPlaying = transportState === 'Playing';
  if (isCasting && isPlaying) {
    return { key: 'device.streaming', defaultValue: transportState, tone: 'casting' };
  }
  if (!isCasting && isPlaying) {
    return { key: 'transport.in_use', defaultValue: transportState, tone: 'busy' };
  }
  return {
    key: `transport.${transportState.toLowerCase()}`,
    defaultValue: transportState,
    tone: 'idle',
  };
}
