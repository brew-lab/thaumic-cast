import { describe, expect, it } from 'bun:test';
import type { AppType } from '@thaumic-cast/protocol';

import {
  captureToggleState,
  companionCapability,
  type CaptureCompanion,
  type CaptureToggleState,
} from './capture-capability';
import en from '../locales/en.json';

const strings = en as Record<string, string>;

/** The four companions the control has to be right about. */
const COMPANIONS: Record<string, CaptureCompanion> = {
  unknown: { connected: false, appType: null, browserCapture: null },
  'desktop-local': { connected: true, appType: 'desktop', browserCapture: true },
  'desktop-remote': { connected: true, appType: 'desktop', browserCapture: false },
  server: { connected: true, appType: 'server', browserCapture: false },
};

function toggle(stored: 'tab' | 'browser', companion: CaptureCompanion): CaptureToggleState {
  const appType: AppType | null = companion.connected ? companion.appType : null;
  return captureToggleState(stored, appType, companionCapability(companion));
}

describe('companionCapability', () => {
  it('should know nothing about a companion that is not connected', () => {
    expect(
      companionCapability({ connected: false, appType: 'server', browserCapture: false }),
    ).toEqual({});
  });

  it('should take the companion at its word when it reports the capability', () => {
    expect(companionCapability(COMPANIONS['desktop-local']!)).toEqual({ browserCapture: true });
    expect(companionCapability(COMPANIONS['desktop-remote']!)).toEqual({ browserCapture: false });
    expect(companionCapability(COMPANIONS.server!)).toEqual({ browserCapture: false });
  });

  it('should treat a companion that does not report the capability as unknown, unless it is a server', () => {
    expect(
      companionCapability({ connected: true, appType: 'desktop', browserCapture: null }),
    ).toEqual({});
    expect(companionCapability({ connected: true, appType: null, browserCapture: null })).toEqual(
      {},
    );
    expect(
      companionCapability({ connected: true, appType: 'server', browserCapture: null }),
    ).toEqual({ browserCapture: false });
  });
});

describe('captureToggleState', () => {
  const EXPECTED: Record<'tab' | 'browser', Record<string, CaptureToggleState>> = {
    tab: {
      unknown: { visible: true, disabled: false, noteKeys: [] },
      'desktop-local': { visible: true, disabled: false, noteKeys: [] },
      'desktop-remote': {
        visible: true,
        disabled: true,
        noteKeys: ['capture_mode_unavailable_desktop'],
      },
      server: { visible: false, disabled: true, noteKeys: [] },
    },
    browser: {
      unknown: { visible: true, disabled: false, noteKeys: [] },
      'desktop-local': { visible: true, disabled: false, noteKeys: [] },
      'desktop-remote': {
        visible: true,
        disabled: false,
        noteKeys: ['capture_mode_unavailable_desktop', 'capture_mode_untick'],
      },
      server: {
        visible: true,
        disabled: false,
        noteKeys: ['capture_mode_unavailable_server', 'capture_mode_untick'],
      },
    },
  };

  for (const stored of ['tab', 'browser'] as const) {
    for (const [name, companion] of Object.entries(COMPANIONS)) {
      it(`should show the right control with ${stored} stored and a companion that is ${name}`, () => {
        expect(toggle(stored, companion)).toEqual(EXPECTED[stored][name]!);
      });
    }
  }

  it('should never disable a control that is ticked, so it can always be unticked', () => {
    for (const companion of Object.values(COMPANIONS)) {
      const state = toggle('browser', companion);
      expect(state.visible).toBe(true);
      expect(state.disabled).toBe(false);
    }
  });

  it('should leave the control alone against a desktop app that does not report the capability', () => {
    const old: CaptureCompanion = { connected: true, appType: 'desktop', browserCapture: null };
    expect(toggle('tab', old)).toEqual({ visible: true, disabled: false, noteKeys: [] });
  });

  it('should name the companion when its type is unknown and it reports it cannot capture', () => {
    const untyped: CaptureCompanion = { connected: true, appType: null, browserCapture: false };
    expect(toggle('tab', untyped)).toEqual({
      visible: true,
      disabled: true,
      noteKeys: ['capture_mode_unavailable_companion'],
    });
  });

  it('should have a string for every note it can show', () => {
    const untyped: CaptureCompanion = { connected: true, appType: null, browserCapture: false };
    const keys = [...Object.values(COMPANIONS), untyped].flatMap((companion) =>
      (['tab', 'browser'] as const).flatMap((stored) => toggle(stored, companion).noteKeys),
    );
    for (const key of keys) {
      expect(strings[key]).toBeString();
    }
  });
});
