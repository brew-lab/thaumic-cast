---
'@thaumic-cast/extension': patch
---

fix(extension): show each audio setting only where it does something

The Audio settings now show a control only for casts it affects. With browser-wide capture on, casts go out
as PCM whatever Quality is chosen, and the page now says so; the choice is kept for when browser-wide capture is off.
Smoothing is shown for every PCM cast, which includes any cast under browser-wide capture: it was hidden there with a
compressed Quality while still being applied, and the popup's link to it led nowhere. Frame size is hidden under
browser-wide capture, where it is fixed at 10 ms; the stored value is kept. Bit depth appears only for FLAC, the one
codec with more than one. When the browser will not encode the exact codec, bitrate, sample rate and channels a
Quality or a Bespoke choice asks for, the page says so there, instead of the cast failing to start. No stored setting
or default has changed, and a tab cast sends what it sent before.
