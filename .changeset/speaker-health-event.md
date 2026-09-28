---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/desktop': patch
---

feat(core): report each monitored speaker's buffer health to the client casting to it

The speaker monitor measured how much audio each fetching speaker held ahead of its playhead, how fast its clock
drained that, and when the reserve ran low, but only the log could see it. The server now sends a speakerHealth
network event with the state (locking, ok, draining, low, paused, stale or dormant), the reserve and its precision,
the lowest and 10th-percentile acknowledged reserve over the window, the target the low state is judged against, the
clock rate and the projected time to empty. It goes out with every 30 s report and at once when the state changes,
only while the speaker is monitored, and only to the client that owns the stream while it is live. The desktop app
relays it to its frontend as a speaker-health event. Drift compensation is not built yet, so the event carries no
compensation fields; they can be added later without breaking older clients.
