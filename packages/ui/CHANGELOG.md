# @thaumic-cast/ui

## 0.0.5

### Patch Changes

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674) Thanks [@skezo](https://github.com/skezo)! - ### Bug Fixes
  - **SpeakerMultiSelect**: Allow deselecting all speakers. Previously the last selected speaker's checkbox was disabled to prevent empty selection. Now all checkboxes behave consistently, and the Cast button disables when no speakers are selected.
  - **Speaker Selection**: Fix auto-reselection bug where clearing all speakers would immediately re-select the first one. Auto-selection now only occurs on initial load.
  - **Speaker Ordering**: Sort speaker groups alphabetically by name for consistent UI ordering. Previously order could vary depending on which speaker responded to topology queries.
  - **Speaker Selection Persistence**: Remember selected speakers across popup opens. Selection is stored in chrome.storage.local (device-specific). On load, validates saved IPs against available speakers and falls back to auto-select if speakers are no longer available.

  ### Features
  - **Multi-Speaker Volume Controls**: When multiple speakers are selected, show labeled volume controls for each speaker instead of just the first one. Each control displays the speaker name and allows independent volume/mute adjustment before casting.

## 0.0.4

### Patch Changes

- [#28](https://github.com/brew-lab/thaumic-cast/pull/28) [`21e4991`](https://github.com/brew-lab/thaumic-cast/commit/21e4991c5769c6d50b7cff677d05245fb6021afa) Thanks [@skezo](https://github.com/skezo)! - Fix SoC and DRY violations across extension and UI packages

  **Extension:**
  - Fix connection state sync after service worker wake-up
  - Unify connection state to single source of truth
  - Centralize discovery/connection logic in background
  - Centralize stop-cast cleanup in stopCastForTab
  - Move i18n translations to presentation layer
  - Use validated settings module for init functions
  - Extract codec cache to shared module

  **UI:**
  - Remove hardcoded English defaults from ActionButton labels for i18n support

## 0.0.3

### Patch Changes

- [#26](https://github.com/brew-lab/thaumic-cast/pull/26) [`7af7ee1`](https://github.com/brew-lab/thaumic-cast/commit/7af7ee150acabc9812cf74bd8d1c9edd1e8edded) Thanks [@skezo](https://github.com/skezo)! - Extract component styles to CSS modules for better encapsulation
  - Move component-specific styles from theme.css to dedicated CSS module files
  - Add IconButton `solid` variant for filled background buttons
  - Fix ToggleSwitch contrast to meet WCAG 2.1 AA using relative color syntax
  - Fix SpeakerMultiSelect to prevent deselecting the last remaining item

## 0.0.2

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714) Thanks [@skezo](https://github.com/skezo)! - Add video sync opt-in feature with per-cast toggle
  - Add global video sync setting in Options (under Advanced section)
  - Add per-cast video sync toggle in ActiveCastCard popup UI
  - Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
  - Status chip backgrounds use dominant artwork color for visual cohesion
  - Fix re-acquire loop caused by coarse alignment triggering play event
  - Disable video sync automatically when cast stops
  - Prevent log spam when video sync enabled on page without video element
