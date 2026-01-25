---
'@thaumic-cast/ui': patch
---

Fix volume slider jumping from stale server responses

Add interaction cooldown to the VolumeControl component that blocks external volume updates while the user is actively dragging the slider. Previously, server round-trip responses could override user input mid-drag, causing the slider to jump unexpectedly.

- Track interaction state from pointer down through a 500ms cooldown after release
- Queue external volume updates during interaction and apply after cooldown expires
- Handle edge cases: pointer cancel, keyboard input, release without value change
