---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
---

feat(core): add THAUMIC_DRIFT_FORCE_PPM for blind listening tests of the rate adapter

Set to a number from -300 to 300, it fixes every monitored speaker's PCM rate adapter at exactly that many ppm,
whatever the drift correction mode and the controller say. It is read for each connection, each connection it applies
to logs a warning that it is for listening tests only, and the 30 s `[SpeakerMonitor]` line shows `forced=` (with
`(pinned)` once the 2 s insertion limit holds the adapter at 0 ppm). The drift controller does not learn while a rate
is forced. A value that is not a number in range is ignored with a warning, logged once per value, and with it unset
nothing changes.
