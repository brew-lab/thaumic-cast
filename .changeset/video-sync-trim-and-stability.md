---
'@thaumic-cast/extension': patch
---

fix(extension): apply the video sync offset and stop the loop fighting itself

The offset slider was stored but never used in the delay calculation. The sync loop's own seeks and pauses also
triggered the handlers that drop the lock, so it re-acquired repeatedly, and alignment could start again while a
previous one was still waiting. Programmatic adjustments are now recognised and ignored, with a seek matched against
where the video actually landed so a real seek by the viewer is still honoured, and alignment cannot overlap.

Known limitation: on sites that override playback rate, where the extension falls back to brief pauses, an offset
change that needs the video to move forward is not applied to a running lock and takes effect at the next re-sync.
