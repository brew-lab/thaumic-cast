---
'@thaumic-cast/desktop': patch
---

feat(desktop): add the speaker head start setting and show speaker notices

Settings > Speakers gains a speaker head start select (Off, 250, 500, 750, 1000, 1500 or 2000 ms; a value set by hand
in settings.json shows as Custom), saved with the other desktop settings and applied from each speaker's next
connection. When `THAUMIC_PCM_CONNECT_BURST_MS` is set, the select shows its value, is disabled, and says why. The
"Keep an eye on speakers" description now says what the monitor measures and that turning it off also turns off
speaker notices. The Speakers view shows the speaker notices the core decides for each speaker playing a stream,
worded as in the extension, with an Open settings button for head-start advice. A notice shows only while its speaker
plays the stream it is about, and the notices clear when speaker monitoring is turned off. A dismissed notice stays
dismissed while it is repeated, and the same head-start advice for the same speaker stays dismissed for 24 hours or
until the app quits, whichever comes first. The onboarding note on expectations now says audio reaches the speakers
about a second after it plays.
