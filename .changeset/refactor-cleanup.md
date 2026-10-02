---
'@thaumic-cast/core': patch
---

refactor(core): finish the speaker monitor rename and move the settings' names into model

An internal tidy-up after the refactor, with no behaviour change. The field that holds the speaker monitor is now
called `speaker_monitor` everywhere, not `latency_monitor`. The environment variable names for speaker monitoring and
drift correction, and the parser for the monitoring switch, now live in `model` beside the other setting types, so
the code that resolves the companion settings no longer reaches up into the services for them; the old paths still
work. The crate's module list, the rule for what `model` may use, and a few broken documentation links were corrected
to match the code.
