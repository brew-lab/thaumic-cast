---
'@thaumic-cast/protocol': minor
'@thaumic-cast/shared': minor
'@thaumic-cast/core': minor
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': minor
'@thaumic-cast/server': minor
'@thaumic-cast/ui': patch
---

Exchange companion version metadata over the existing connection so the extension can warn users when their desktop app or server is out of date.

- `/health` now reports `appType` alongside the existing service identifier and stream limit. The extension reads it at discovery time so it knows which companion it's talking to before the WebSocket even connects.
- The WebSocket `INITIAL_STATE` payload — sent on every connect, including the always-on control connection — now carries `appType`, `appVersion`, and `protocolVersion`. The extension persists these into the existing `connectionState` store; there is no separate companion-info storage.
- `thaumic-core` exposes a new `AppInfo` / `AppType` pair passed to `AppState::new`. `apps/desktop` and `apps/server` each thread their own `env!("CARGO_PKG_VERSION")` through.
- The extension compares the reported `protocolVersion` against `MIN_COMPATIBLE_PROTOCOL_VERSION` on every connect:
  - Renders a dismissible warning Alert in the popup with an "Update Desktop App" / "Update Server" / "Update" action button (chosen from `appType`) deep-linking to the GitHub releases page.
  - Renders a persistent inline "Update available" link in the popup footer and in the options About section, even after the Alert has been dismissed, so the user always has a path to the releases page.
  - Dismissal is keyed by `appVersion` (or `null` for pre-0.4.0 companions) in `chrome.storage.local`, so rolling forward — including from "unknown" to a real version — re-arms the warning.
- The popup footer copy is type-aware: "Connected to Desktop App", "Connected to Server", or just "Connected" when the type is unknown.
- Older companions that omit the new fields are treated as out-of-date (not "assume compatible"), since the extension may have been auto-updated by Chrome ahead of the user updating the companion. The Alert and footer link still appear; copy degrades gracefully ("Your app predates this extension and can't report its version").
- Shared UI: new `link` variant on `<Button>` for inline text-link CTAs.

No new remote calls are introduced — the check runs entirely off discovery and the existing WebSocket, preserving the privacy promise in PRIVACY.md.
