/**
 * Video Sync View
 *
 * What a cast's video sync row offers to do, worked out from the status the
 * background keeps (DESIGN.md M-videosync). Pure, so the popup and its tests
 * share one rule.
 */

import type { VideoSyncPhase, VideoSyncReason } from '@thaumic-cast/protocol';

/** The one action the row can offer: reload the cast's page, or try the early sound again. */
export type VideoSyncActionKind = 'reload' | 'try-again';

/**
 * Picks the row's action. A page open before video sync was on needs a
 * reload (only while it cannot sync, so a stale reason left over while
 * locking on again offers nothing); a player that turned the early sound
 * off can be asked to try again; nothing else has an action.
 * @param phase - Where video sync stands, or undefined until the background answers
 * @param reason - Why, when it is unavailable or turned off
 * @returns The action, or undefined for none
 */
export function videoSyncAction(
  phase: VideoSyncPhase | undefined,
  reason: VideoSyncReason | undefined,
): VideoSyncActionKind | undefined {
  if (phase === 'unavailable' && reason === 'reload') return 'reload';
  if (phase === 'turned-off') return 'try-again';
  return undefined;
}

/**
 * The locale key of a reason's sentence.
 * @param reason - The reason
 * @returns Its key, such as `video_sync_reason_pcm_only`
 */
export function videoSyncReasonKey(reason: VideoSyncReason): string {
  return `video_sync_reason_${reason.replace(/-/g, '_')}`;
}
