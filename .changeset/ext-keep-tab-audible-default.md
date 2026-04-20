---
'@thaumic-cast/extension': patch
---

Default `keepTabAudible` on and declare AUDIO_PLAYBACK intent for the offscreen document

Flips the `keepTabAudible` setting default from `false` to `true` so Chrome treats the offscreen document as an active audio page, preventing AudioContext suspension and aggressive timer throttling on constrained devices. Also adds `chrome.offscreen.Reason.AUDIO_PLAYBACK` alongside `USER_MEDIA` so the offscreen document's lifecycle intent matches what it actually does.

Users who had previously toggled this setting off manually will keep their preference (only the default changes).
