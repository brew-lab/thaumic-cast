/**
 * Type extensions for Chrome-specific Web APIs not included in standard TypeScript definitions.
 */

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
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<AudioData>;
}
