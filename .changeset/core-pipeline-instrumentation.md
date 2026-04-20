---
'@thaumic-cast/core': minor
---

Add core-side pipeline instrumentation timeline for post-session diagnostics

`LoggingStreamGuard` now accumulates per-tick pipeline snapshots (receive jitter from `StreamState`, cadence buffer health, HTTP delivery stats) and serializes them alongside the existing stream summary on drop. Snapshots land in a `Mutex`-guarded buffer so a mid-loop cadence abort (typical when Sonos closes HTTP) preserves the timeline instead of losing it.

The cadence stream holds `Weak<StreamState>` rather than `Arc` so instrumentation does not prolong stream lifetime after cleanup; snapshots are skipped when the upgrade fails.

Complements the extension-side metric timeline already shipped with the MSTP worker infrastructure — the two halves now cover all six pipeline stages end-to-end.
