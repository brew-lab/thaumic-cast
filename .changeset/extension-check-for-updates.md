---
'@thaumic-cast/extension': patch
---

feat(extension): check for updates from Settings › About

Settings › About now has Check for updates, as the desktop app does. Installed from a store, the extension asks the store at once rather than waiting for the browser's next round, and says what it found: the latest version, a version that is ready, or that it checked a moment ago. A version that is ready comes with Restart the extension, which applies it, and which waits while anything is casting, since a restart would stop the casts. Loaded by hand from the release zip, the extension never updates itself, so the button opens the releases page instead.
