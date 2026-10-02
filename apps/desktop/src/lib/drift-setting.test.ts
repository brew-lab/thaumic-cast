import { describe, expect, it } from 'bun:test';

import en from '../locales/en.json';
import {
  driftModeForToggle,
  driftModeLabelKey,
  driftToggleState,
  offersDriftCorrection,
} from './drift-setting';

const strings = en as Record<string, string>;
const translate = (key: string): string => strings[key] ?? key;

describe('driftToggleState', () => {
  it('should tick the toggle only for on, and leave it free while the monitor is on', () => {
    expect(driftToggleState({ mode: 'on', envOverride: null }, true, translate)).toEqual({
      checked: true,
      disabled: false,
      hint: null,
    });
    expect(driftToggleState({ mode: 'observe', envOverride: null }, true, translate).checked).toBe(
      false,
    );
    expect(driftToggleState({ mode: 'off', envOverride: null }, true, translate).checked).toBe(
      false,
    );
  });

  it('should disable the toggle without the monitor, and say why', () => {
    const state = driftToggleState({ mode: 'on', envOverride: null }, false, translate);
    expect(state.disabled).toBe(true);
    expect(state.checked).toBe(false);
    expect(state.hint?.key).toBe('settings.drift_needs_monitor');
  });

  it('should disable the toggle while its settings load', () => {
    expect(driftToggleState(null, true, translate).disabled).toBe(true);
    expect(driftToggleState({ mode: 'on', envOverride: null }, null, translate).disabled).toBe(
      true,
    );
  });

  it('should show what the environment variable set, by name', () => {
    const state = driftToggleState({ mode: 'on', envOverride: 'observe' }, true, translate);
    expect(state).toEqual({
      checked: false,
      disabled: true,
      hint: { key: 'settings.drift_env', params: { label: 'watch only' } },
    });
    const forced = driftToggleState({ mode: 'observe', envOverride: 'on' }, true, translate);
    expect(forced.checked).toBe(true);
  });
});

describe('driftModeForToggle', () => {
  it('should save observe for off, never off itself', () => {
    expect(driftModeForToggle(true)).toBe('on');
    expect(driftModeForToggle(false)).toBe('observe');
  });
});

describe('offersDriftCorrection', () => {
  it('should offer correction only where the user can turn it on here', () => {
    expect(offersDriftCorrection({ mode: 'observe', envOverride: null })).toBe(true);
    expect(offersDriftCorrection({ mode: 'off', envOverride: null })).toBe(true);
    expect(offersDriftCorrection({ mode: 'on', envOverride: null })).toBe(false);
    expect(offersDriftCorrection({ mode: 'observe', envOverride: 'observe' })).toBe(false);
    expect(offersDriftCorrection(null)).toBe(false);
  });
});

describe('strings', () => {
  it('should have every string the toggle uses', () => {
    for (const mode of ['on', 'observe', 'off'] as const) {
      expect(strings[driftModeLabelKey(mode)]).toBeString();
    }
    for (const key of ['settings.drift', 'settings.drift_description', 'settings.drift_env']) {
      expect(strings[key]).toBeString();
    }
    expect(strings['settings.drift_needs_monitor']).toBeString();
  });
});
