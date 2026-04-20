---
'@thaumic-cast/protocol': minor
'@thaumic-cast/shared': minor
'@thaumic-cast/core': minor
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': minor
'@thaumic-cast/server': minor
---

Exchange version metadata in the WebSocket handshake so the extension can warn users when their desktop app or server is out of date.

- `WsHandshakeAckPayload` now carries optional `protocolVersion`, `appVersion`, and `appType` fields populated by the companion (desktop or headless server).
- `thaumic-core` exposes a new `AppInfo` / `AppType` pair passed to `AppState::new`, and populates the three new fields every time it sends a handshake ACK. Both `apps/desktop` and `apps/server` thread their own `env!("CARGO_PKG_VERSION")` through.
- The extension compares the reported `protocolVersion` against `MIN_COMPATIBLE_PROTOCOL_VERSION` on connect and surfaces a dismissible warning Alert in the popup when the companion is out of date. The Alert's action button deep-links to the GitHub releases page; dismissal is persisted per companion `appVersion` in `chrome.storage.local`, so upgrading (or downgrading to a new version) re-arms the warning.
- Extension options now show the connected companion's version info in the About section; the desktop Settings page gains a matching About section.
- Older companions predating this change omit the new fields; the extension treats absence as "unknown, assume compatible" rather than erroring, so users on old builds are not disrupted. Unknown `appType` values (e.g. a future `"cli"`) degrade to `undefined` via `.catch()` on the schema, so a newer companion can't break an older extension either.

No new remote calls are introduced — the check runs entirely off the local handshake, preserving the privacy promise in PRIVACY.md.
