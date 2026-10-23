import { describe, expect, it } from 'bun:test';
import {
  isAtDefaults,
  resetSettings,
  type ResetActions,
  type ResettableSettings,
  type SpeakerSettingDefaults,
} from './settings-reset';

const defaults: SpeakerSettingDefaults = {
  speakerMonitor: true,
  pcmConnectBurstMs: 500,
  driftCompensation: 'on',
};

const atDefaults: ResettableSettings = {
  autostart: false,
  theme: 'auto',
  diagnostics: false,
  speakerMonitor: { enabled: true, envOverride: null, origin: 'file' },
  headStart: { ms: 500, envOverride: null },
  drift: { mode: 'on', envOverride: null },
};

const changed: ResettableSettings = {
  autostart: true,
  theme: 'dark',
  diagnostics: true,
  speakerMonitor: { enabled: false, envOverride: null, origin: 'file' },
  headStart: { ms: 1500, envOverride: null },
  drift: { mode: 'observe', envOverride: null },
};

/**
 * Actions that record each call and answer as the commands do.
 * @param fail - The action that rejects, if any
 * @returns The actions and the calls they saw
 */
function recorder(fail?: keyof ResetActions): { actions: ResetActions; calls: string[] } {
  const calls: string[] = [];
  const step = <T>(name: keyof ResetActions, value: unknown, answer: T): T => {
    calls.push(`${name}:${String(value)}`);
    if (name === fail) throw new Error(`${name} failed`);
    return answer;
  };
  const actions: ResetActions = {
    setAutostart: async (on) => step('setAutostart', on, undefined),
    setTheme: (theme) => step('setTheme', theme, undefined),
    setDiagnostics: (on) => step('setDiagnostics', on, undefined),
    setSpeakerMonitor: async (on) =>
      step('setSpeakerMonitor', on, { enabled: on, envOverride: null, origin: 'file' as const }),
    setHeadStart: async (ms) => step('setHeadStart', ms, { ms, envOverride: null }),
    setDrift: async (mode) => step('setDrift', mode, { mode, envOverride: null }),
  };
  return { actions, calls };
}

describe('isAtDefaults', () => {
  it('should be true when every setting is at its default', () => {
    expect(isAtDefaults(atDefaults, defaults)).toBe(true);
  });

  it('should be false when any one setting differs', () => {
    for (const key of Object.keys(changed) as (keyof ResettableSettings)[]) {
      expect(isAtDefaults({ ...atDefaults, [key]: changed[key] }, defaults)).toBe(false);
    }
  });

  it('should ignore a setting an environment variable fixes', () => {
    const env: ResettableSettings = {
      ...atDefaults,
      speakerMonitor: { enabled: false, envOverride: false, origin: 'env' },
      headStart: { ms: 0, envOverride: 0 },
      drift: { mode: 'off', envOverride: 'off' },
    };
    expect(isAtDefaults(env, defaults)).toBe(true);
  });
});

describe('resetSettings', () => {
  it('should put every setting back through the same calls a change by hand makes', async () => {
    const { actions, calls } = recorder();
    const next = await resetSettings(changed, defaults, actions);
    expect(next).toEqual(atDefaults);
    expect(calls.sort()).toEqual(
      [
        'setAutostart:false',
        'setTheme:auto',
        'setDiagnostics:false',
        'setSpeakerMonitor:true',
        'setHeadStart:500',
        'setDrift:on',
      ].sort(),
    );
  });

  it('should not touch a setting already at its default', async () => {
    const { actions, calls } = recorder();
    await resetSettings({ ...atDefaults, theme: 'light' }, defaults, actions);
    expect(calls).toEqual(['setTheme:auto']);
  });

  it('should leave a setting an environment variable fixes alone', async () => {
    const { actions, calls } = recorder();
    const fixed: ResettableSettings = {
      ...changed,
      headStart: { ms: 0, envOverride: 0 },
      drift: { mode: 'off', envOverride: 'off' },
    };
    const next = await resetSettings(fixed, defaults, actions);
    expect(calls.some((c) => c.startsWith('setHeadStart') || c.startsWith('setDrift'))).toBe(false);
    expect(next.headStart).toEqual(fixed.headStart);
    expect(next.drift).toEqual(fixed.drift);
  });

  it('should try every setting when one fails, then throw', async () => {
    const { actions, calls } = recorder('setAutostart');
    await expect(resetSettings(changed, defaults, actions)).rejects.toThrow('setAutostart failed');
    expect(calls).toHaveLength(6);
  });
});
