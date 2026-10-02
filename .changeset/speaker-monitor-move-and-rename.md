---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
---

refactor(core,server): move the speaker monitor loop into its module and name it SpeakerMonitor

An internal restructuring with no behaviour change. The polling loop that watches speakers lived in
`services/latency_monitor.rs` under the name `LatencyMonitor`, apart from the rest of the speaker monitor. It is now
`services/speaker_monitor/monitor.rs` and the type is `SpeakerMonitor`. Settings, environment variables, events and
the text of every log line are the same.

One thing differs in the logs: lines emitted from this file now print the module path
`thaumic_core::services::speaker_monitor::monitor` instead of `thaumic_core::services::latency_monitor`. A grep or a
log-level filter on the module path needs updating; a grep on `[SpeakerMonitor]` does not.
