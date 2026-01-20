---
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': patch
'@thaumic-cast/ui': minor
'@thaumic-cast/protocol': minor
---

Add partial speaker removal for multi-group casts

- Add per-speaker remove button (X) to ActiveCastCard, shown only when 2+ speakers
- Send STOP_PLAYBACK_SPEAKER command to remove individual speakers without stopping entire cast
- Track user-initiated vs system removals for accurate analytics (user_removed reason)
- Stop latency monitoring when a speaker is removed
- Add translations for user_removed auto-stop reason
- Sort speakers alphabetically for consistent UI ordering (extension and desktop)
