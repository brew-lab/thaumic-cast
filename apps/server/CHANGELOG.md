# @thaumic-cast/server

## 0.12.0

### Minor Changes

- [#103](https://github.com/brew-lab/thaumic-cast/pull/103) [`153a447`](https://github.com/brew-lab/thaumic-cast/commit/153a44754061c3d57d101d227d4654a863f201d9) Thanks [@skezo](https://github.com/skezo)! - Exchange companion version metadata over the existing connection so the extension can warn users when their desktop app or server is out of date.
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

### Patch Changes

- [#107](https://github.com/brew-lab/thaumic-cast/pull/107) [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95) Thanks [@skezo](https://github.com/skezo)! - Polish the companion version-mismatch surface introduced in the previous release, and unblock the path that was supposed to surface it for older companions.
  - Accept `INITIAL_STATE` payloads that omit `groupVolumeFixed`. That field was added after the initial protocol shipped; older companions don't send it, so the extension's `WS_CONNECTED` route rejected their messages at schema validation — `handleWsConnected` never ran, the popup stayed stuck at "Checking…", and the out-of-date warning (the very UI meant for this scenario) never had a chance to render. The `groupVolumeFixed` field now defaults to an empty map when missing, so older-companion payloads validate and the version-mismatch flow fires as designed.
  - Prevent the out-of-date warning Alert from briefly flashing on every initial connection. The popup was flipping `phase` to `'connected'` optimistically on `WS_STATE_CHANGED` before the async fetch that carries the companion metadata resolved, so `protocolVersion` was transiently `null` and the mismatch helper would light up the Alert for a single render. The connection-status hook now only transitions to `'connected'` via the metadata-bearing `CACHED_STATE_RECEIVED`, applying phase and metadata atomically. The companion-version hook additionally gates on `phase === 'connected'` so no flash window can open between discovery and WebSocket `INITIAL_STATE`.
  - Gate the Alert on the persisted dismissal record having loaded, closing a smaller race where a previously-dismissed warning briefly reappeared on popup open before `chrome.storage.local` resolved.
  - Rename the protocol line in the extension About card and the desktop Settings About card from `Protocol v{{version}}` to `Protocol · Version {{version}}`, matching the adjacent `Desktop App · Version {{version}}` / `Version {{version}}` format.

## 0.11.0

## 0.2.0

### Minor Changes

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`3f07d14`](https://github.com/brew-lab/thaumic-cast/commit/3f07d14365f3798baea4e34c37a42ced545529ad) Thanks [@skezo](https://github.com/skezo)! - Add manual speaker IP management API to standalone server

  **New HTTP Endpoints (thaumic-server)**
  - `POST /api/speakers/manual/probe` - Validate IP and probe for Sonos speaker
  - `POST /api/speakers/manual` - Add manual speaker (probes before persisting)
  - `DELETE /api/speakers/manual/:ip` - Remove manual speaker (with fallback for legacy entries)
  - `GET /api/speakers/manual` - List manual speaker IPs

  **Server Configuration**
  - Add `--data-dir` CLI option and `THAUMIC_DATA_DIR` env var for persistence
  - Add `data_dir` field to config.yaml
  - Return 503 SERVICE_UNAVAILABLE when data_dir not configured

  **Shared Code (thaumic-core)**
  - Add `validate_speaker_ip()` with `IpValidationError` enum
  - Add `ErrorCode` trait implementation for consistent error codes
  - Export `ErrorCode` trait for use by consumers
  - Add `set_app_data_dir(impl AsRef<Path>)` for flexible path passing

  **Desktop Refactoring**
  - Use shared `validate_speaker_ip()` instead of inline validation
  - Import `ErrorCode` trait for IP validation error handling

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`cbbe631`](https://github.com/brew-lab/thaumic-cast/commit/cbbe6312d28c029d6c8f4bd9d716452e2baf9a60) Thanks [@skezo](https://github.com/skezo)! - Add configurable artwork resolution with precedence chain

  **New Artwork Module (thaumic-core)**
  - Add `ArtworkConfig` and `ArtworkSource` types for flexible artwork configuration
  - Support precedence chain: external HTTPS URL > `data_dir/artwork.jpg` > embedded default
  - External URL option enables Android Sonos app compatibility (requires HTTPS)
  - Single `read()` call with `NotFound` handling avoids TOCTTOU race

  **Server Configuration**
  - Add `artwork_url` config option and `THAUMIC_ARTWORK_URL` env var
  - Document artwork precedence in `config.example.yaml`

  **API Changes**
  - Replace `AppStateBuilder::artwork(&[u8])` with `artwork_config(ArtworkConfig)`
  - Add `AppState::artwork_metadata_url()` for Sonos DIDL-Lite metadata
  - Pass artwork URL through `start_playback()` and `start_playback_multi()`

  **Desktop App**
  - Cache resolved `ArtworkSource` to avoid disk I/O on every playback; URL computed on-demand with current IP/port
  - Support custom artwork via `artwork.jpg` in app data directory

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Introduce standalone headless server

  **New Application**

  Add `apps/server` - a headless Thaumic Cast server that runs without a GUI. Built on thaumic-core, it provides the same streaming capabilities as the desktop app for server/NAS deployments.

  **Features**
  - YAML configuration file support (`config.yaml`)
  - CLI arguments for host, port, data directory
  - Environment variable overrides (`THAUMIC_HOST`, `THAUMIC_PORT`, etc.)
  - Graceful shutdown on SIGINT/SIGTERM
  - Optional data persistence directory for manual speakers

  **Configuration Precedence**

  CLI args > Environment variables > Config file > Defaults

  **Usage**

  ```bash
  # With config file
  thaumic-server --config config.yaml

  # With CLI args
  thaumic-server --host 0.0.0.0 --port 9876

  # With environment
  THAUMIC_PORT=9876 thaumic-server
  ```
