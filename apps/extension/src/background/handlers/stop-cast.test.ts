import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig } from '@thaumic-cast/protocol';
import {
  brokerCalls,
  brokerReplies,
  resetBrokerCalls,
} from '../../test-support/offscreen-broker-mock';
import { clearAllSessions, hasSession, registerSession } from '../session-manager';
import { handleStopCast } from './cast';

const ENCODER = createEncoderConfig({ codec: 'pcm' });
const TAB = 21;
const stop = () => handleStopCast({ type: 'STOP_CAST', payload: { tabId: TAB } });

beforeEach(() => {
  resetBrokerCalls();
  clearAllSessions();
  registerSession(TAB, 'stream-stop', ['10.0.0.9'], ['Kitchen'], ENCODER, false, 'tab', false);
});

afterEach(() => {
  clearAllSessions();
});

describe('handleStopCast', () => {
  it('should report success and forget the cast when it stops', async () => {
    expect(await stop()).toEqual({ success: true });
    expect(hasSession(TAB)).toBe(false);
  });

  it('should report the failure and keep the cast when it may still be playing', async () => {
    brokerReplies.stopError = new Error('Offscreen message timed out');
    expect(await stop()).toEqual({ success: false, error: 'Offscreen message timed out' });
    expect(hasSession(TAB)).toBe(true);
  });

  it('should stop the kept cast when Stop is pressed again', async () => {
    brokerReplies.stopError = new Error('Offscreen message timed out');
    await stop();
    brokerReplies.stopError = undefined;
    expect(await stop()).toEqual({ success: true });
    expect(brokerCalls.stoppedTabs).toEqual([TAB, TAB]);
    expect(hasSession(TAB)).toBe(false);
  });
});
