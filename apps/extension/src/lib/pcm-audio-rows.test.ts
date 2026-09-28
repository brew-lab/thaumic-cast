import { describe, expect, it } from 'bun:test';
import type { CompanionAudio } from '@thaumic-cast/protocol';

import en from '../locales/en.json';
import { headStartValue, pcmAudioRows, type PcmRowsContext } from './pcm-audio-rows';

const AUDIO: CompanionAudio = { headStartMs: 500, headStartFixed: false, speakerMonitor: true };

function ctx(fields: Partial<PcmRowsContext> = {}): PcmRowsContext {
  return { companionAudio: AUDIO, appType: 'desktop', ...fields };
}

describe('pcmAudioRows', () => {
  it('should show the head start and the added delay', () => {
    const rows = pcmAudioRows(200, ctx());

    expect(rows.map((row) => row.key)).toEqual([
      'sample-rate',
      'smoothing',
      'head-start',
      'added-delay',
    ]);
    expect(rows.find((row) => row.key === 'added-delay')?.value).toEqual({
      key: 'audio_added_delay_value',
      params: { value: 700 },
    });
  });

  it('should say the sample rate matches the audio device', () => {
    expect(pcmAudioRows(200, ctx())[0]?.value.key).toBe('audio_sample_rate_follows_capture');
  });

  it('should add only the smoothing when the head start is off', () => {
    const rows = pcmAudioRows(300, ctx({ companionAudio: { ...AUDIO, headStartMs: 0 } }));

    expect(rows.find((row) => row.key === 'head-start')?.value.key).toBe(
      'audio_head_start_value_off',
    );
    expect(rows.find((row) => row.key === 'added-delay')?.value.params).toEqual({ value: 300 });
  });

  it('should leave out the added delay when the head start is unknown', () => {
    const rows = pcmAudioRows(200, ctx({ companionAudio: null }));

    expect(rows.map((row) => row.key)).not.toContain('added-delay');
    expect(rows.find((row) => row.key === 'head-start')?.value.key).toBe(
      'audio_head_start_value_unknown',
    );
  });

  it('should use keys that exist in the locale', () => {
    const strings = en as Record<string, string>;
    for (const row of pcmAudioRows(200, ctx())) {
      expect(strings[row.labelKey]).toBeDefined();
      expect(strings[row.value.key]).toBeDefined();
    }
  });
});

describe('headStartValue', () => {
  it('should name where the head start is set by companion type', () => {
    expect(headStartValue(ctx())).toEqual({
      key: 'audio_head_start_value_desktop',
      params: { value: 500 },
    });
    expect(headStartValue(ctx({ appType: 'server' }))).toEqual({
      key: 'audio_head_start_value_server',
      params: { value: 500 },
    });
    expect(headStartValue(ctx({ appType: null })).key).toBe('audio_head_start_value_unknown');
  });

  it('should show a head start up to 2000 ms as it is', () => {
    expect(headStartValue(ctx({ companionAudio: { ...AUDIO, headStartMs: 2000 } }))).toEqual({
      key: 'audio_head_start_value_desktop',
      params: { value: 2000 },
    });
  });

  it('should call the setting plain smoothing', () => {
    const strings = en as Record<string, string>;
    for (const key of ['audio_smoothing', 'audio_smoothing_hint', 'audio_smoothing_migrated']) {
      expect(strings[key]).not.toMatch(/browser smoothing|server smoothing/i);
    }
    expect(strings.audio_smoothing).toBe('Smoothing');
  });
});
