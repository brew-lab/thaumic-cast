---
'@thaumic-cast/desktop': patch
---

Bump Cargo dependencies. `cargo update` for in-range patch/minor bumps across the workspace (tokio 1.49 → 1.52, tauri 2.10.2 → 2.10.3, rustls 0.23.36 → 0.23.38, etc.). Two direct major bumps: `mdns-sd` 0.17 → 0.19 (used by `thaumic-core` for Sonos discovery and `thaumic-cast-desktop` for service advertisement; APIs we use are unchanged) and `rust-i18n` 3 → 4 (used by the desktop tray menu). The `rust-i18n` 4 macro expands to code stable in Rust 1.80, so the desktop crate's `rust-version` is bumped from 1.77 → 1.80.
