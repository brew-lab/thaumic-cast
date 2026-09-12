---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): recover audio quality after stalls instead of skipping until restart

After any underrun the cadence stream resumed on the very first frame, leaving the jitter buffer empty; with browser
(WASAPI) capture delivering exactly one packet per tick it could never refill, so every later hiccup was an audible
skip until the app was restarted. Playback is now held on silence until the queue is back at the configured jitter
depth (bounded by twice that time), a consumer stall that already overflowed the queue is resynced to the target
depth instead of replaying missed ticks as a burst, and frames that arrived just before a tick no longer count as an
underrun. On Windows, audio the engine discarded (`DATA_DISCONTINUITY`, from the device position) is backfilled with
the same duration of silence, packets flagged silent are zero-filled, and the first packet after a loss is faded in.
Stream summaries now report `rebuffers` and `resyncs`.
