---
'@thaumic-cast/desktop': patch
---

Update @tauri-apps/cli to match tauri crate version

CLI 2.9.6 could not locate the `__TAURI_BUNDLE_TYPE` marker embedded by tauri crate 2.10.2, causing a build warning and breaking the updater plugin's bundle type detection.
