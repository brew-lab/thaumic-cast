---
'@thaumic-cast/core': patch
---

Internal restructuring with no behaviour change: the per-connection delivery tracking that every codec uses (the connection guard, the first-connection wait, the epoch hook and the pipeline snapshot types) moved out of `stream/cadence.rs` into a new `stream/delivery.rs`, leaving the PCM cadence on its own. The connection and first-wait log lines now print the module path `thaumic_core::stream::delivery` instead of `thaumic_core::stream::cadence`; the `[Stream]` and other prefixes inside the messages are unchanged.
