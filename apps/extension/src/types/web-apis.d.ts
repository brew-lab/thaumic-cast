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

/**
 * Initialization options for MediaStreamTrackProcessor.
 * @see https://www.w3.org/TR/mediacapture-transform/#dom-mediastreamtrackprocessorinit
 */
interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  /** Maximum number of frames to buffer before dropping oldest. */
  maxBufferSize?: number;
}

/**
 * Breaks a MediaStreamTrack into individual frames exposed as a ReadableStream.
 * Chrome 94+, unflagged. Works on main thread and offscreen documents.
 * @see https://www.w3.org/TR/mediacapture-transform/#mediastreamtrackprocessor
 */
declare class MediaStreamTrackProcessor {
  /** Creates a processor that exposes frames from `init.track` as a ReadableStream. */
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<AudioData>;
}

interface Document {
  /**
   * Starts a view transition, capturing the current state and animating to the new state.
   * @param callback - Function that updates the DOM to the new state
   * @returns ViewTransition object for controlling the transition
   */
  startViewTransition?(callback: () => void | Promise<void>): ViewTransition;
}
