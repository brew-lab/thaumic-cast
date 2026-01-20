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

UX improvements:

- Add 48px touch target to volume slider for better accessibility (WCAG 2.5.5)
- Add CSS tokens for slider dimensions, touch target size, and muted state opacity
- Disable text selection on interactive controls (volume, speaker rows, popup header/footer)
- Allow text selection only on track info sections (title, subtitle)
- Use semantic CSS tokens for disabled/muted opacity states
