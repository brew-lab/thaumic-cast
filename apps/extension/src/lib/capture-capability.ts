/**
 * Capture Capability
 *
 * What the extension knows about the companion's ability to capture the whole
 * browser, and what that means for the browser-wide capture control. The cast
 * handler and the options page both read it from here.
 */

import type { AppType } from '@thaumic-cast/protocol';
import type { CompanionCapability } from './audio-resolver';
import type { ExtensionSettings } from './settings';

/** What is known about the companion, as the connection state holds it. */
export interface CaptureCompanion {
  /** Whether a companion is connected. Nothing is known about one that is not. */
  connected: boolean;
  /** Which companion it is; null when it does not say. */
  appType: AppType | null;
  /** Whether it says it would capture the whole browser; null when it does not say. */
  browserCapture: boolean | null;
}

/**
 * Works out whether the companion can capture the whole browser.
 *
 * The companion's own answer wins. A server that predates the answer still
 * cannot capture: only the desktop app ever could. Anything else is unknown.
 *
 * @param companion - What the connection state holds about the companion
 * @returns The capability, with `browserCapture` undefined when unknown
 */
export function companionCapability(companion: CaptureCompanion): CompanionCapability {
  if (!companion.connected) return {};
  if (companion.browserCapture !== null) return { browserCapture: companion.browserCapture };
  return companion.appType === 'server' ? { browserCapture: false } : {};
}

/** How the browser-wide capture control is shown. */
export interface CaptureToggleState {
  /** Whether the control is shown at all. */
  visible: boolean;
  /** Whether the control is disabled. Only ever true while it is unticked. */
  disabled: boolean;
  /** Keys of the sentences shown under the control, in order. */
  noteKeys: string[];
}

/**
 * Decides how the browser-wide capture control is shown.
 *
 * A companion that can capture, or one nothing is known about, leaves the
 * control as it is. Against a companion known not to capture, the control
 * cannot be turned on and says why; a control that is already on stays
 * enabled so it can always be turned off; and it is hidden only when it is
 * off and the companion is a server, which never captures.
 *
 * @param stored - The stored capture mode
 * @param appType - Which companion is connected; null when unknown
 * @param capability - What the companion can do
 * @returns Whether the control shows, whether it is disabled, and its notes
 */
export function captureToggleState(
  stored: ExtensionSettings['captureMode'],
  appType: AppType | null,
  capability: CompanionCapability,
): CaptureToggleState {
  if (capability.browserCapture !== false) {
    return { visible: true, disabled: false, noteKeys: [] };
  }

  const reason =
    appType === 'server'
      ? 'capture_mode_unavailable_server'
      : appType === 'desktop'
        ? 'capture_mode_unavailable_desktop'
        : 'capture_mode_unavailable_companion';

  if (stored === 'browser') {
    return { visible: true, disabled: false, noteKeys: [reason, 'capture_mode_untick'] };
  }
  if (appType === 'server') {
    return { visible: false, disabled: true, noteKeys: [] };
  }
  return { visible: true, disabled: true, noteKeys: [reason] };
}
