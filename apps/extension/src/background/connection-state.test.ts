import { beforeEach, describe, expect, it } from 'bun:test';

import { resetChromeStub } from '../test-support/chrome-stub';
import { clearConnectionState, getConnectionState, setDesktopApp } from './connection-state';

const DESKTOP = 'http://localhost:49400';
const SERVER = 'http://192.168.1.20:49400';

beforeEach(() => {
  resetChromeStub();
  clearConnectionState();
});

describe('the capture capability in the connection state', () => {
  it('should be unknown until a companion reports it', () => {
    expect(getConnectionState().browserCapture).toBeNull();

    setDesktopApp(DESKTOP, 10, 'desktop');

    expect(getConnectionState().browserCapture).toBeNull();
  });

  it('should record what the companion reports', () => {
    setDesktopApp(DESKTOP, 10, 'desktop', true);
    expect(getConnectionState().browserCapture).toBe(true);

    setDesktopApp(DESKTOP, 10, 'desktop', false);
    expect(getConnectionState().browserCapture).toBe(false);
  });

  it('should keep the answer when the same companion is set again without one', () => {
    setDesktopApp(DESKTOP, 10, 'desktop', true);

    setDesktopApp(DESKTOP, 10);

    expect(getConnectionState().browserCapture).toBe(true);
  });

  it('should forget the answer when the companion is at another address', () => {
    setDesktopApp(DESKTOP, 10, 'desktop', true);

    setDesktopApp(SERVER, 10, 'server');

    expect(getConnectionState().browserCapture).toBeNull();
  });

  it('should forget the answer when the companion is lost', () => {
    setDesktopApp(DESKTOP, 10, 'desktop', true);

    clearConnectionState();

    expect(getConnectionState().browserCapture).toBeNull();
  });
});
