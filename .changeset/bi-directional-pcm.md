---
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': minor
---

Add bi-directional playback control between extension and Sonos

When casting, playback state now syncs in both directions:

- **Sonos → Browser**: Pause/play on Sonos remote or app controls the browser tab
- **Browser → Sonos**: Play in browser (YouTube controls, keyboard shortcuts) resumes Sonos

Technical improvements:

- Use per-speaker epoch tracking for accurate resume detection
- Delegate playback decisions to server for consistent state handling
- Send Play command unless speaker is definitively playing (handles cache misses)
- Deduplicate Play commands on PCM resume to prevent audio glitches
- Add error handling for broker failures during playback notifications
