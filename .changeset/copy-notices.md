---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

fix(extension,desktop): reword the speaker notices and the late-audio notice

The notices that appear when a speaker cuts out, nearly cuts out, runs low or has a fast clock now say what happened
first, with the figures, and end on what to set: "Kitchen cut out: the Wi-Fi stalled for 600 ms, and a 500 ms head
start lasts 500 ms. Set it to 750 ms." The notice for audio reaching the companion late is reworded the same way. The
unplayed audio at a speaker is called its reserve throughout, and both buttons now read "Open Settings". Nothing about
when a notice appears has changed.
