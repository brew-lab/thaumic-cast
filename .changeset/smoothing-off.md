---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(extension): let smoothing be off

Smoothing now has an Off step below 100 ms, for anyone who wants the least delay. With it off the companion holds no
audio back: each piece plays as soon as it arrives, and a late one is a moment of silence instead. Nothing behind a late
piece is thrown away, so the delay then grows by that silence and settles at what the connection needs. The added delay
in the Audio readout is then the speaker head start alone. If audio arrives late twice in a minute, the popup suggests
the smoothing that would have covered it, as before. The default stays 200 ms, and a stored setting is never turned off
by the settings migration. The companion's queue keeps room for at least 300 ms of audio whatever the smoothing, so
with smoothing off a speaker's Wi-Fi stall still replays the audio it held up rather than silence; every smoothing from
100 ms up behaves as before.
