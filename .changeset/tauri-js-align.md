---
'@thaumic-cast/desktop': patch
---

chore(desktop): bring the Tauri JavaScript packages up to the Rust crates' versions

The desktop app's `@tauri-apps/api` and its shell, log and autostart plugin packages had fallen a few minor versions behind the Rust crates they talk to (for example the API at 2.9 against Tauri 2.12). They now match: API 2.12, shell 2.5, autostart 2.7, log 2.10, and the CLI 2.12.
