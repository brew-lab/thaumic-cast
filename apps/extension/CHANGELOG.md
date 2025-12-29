# @thaumic-cast/extension

## 0.2.0

### Minor Changes

- [#5](https://github.com/brew-lab/thaumic-cast/pull/5) [`1f32958`](https://github.com/brew-lab/thaumic-cast/commit/1f32958fb07f8580f36ce118d98fd9597d0244c6) Thanks [@skezo](https://github.com/skezo)! - Reduced audio encoder memory allocations — Audio encoders (AAC, Vorbis, FLAC) now use pre-allocated buffers for format conversion, reducing per-frame allocations from 2-4 down to 1. This prevents GC-induced stuttering and crackling on low-end devices.

- [#5](https://github.com/brew-lab/thaumic-cast/pull/5) [`1f32958`](https://github.com/brew-lab/thaumic-cast/commit/1f32958fb07f8580f36ce118d98fd9597d0244c6) Thanks [@skezo](https://github.com/skezo)! - Increase ring buffer from 1 second to 2 seconds, providing more headroom during CPU spikes and switch WebCodecs `latencyMode` from `realtime` to `quality` for better audio at same bitrate

## 0.1.1

### Patch Changes

- [#2](https://github.com/brew-lab/thaumic-cast/pull/2) [`e9169f5`](https://github.com/brew-lab/thaumic-cast/commit/e9169f5094b25262f7f376b82954d46160ca9f40) Thanks [@skezo](https://github.com/skezo)! - Fix runtime errors and audio streaming issues
  - Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
  - Fix TypeScript types to match Rust backend ZoneGroup structure
  - Fix undefined coordinator access causing infinite re-render loop
  - Fix AudioWorkletNode not connected to audio graph, preventing audio capture
  - Fix codec mismatch in WebSocket handshake causing wrong Content-Type for Sonos
  - Fix XML escaping in SOAP/DIDL to escape all 5 XML special characters (was missing " and ')
