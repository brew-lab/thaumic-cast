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
