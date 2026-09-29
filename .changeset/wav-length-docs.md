---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
---

docs(core): describe the 0xFFFFFFFF WAV header as a 4 GiB length

The 0xFFFFFFFF in both WAV header size fields of a PCM stream was documented as the conventional marker for an
unbounded stream. A Playbar (S2 86.10) treats it as a length: a chunked cast stopped at exactly 2^32 bytes, 6h12m50s at
48 kHz stereo, with the speaker hanging up and going to STOPPED with no reconnect and no `Range` request. The code
comments, the server README and the architecture notes now say so, and that a cast goes on past it only through PCM
segment continuation, which follows in this series.
