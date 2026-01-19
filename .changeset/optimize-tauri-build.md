---
'@thaumic-cast/desktop': patch
---

Optimize Tauri build configuration and security settings

- Use selective tokio features instead of "full" for smaller binaries
- Enable `removeUnusedCommands` to strip unused IPC commands
- Set default window size to 840×560 with 480×360 minimum
- Add `acceptFirstMouse` and disable `tabbingIdentifier` for macOS
- Disable browser zoom hotkeys (OS-level zoom still available)
- Enable CSP for XSS protection
- Add missing `core:tray:default` and `core:window:default` capabilities
