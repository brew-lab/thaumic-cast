---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): treat a connection's declared end as an end, not a stall

Each PCM connection now knows where the speaker takes it to end (the WAV header plus its data size, or less with a
declared length or a test cap). From 2 s before that end until the connection closes, the speaker monitor samples no
acknowledgement lag, measures no stall, decides no notice (head start ran out or close, running low, drift) and warns
of nothing, the link verdict is not judged, and drift correction holds; the report line says `end=declared`. An end
there is logged as `HTTP stream ended normally at its declared end` with the declared length, not as a stall, and the
monitor's connection summary says the same. A speaker still reading a minute past its declared end is not honouring
it, and is measured as before. This guards the segment ends the continuation work adds, and fixes the end line of a
cast to a Playbar that reached the 4 GiB WAV length after 6h12m: it read on about 9 s past the length, hung up, and
was logged as `(stalled)`.

It does not remove the `head_start_ran_out` notice ("Wi-Fi held back 505 ms") raised in that cast. That came from a
report about 8 s before the end: a single 88 ms acknowledgement lag on a reserve drift had drained to 83 ms, on a
link judged poor, which the notice read as Wi-Fi holding back the whole head start. It is a separate problem.
