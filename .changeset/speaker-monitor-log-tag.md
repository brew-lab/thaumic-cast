---
'@thaumic-cast/core': patch
---

refactor(core): every speaker monitor log line now starts with [SpeakerMonitor]

The speaker monitor wrote some log lines under `[SpeakerMonitor]` and others under the old name `[LatencyMonitor]`,
so one grep did not find them all. The 27 lines below now start with `[SpeakerMonitor]`. Only the tag changed: the
rest of each line, its level and when it is written are the same. A grep, filter or alert on `[LatencyMonitor]`
needs to look for `[SpeakerMonitor]` instead. No other tag was renamed.

From `services/speaker_monitor/monitor.rs`:

- `Busy; topology change for {} not added to its timeline`
- `Invalid speaker IP: {}`
- `Background task started`
- `Shutting down`
- `Video sync requested before the speaker's first fetch: stream={}, speaker={}`
- `Stopped monitoring: stream={}, speaker={}`
- `Stopped all monitoring for stream={}`
- `No valid position for {}s: stream={}, speaker={}, epoch={}`
- `{}: GENA transport state stale; using polled state`
- `Ended monitoring ({}): stream={}, speaker={}`
- `Connection registered: stream={}, speaker={}, epoch=#{}, {}`
- `speaker={}: {} position polls in a row failed ({}); polling every {}s until it answers`
- `Failed to get position from {}: {}`
- `speaker={}: answering position polls again after {} failures`
- `Failed to get transport state from {}: {}`
- `stream={}, speaker={}: playing something else ({}); not polling it until it fetches the stream again`
- `Waiting for stream {} (current URI: {})`
- `URI matched: {} contains {}`
- `poll stream={}, speaker={}: rel={}ms rtt={}ms delivered=...`
- `speaker={}: {} ({}), poll not measured`
- `stream={}, speaker={}: latency={}ms, jitter={}ms, confidence={}`

From `services/speaker_monitor/session.rs`:

- `Epoch changed {} -> {}, resetting (seeding with {}ms)`

From `services/speaker_monitor/session/video_sync.rs`:

- `Track restart: reltime {} -> {}, maintaining ~{}ms latency (offset={}ms)`
- `stream={}ms, sonos={}ms (continuous={}ms, offset={}ms), latency={}ms`
- `stream={}, speaker={}: cushion nearly exhausted ({}ms of audio ahead of the playhead); ...`
- `stream={}, speaker={}: cushion={}ms (last {}ms, ...), trend {}, rtt={}ms`
- `stream={}, speaker={}: cushion shrinking ...ms/min; at this rate the speaker runs dry in ~{} min. ...`
