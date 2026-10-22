/** Where a CopyField is (DESIGN.md P-copy). */
export type CopyResult = 'idle' | 'done' | 'refused' | 'unavailable';

/**
 * What a copy came to. With no text there was nothing to copy, whatever the clipboard said;
 * with text, the clipboard either took it (done) or refused it (the field is revealed).
 * @param outcome - Whether the clipboard write resolved or rejected
 * @param text - The text that was to be copied, or null when there was none
 * @returns The result to show
 */
export function copyResultFor(outcome: 'copied' | 'refused', text: string | null): CopyResult {
  if (!text) return 'unavailable';
  return outcome === 'copied' ? 'done' : 'refused';
}

/**
 * The text a CopyField shows. A given value is what people read, and copying never changes
 * it, even when what goes to the clipboard is longer (the Server's Address shows
 * `host:port` and copies the `http://` URL; §11 call 94). With no value (a card's Copy URL),
 * the text that was copied is shown, so a refused copy can be finished by hand.
 * @param value - The text given to show, if any
 * @param copied - The text the last copy wrote, or tried to, if any
 * @returns The text to show
 */
export function shownCopyText(value: string | undefined, copied: string | null): string {
  return value || copied || '';
}
