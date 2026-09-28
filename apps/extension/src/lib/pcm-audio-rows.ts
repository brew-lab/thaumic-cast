/**
 * PCM Audio Rows
 *
 * The rows the options page adds to its audio summary for a PCM stream: the
 * sample rate (which follows the capture device), the smoothing, the speaker
 * head start the companion sends, and the delay the two add together. Kept
 * free of i18n so the choice of wording can be tested.
 */

import type { AppType, CompanionAudio } from '@thaumic-cast/protocol';
import type { NoticeLine } from './speaker-notices';

/** One row of the audio summary, as i18n keys. */
export interface AudioSummaryRow {
  /** Stable key for rendering. */
  key: string;
  /** i18n key of the row's label. */
  labelKey: string;
  /** The row's value. */
  value: NoticeLine;
}

/** What the PCM rows depend on besides the smoothing. */
export interface PcmRowsContext {
  /** The companion's speaker-side settings; null when it does not report them. */
  companionAudio: CompanionAudio | null;
  /** Which companion is connected; null when unknown. */
  appType: AppType | null;
}

/**
 * Words the speaker head start the companion sends, naming where it is set.
 * @param ctx - The companion's settings and type
 * @returns The value to show, or the neutral wording when it is unknown
 */
export function headStartValue(ctx: PcmRowsContext): NoticeLine {
  const audio = ctx.companionAudio;
  if (!audio) return { key: 'audio_head_start_value_unknown' };
  if (audio.headStartMs === 0) return { key: 'audio_head_start_value_off' };
  if (ctx.appType === 'desktop') {
    return { key: 'audio_head_start_value_desktop', params: { value: audio.headStartMs } };
  }
  if (ctx.appType === 'server') {
    return { key: 'audio_head_start_value_server', params: { value: audio.headStartMs } };
  }
  return { key: 'audio_head_start_value_unknown' };
}

/**
 * Builds the summary rows specific to a PCM stream.
 *
 * The added delay is smoothing plus head start; Sonos adds its own on top. It
 * is left out when the head start is unknown, rather than understated.
 *
 * @param smoothingMs - The smoothing the stream runs with, in ms
 * @param ctx - The companion's settings and type
 * @returns The rows, in display order
 */
export function pcmAudioRows(smoothingMs: number, ctx: PcmRowsContext): AudioSummaryRow[] {
  const rows: AudioSummaryRow[] = [
    {
      key: 'sample-rate',
      labelKey: 'audio_sample_rate',
      value: { key: 'audio_sample_rate_follows_capture' },
    },
    {
      key: 'smoothing',
      labelKey: 'audio_smoothing',
      value: { key: 'audio_option_ms', params: { value: smoothingMs } },
    },
    { key: 'head-start', labelKey: 'audio_head_start', value: headStartValue(ctx) },
  ];

  if (ctx.companionAudio) {
    rows.push({
      key: 'added-delay',
      labelKey: 'audio_added_delay',
      value: {
        key: 'audio_added_delay_value',
        params: { value: smoothingMs + ctx.companionAudio.headStartMs },
      },
    });
  }

  return rows;
}
