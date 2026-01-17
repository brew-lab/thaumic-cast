---
'@thaumic-cast/desktop': patch
---

Start minimized to system tray when launched via autostart

When the app is launched with the `--minimized` flag (automatically passed by the autostart plugin), the main window is now hidden on startup, leaving only the system tray icon visible. On macOS, the dock icon is also hidden in this mode.

This provides a seamless auto-start experience where the app runs in the background without interrupting the user's workflow.
