/**
 * Build-time flag for audio diagnostics.
 *
 * When true (development builds), enables:
 * - Per-sample clipping detection in AudioWorklet
 * - Verbose audio pipeline tracing
 *
 * In production builds, this is `false` and all guarded code is
 * eliminated by dead-code removal, resulting in zero runtime overhead.
 *
 * @see vite.config.ts for the define configuration
 */
declare const __DEBUG_AUDIO__: boolean;
