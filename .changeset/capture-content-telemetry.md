---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
---

feat(core): measure what captured audio contains and allow tapping it to disk

Every captured packet is now inspected and a summary is logged every five seconds: peak, level, packets with holes of
silence inside audio, packets identical to the one before, silent packets and clipping, with a warning when the audio
has holes in it. Timing counters cannot see this; a source that starves still delivers the right number of samples on
time. Setting `THAUMIC_CAPTURE_TAP_DIR` writes everything pushed into the pipeline to a WAV file per stream so a failed
session can be listened to afterwards, and setting `THAUMIC_NO_PRIORITY_BOOST` leaves the process and its audio threads
at default scheduling, to test whether the boost is starving the browser being captured on a small machine.
