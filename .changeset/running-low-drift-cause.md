---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

feat(core): say when clock drift made a speaker run low

On a long cast the drift notice came first and running low then replaced it for the rest of the cast, saying only
how much audio the speaker had left: the cause and the remedy were gone. A running-low notice now carries
`cause: "drift"` when the speaker's clock is measurably draining the reserve, net of any correction, by at least
5 ppm, has drained at least half of what the reserve lost since it settled, and no stall or poor link explains the
loss. The popup and the dashboard then add that the speaker plays slightly faster than the audio
arrives, offer clock drift correction where it is not on (as the drift notice does), and keep the restart advice.
