# @thaumic-cast/extension

## 0.8.0

### Minor Changes

- [#24](https://github.com/brew-lab/thaumic-cast/pull/24) [`2a2941e`](https://github.com/brew-lab/thaumic-cast/commit/2a2941e97ddd5861b5e13ad35eee09f5dd65a95f) Thanks [@skezo](https://github.com/skezo)! - Sync tab media playback with Sonos transport state - pauses tab when any speaker pauses, resumes when all speakers are playing

## 0.7.0

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`396fc4a`](https://github.com/brew-lab/thaumic-cast/commit/396fc4ac72ab8123bf8205db2fc0d68af9354472) Thanks [@skezo](https://github.com/skezo)! - Improve video sync with SE-based stability and event handling
  - Use standard error (SE) for stability gate instead of raw stdev - converges properly under RelTime quantization
  - Add p10 estimator with adaptive floor for lock latency selection
  - Add video event listeners for re-acquire on seeked, waiting, stalled, pause, play
  - Use persisted stall check (400ms) to avoid transient re-acquires from adaptive streaming hiccups
  - Add sync jump detection logging for debugging
  - Use requestVideoFrameCallback (RVFC) for frame-accurate sync when available
  - Add playbackRate fighting detection with automatic pause mode fallback
  - Record coarse alignment anchors at pause start (not after wait) to fix double-delay bug

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714) Thanks [@skezo](https://github.com/skezo)! - Add video sync opt-in feature with per-cast toggle
  - Add global video sync setting in Options (under Advanced section)
  - Add per-cast video sync toggle in ActiveCastCard popup UI
  - Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
  - Status chip backgrounds use dominant artwork color for visual cohesion
  - Fix re-acquire loop caused by coarse alignment triggering play event
  - Disable video sync automatically when cast stops
  - Prevent log spam when video sync enabled on page without video element

- Updated dependencies [[`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714)]:
  - @thaumic-cast/ui@0.0.2
  - @thaumic-cast/protocol@0.1.1

## 0.6.1

## 0.6.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`cf0b867`](https://github.com/brew-lab/thaumic-cast/commit/cf0b867942b54fd1f099d1bc031ebe1cc5f2b860) Thanks [@skezo](https://github.com/skezo)! - Add server-side WAV encoding for lossless audio streaming
  - Add "Lossless (WAV)" codec option that sends raw PCM from browser to desktop app
  - Desktop app wraps PCM in WAV container for true lossless quality
  - Works universally since PCM passthrough has no browser codec dependencies
  - Hide bitrate selector in UI for lossless codecs (no bitrate options)

### Patch Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`18e2e0e`](https://github.com/brew-lab/thaumic-cast/commit/18e2e0e0431c0022f9d382f49ed1228897ea3b41) Thanks [@skezo](https://github.com/skezo)! - Improve audio settings and codec detection
  - Remove legacy AudioSettings code (dead code cleanup)
  - Fix codec detection to run via offscreen document (AudioEncoder not available in service workers)
  - Add latencyMode option to custom audio settings (quality/realtime)
  - Hide latencyMode UI for codecs that don't use WebCodecs (PCM)
  - Default to high quality (lossless) audio mode for lower CPU usage

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`ca0081e`](https://github.com/brew-lab/thaumic-cast/commit/ca0081ef4ceaaad2d3cced16a29be293bcc01e8b) Thanks [@skezo](https://github.com/skezo)! - Improve UI polish with themed scrollbars and better typography
  - Add thin themed scrollbars using `scrollbar-width: thin` and `scrollbar-color` with the primary color for a consistent, subtle appearance
  - Apply `text-wrap: balance` to headings and `text-wrap: pretty` to paragraphs for improved text layout

- Updated dependencies [[`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d)]:
  - @thaumic-cast/protocol@0.1.0

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
