---
'@thaumic-cast/core': patch
---

refactor(core): move the shared vocabulary types to a leaf module

An internal restructuring with no behaviour change. The small types that events carry and the stream path reads
(the drift correction mode, speaker notices, topology member changes, the playout timeline and the PCM connect burst
setting) now live in one module with nothing above it, so the stream and event code no longer import from the
services. Every existing path still works.

One thing differs in the logs: the warning that a PCM connect burst is above the maximum now prints the module path
`thaumic_core::model::head_start` instead of `thaumic_core::stream::cadence`. Its text is the same.
