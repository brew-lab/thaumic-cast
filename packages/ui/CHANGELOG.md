# @thaumic-cast/ui

## 0.1.0

### Minor Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`070afca`](https://github.com/brew-lab/thaumic-cast/commit/070afca65cc5c323aa0cc2e57117be1e846d04ed) Thanks [@skezo](https://github.com/skezo)! - fix(ui): WCAG 2.1 AA accessibility improvements

  **SpeakerMultiSelect**
  - Replace incorrect `role="listbox"` with semantic `<fieldset>` and native checkboxes
  - Use `<label>` wrapping for proper accessible names

  **VolumeControl**
  - Add `:focus-visible` styling for slider thumbs (webkit + moz)
  - Use logical properties consistently (`block-size` instead of `height`)

  **Disclosure**
  - Add `aria-controls` and `aria-describedby` (only when elements exist in DOM)
  - Add `aria-hidden` to decorative chevron icon

  **StatusChip**
  - Add Lucide icons to convey status without relying on color alone (WCAG 1.4.1)

  **Button/IconButton**
  - Fix disabled state contrast using `opacity` + `grayscale` filter to preserve variant identity

  **ToggleSwitch**
  - Make `aria-label` a required prop for WCAG 4.1.2 compliance

  **Wizard**
  - Use `aria-labelledby` to reference step title

  **Alert**
  - Add `aria-hidden="true"` to dismiss button icon

  **Card**
  - Add `titleLevel` prop for configurable heading hierarchy

  **SpeakerVolumeRow**
  - Add `role="group"` with `aria-label` for speaker context
  - Make label props required for proper i18n support

  **Extension**
  - Add interpolated i18n keys for speaker-specific accessible labels

### Patch Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00) Thanks [@skezo](https://github.com/skezo)! - Convert CSS module classes from camelCase to kebab-case
  - Updated all CSS module class selectors to use kebab-case naming convention
  - Updated corresponding TSX imports to use bracket notation for kebab-case properties
  - Enforced by new stylelint selector-class-pattern rule

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123) Thanks [@skezo](https://github.com/skezo)! - Add manual server configuration to onboarding and new Disclosure component
  - When auto-discovery fails during onboarding, users can now manually configure the server URL
  - Added collapsible Disclosure component to shared UI package
  - Extracted testServerConnection utility for connection testing
  - Fixed WizardStep content padding to prevent focus outline clipping

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12) Thanks [@skezo](https://github.com/skezo)! - Add manual speaker IP entry for networks where discovery fails
  - Users can manually enter Sonos speaker IP addresses when SSDP/mDNS discovery fails (VPNs, firewalls, network segmentation)
  - IPs are probed to verify they're valid Sonos devices before being saved
  - Manual speakers are merged with auto-discovered speakers during topology refresh
  - Added Input component to shared UI package
  - Manual entry available in onboarding SpeakerStep and Settings view

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
