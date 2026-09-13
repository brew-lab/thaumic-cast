---
'@thaumic-cast/core': patch
---

fix(core): remove a stutter at stream start and stop removed streams lingering

Frames were added to the buffer and broadcast in two steps, so a speaker connecting in between received the newest
buffered frame twice and stuttered as playback began. The send now happens with the buffer, so the two cannot
interleave. Separately, the HTTP response held the stream strongly, so a removed stream kept its channel alive and
kept emitting silence until the speaker disconnected, leaking the connection entirely if the stop request failed.
The response now holds the stream weakly and ends when it is gone.
