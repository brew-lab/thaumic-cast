# @thaumic-cast/desktop

## 0.3.0

### Minor Changes

- [#7](https://github.com/brew-lab/thaumic-cast/pull/7) [`b354fbf`](https://github.com/brew-lab/thaumic-cast/commit/b354fbfcf4b7611042611fafa6f91d747034c321) Thanks [@skezo](https://github.com/skezo)! - Add native power state detection and battery-aware audio config
  - Desktop app now detects system power state using native OS APIs (starship-battery)
  - Power state is sent to extension via WebSocket, bypassing browser Battery API limitations
  - Extension automatically selects lower-quality audio config when on battery to prevent audio dropouts
  - Added audio pipeline monitoring to detect silent failures and source starvation
  - Session health tracking reports audio drops for config learning

## 0.1.1

### Patch Changes

- [#2](https://github.com/brew-lab/thaumic-cast/pull/2) [`e9169f5`](https://github.com/brew-lab/thaumic-cast/commit/e9169f5094b25262f7f376b82954d46160ca9f40) Thanks [@skezo](https://github.com/skezo)! - Fix runtime errors and audio streaming issues
  - Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
  - Fix TypeScript types to match Rust backend ZoneGroup structure
  - Fix undefined coordinator access causing infinite re-render loop
  - Fix AudioWorkletNode not connected to audio graph, preventing audio capture
  - Fix codec mismatch in WebSocket handshake causing wrong Content-Type for Sonos
  - Fix XML escaping in SOAP/DIDL to escape all 5 XML special characters (was missing " and ')
