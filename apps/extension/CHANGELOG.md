# @thaumic-cast/extension

## 0.5.0

### Minor Changes

- [#15](https://github.com/brew-lab/thaumic-cast/pull/15) [`f65dae0`](https://github.com/brew-lab/thaumic-cast/commit/f65dae0711e26bf2682b604474125b70dc28820e) Thanks [@skezo](https://github.com/skezo)! - ### Theme System
  - Add dark/light mode support with automatic system preference detection
  - Adopt mystical violet OKLCH color palette with semantic token layers
  - Add motion tokens with reduced-motion support

  ### Internationalization
  - Add i18n framework with English translations for desktop and extension
  - Detect system/browser language preferences automatically

  ### Multi-Group Casting
  - Add UI to select and cast to multiple Sonos speaker groups simultaneously

  ### Onboarding
  - Add first-time user onboarding wizard with platform-specific firewall instructions
  - Defer network services until firewall warning is acknowledged

  ### Network Health Monitoring
  - Detect VPN/network issues that prevent speaker communication
  - Show contextual warnings when speakers aren't responding
  - Improve error messaging for no-speakers-found state

  ### ActiveCastCard Redesign
  - Redesign with artwork background and dynamic color extraction
  - Add playback controls (play/pause, stop)
  - Add view transitions for track changes
  - Make title clickable to navigate to source tab

  ### Shared UI Components
  - Add VolumeControl with fill indicator and mute button
  - Add IconButton component
  - Add Alert component with error/warning/info variants and dismiss support

  ### Accessibility
  - Improve WCAG 2.1 AA compliance across extension UI
  - Ensure proper contrast ratios for all text elements

  ### Fixes
  - Stop speakers immediately when stream ends
  - Switch speakers to queue after stopping stream
  - Clean up existing stream when starting playback on same speaker
  - Sync transport state for stream recovery
  - Reconnect when server settings change
  - Use static branding in DIDL-Lite metadata

## 0.4.1

### Patch Changes

- [#13](https://github.com/brew-lab/thaumic-cast/pull/13) [`4d7d238`](https://github.com/brew-lab/thaumic-cast/commit/4d7d238e381441988da6254205a23283746ad353) Thanks [@skezo](https://github.com/skezo)! - Refactor popup UI to integrate controls into media cards
  - Move speaker selection, volume controls, and cast button into CurrentTabCard
  - Add volume controls and stop button to ActiveCastCard
  - Remove separate "Cast settings" card for cleaner UI
  - Reorder layout: Active Casts now appear above Current Tab

## 0.4.0

### Minor Changes

- [#11](https://github.com/brew-lab/thaumic-cast/pull/11) [`5b6d1f2`](https://github.com/brew-lab/thaumic-cast/commit/5b6d1f2022a200c08357f7eb40c294d5aa58a9e6) Thanks [@skezo](https://github.com/skezo)! - Add settings page with audio presets and server configuration
  - Add options page with server, audio, language, and about sections
  - Create preset resolution system that integrates runtime codec detection
  - Support auto/low/mid/high/custom audio modes with fallback chains
  - Add server auto-discover with manual URL override option
  - Move audio configuration from popup to dedicated settings page
  - Use shared UI components (Card, Button) from @thaumic-cast/ui
  - Replace console.\* with shared logger throughout extension

## 0.3.1

### Patch Changes

- [#9](https://github.com/brew-lab/thaumic-cast/pull/9) [`9751058`](https://github.com/brew-lab/thaumic-cast/commit/9751058c2b06c0e40d48e3b0aecd5cfe410be3e5) Thanks [@skezo](https://github.com/skezo)! - Fix automated release workflow
  - Change changesets config from `linked` to `fixed` to ensure both packages always version together
  - Add version mismatch detection in release-pr workflow
  - Fix missing Linux build dependencies in release workflow
  - Add `tauriScript` config for bun in tauri-action
  - Use `workflow_call` to trigger release builds automatically (no PAT required)

## 0.3.0

### Minor Changes

- [#7](https://github.com/brew-lab/thaumic-cast/pull/7) [`b354fbf`](https://github.com/brew-lab/thaumic-cast/commit/b354fbfcf4b7611042611fafa6f91d747034c321) Thanks [@skezo](https://github.com/skezo)! - Add native power state detection and battery-aware audio config
  - Desktop app now detects system power state using native OS APIs (starship-battery)
  - Power state is sent to extension via WebSocket, bypassing browser Battery API limitations
  - Extension automatically selects lower-quality audio config when on battery to prevent audio dropouts
  - Added audio pipeline monitoring to detect silent failures and source starvation
  - Session health tracking reports audio drops for config learning

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
