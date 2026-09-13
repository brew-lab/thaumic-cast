---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): recover audio quality after stalls instead of skipping until restart

After any underrun the cadence stream resumed on the very first frame, leaving the jitter buffer empty; with browser
(WASAPI) capture delivering exactly one packet per tick it could never refill, so every later hiccup was an audible
skip until the app was restarted. Playback is now held on silence until the queue is back at the configured jitter
depth, with a timeout of twice that depth counted from when frames resume, and frames that arrived just before a
tick no longer count as an underrun. On Windows, audio the engine discarded (`DATA_DISCONTINUITY`, measured from the
device position and bounded by wall-clock time) is backfilled with the same duration of silence starting with a
fade-out, packets flagged silent are zero-filled, and the first packet after a loss is faded in. Stream summaries now
report `rebuffers`.
