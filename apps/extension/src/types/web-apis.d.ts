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
