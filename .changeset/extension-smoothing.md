---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

feat(extension): recast PCM audio options around smoothing

The network buffer is now called smoothing, which is what it does: the Thaumic Cast desktop app or server holds that
much audio back to even out how it arrives from this browser. It does nothing for a speaker's own Wi-Fi, which the
speaker head start covers, and a companion on the same machine gains nothing from more of it; the notice about audio
arriving late says when more would help. Smoothing (100, 200, 300 or 500 ms) and frame size are now standalone PCM
settings under Audio > Advanced, shown in every mode rather than only in Bespoke, and the quality mode no longer
changes them. Existing settings move over once: a Bespoke value is kept, snapped to the nearest step (1000 ms becomes
500 ms); the Luxurious and Sensible presets, which ran with 500 ms, move to 300 ms; and Economical keeps 200 ms. When
the value changes, the options page says so once. For PCM, the sample rate select is gone, since PCM always goes out
at the rate the browser captures, and the summary reads "Matches the audio device". It also shows the speaker head
start the desktop app or server sends and the delay smoothing and head start add together. The protocol gains the
smoothing default and steps, and the streaming policy no longer carries a jitter buffer. The onboarding note on
expectations now says audio reaches the speakers about a second after the browser plays it.
