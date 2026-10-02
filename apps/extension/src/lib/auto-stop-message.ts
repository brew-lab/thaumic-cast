/**
 * Picks the wording for a speaker that left a cast without being asked to.
 *
 * The same reason reads differently by what became of the cast. When the last
 * speaker left, the cast ended, and the line may say "Cast again." When other
 * speakers remain, the cast is still running, so the line says it carries on
 * and sends nobody to start another.
 */

import type { CastAutoStopReason } from './message-schemas';

/**
 * The i18n key for an auto-stop or speaker-removal reason. Both sets of keys
 * take the speaker's `{{name}}`.
 * @param reason - Why the speaker left, or why the cast ended
 * @param castCarriesOn - True when other speakers are still playing the cast
 * @returns `speaker_removed_<reason>` while the cast carries on, else `auto_stop_<reason>`
 */
export function autoStopMessageKey(reason: CastAutoStopReason, castCarriesOn: boolean): string {
  return castCarriesOn ? `speaker_removed_${reason}` : `auto_stop_${reason}`;
}
