---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): treat a connection's declared end as an end, not a stall

A PCM cast to a Playbar that reached the 4 GiB length in its WAV header after 6h12m raised a head-start notice
("Wi-Fi held back 505 ms") just before it stopped: the speaker had read the whole item and stopped reading, and the
speaker monitor took the acknowledgements stalling for Wi-Fi trouble. Each PCM connection now knows where the speaker
takes it to end (the WAV header plus its data size, or less with a declared length or a test cap). From 2 s before
that end until the connection closes, the speaker monitor samples no acknowledgement lag, measures no stall, decides no
notice (head start ran out or close, running low, drift) and warns of nothing, the link verdict is not judged, and
drift correction holds; the report line says `end=declared`. An end there is logged as `HTTP stream ended normally at
its declared end` with the declared length, never as a stall, and the monitor's connection summary says the same. A
speaker still reading a minute past its declared end is not honouring it, and is measured as before.
