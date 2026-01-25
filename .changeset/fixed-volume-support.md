---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': minor
'@thaumic-cast/ui': minor
---

Add fixed volume detection for Sonos speakers with line-level output

Sonos devices like CONNECT and Port have fixed line-level output where volume cannot be adjusted via API. This change detects and handles these speakers:

- Parse `OutputFixed` from GENA GroupRenderingControl notifications
- Propagate `fixed` state through the event system alongside volume updates
- Disable volume controls in the UI for fixed-output speakers
- Add `disabled` prop to `VolumeControl` and `SpeakerVolumeRow` components

When a speaker has fixed volume, the volume slider and mute button are visually disabled and non-interactive.
