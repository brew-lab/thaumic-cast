---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

Polish the companion version-mismatch surface introduced in the previous release.

- Prevent the out-of-date warning Alert from briefly flashing on every initial connection. The popup was flipping `phase` to `'connected'` optimistically on `WS_STATE_CHANGED` before the async fetch that carries the companion metadata resolved, so `protocolVersion` was transiently `null` and the mismatch helper would light up the Alert for a single render. The connection-status hook now only transitions to `'connected'` via the metadata-bearing `CACHED_STATE_RECEIVED`, applying phase and metadata atomically. The companion-version hook additionally gates on `phase === 'connected'` so no flash window can open between discovery and WebSocket `INITIAL_STATE`.
- Gate the Alert on the persisted dismissal record having loaded, closing a smaller race where a previously-dismissed warning briefly reappeared on popup open before `chrome.storage.local` resolved.
- Rename the protocol line in the extension About card and the desktop Settings About card from `Protocol v{{version}}` to `Protocol · Version {{version}}`, matching the adjacent `Desktop App · Version {{version}}` / `Version {{version}}` format.
