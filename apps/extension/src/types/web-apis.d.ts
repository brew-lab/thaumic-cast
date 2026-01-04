/**
 * Type extensions for Chrome-specific Web APIs not included in standard TypeScript definitions.
 */

/**
 * Extended AudioEncoderConfig with Chrome's latencyMode support.
 * @see https://www.w3.org/TR/webcodecs/#dom-audioencoderconfig
 */
interface ChromeAudioEncoderConfig extends AudioEncoderConfig {
  /**
   * Hint for encoder optimization.
   * - 'quality': Optimize for quality over latency (default)
   * - 'realtime': Optimize for low latency over quality
   */
  latencyMode?: 'quality' | 'realtime';
}

/**
 * Chrome-specific mandatory constraints for tab audio capture.
 * Used with chrome.tabCapture API stream IDs.
 */
interface ChromeTabCaptureMandatoryConstraints {
  chromeMediaSource: 'tab';
  chromeMediaSourceId: string;
}

/**
 * Audio constraints with Chrome tab capture support.
 */
interface ChromeTabCaptureAudioConstraints extends MediaTrackConstraints {
  mandatory?: ChromeTabCaptureMandatoryConstraints;
}

/**
 * MediaStreamConstraints extended for Chrome tab capture.
 */
interface ChromeTabCaptureConstraints extends MediaStreamConstraints {
  audio: ChromeTabCaptureAudioConstraints | boolean;
}

/**
 * View Transition API types (Chrome 111+)
 * @see https://developer.chrome.com/docs/web-platform/view-transitions/
 */
interface ViewTransition {
  /** Resolves when the transition animation finishes */
  finished: Promise<void>;
  /** Resolves when pseudo-elements are created and animation is about to start */
  ready: Promise<void>;
  /** Resolves when the callback passed to startViewTransition() finishes */
  updateCallbackDone: Promise<void>;
  /** Skips the animation portion of the transition */
  skipTransition(): void;
}

interface Document {
  /**
   * Starts a view transition, capturing the current state and animating to the new state.
   * @param callback - Function that updates the DOM to the new state
   * @returns ViewTransition object for controlling the transition
   */
  startViewTransition?(callback: () => void | Promise<void>): ViewTransition;
}
