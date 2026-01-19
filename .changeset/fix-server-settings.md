---
'@thaumic-cast/extension': patch
---

fix(extension): improve server URL settings behavior

- Sync URL input with settings when changed externally
- Auto-save and test server URL on blur (skip if clicking test button)
- Allow clearing server URL by emptying the input
- Normalize UI state on load: if manual mode has no URL, show auto-discover (not persisted to avoid storage listener triggers during editing)
