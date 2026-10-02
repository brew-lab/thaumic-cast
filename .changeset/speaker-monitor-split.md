---
'@thaumic-cast/core': patch
---

refactor(core): split the speaker monitor's loop from the per-speaker session it keeps

An internal restructuring with no behaviour change. `services/speaker_monitor/monitor.rs` held both the polling loop
and everything the loop keeps about each speaker. The loop stays there; the per-speaker session moves to `session.rs`,
and its parts to `session/video_sync.rs`, `session/report.rs`, `session/drift.rs` and `session/health.rs`. Code moved
as it was: settings, environment variables, events and the text of every log line are the same.

One thing differs in the logs, again: a line prints the module path of the file it is now in. Lines that printed
`thaumic_core::services::speaker_monitor::monitor` now print that or one of
`thaumic_core::services::speaker_monitor::session`, `...::session::video_sync`, `...::session::report`,
`...::session::drift` and `...::session::health`. The 30 s report line, for one, now comes from
`...::session::report`. A grep or a log-level filter on the module path needs updating; a grep on `[SpeakerMonitor]`
does not.
