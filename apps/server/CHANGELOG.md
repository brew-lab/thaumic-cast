# @thaumic-cast/server

## 0.12.1

### Patch Changes

- [#137](https://github.com/brew-lab/thaumic-cast/pull/137) [`0342009`](https://github.com/brew-lab/thaumic-cast/commit/0342009aabfdc4848dd44e49363793d8e0040e98) Thanks [@skezo](https://github.com/skezo)! - fix(core): recover audio quality after stalls instead of skipping until restart

  After any underrun the cadence stream resumed on the very first frame, leaving the jitter buffer empty; with browser
  (WASAPI) capture delivering exactly one packet per tick it could never refill, so every later hiccup was an audible
  skip until the app was restarted. Playback is now held on silence until the queue is back at the configured jitter
  depth, with a timeout of twice that depth counted from when frames resume, and frames that arrived just before a
  tick no longer count as an underrun. On Windows, audio the engine discarded (`DATA_DISCONTINUITY`, measured from the
  device position and bounded by wall-clock time) is backfilled with the same duration of silence starting with a
  fade-out, packets flagged silent are zero-filled, and the first packet after a loss is faded in. Stream summaries now
  report `rebuffers`.

- [#136](https://github.com/brew-lab/thaumic-cast/pull/136) [`bb3da36`](https://github.com/brew-lab/thaumic-cast/commit/bb3da36f91ad14ad55e23e5f35bddd419146cf04) Thanks [@skezo](https://github.com/skezo)! - feat(extension): ask for permission to reach a companion on another machine

  When you enter a custom server URL and click Connect (previously "Test"), Chrome now prompts once to allow that address, scoped to that
  origin only. This replaces the companion's CORS layer, which trusted every installed browser extension and wrapped the
  API in middleware; the HTTP API no longer sends CORS headers.

- [#134](https://github.com/brew-lab/thaumic-cast/pull/134) [`e4121e2`](https://github.com/brew-lab/thaumic-cast/commit/e4121e2f3bfb5e701b6e0d2ef704d565bfee2329) Thanks [@skezo](https://github.com/skezo)! - fix(core): allow the extension to reach a companion on another machine

  The extension only has host permission for `localhost`, so every request to a remote headless server was blocked by
  CORS. The HTTP API now answers CORS for `chrome-extension://` and `moz-extension://` origins only; regular web pages
  remain unable to read responses.

- [#133](https://github.com/brew-lab/thaumic-cast/pull/133) [`0ccd8a9`](https://github.com/brew-lab/thaumic-cast/commit/0ccd8a98ef72eac1fa34e9379198d0858a598e49) Thanks [@dependabot](https://github.com/apps/dependabot)! - build(deps): update Rust dependencies

  Bumps 26 crates, notably quick-xml 0.39 → 0.41, mdns-sd 0.19 → 0.20 and tower-http 0.6 → 0.7, and adapts the XML
  text readers to quick-xml's new `BytesText` return type. No behaviour change.

- [#134](https://github.com/brew-lab/thaumic-cast/pull/134) [`b70fde3`](https://github.com/brew-lab/thaumic-cast/commit/b70fde3ae3ae1b5af9e41f6bdeb92a63b5079db3) Thanks [@skezo](https://github.com/skezo)! - feat(server): one-command install, update and Proxmox setup

  Releases now include `thaumic-server-vX.Y.Z-linux-{x64,arm64}.tar.gz` with checksums, a hardened systemd unit and
  `install.sh`. The installer (`curl … | sudo bash`) installs or updates in place, verifies checksums and only ever
  contacts GitHub releases. `proxmox-lxc.sh` creates an unprivileged Debian 12 container on a Proxmox host and runs the
  installer inside it. Added `apps/server/Dockerfile`, refreshed the README (Proxmox guide, network requirements,
  correct Rust version) and made the release version sync refresh `Cargo.lock` so `cargo build --locked` passes after a
  release.

- [#134](https://github.com/brew-lab/thaumic-cast/pull/134) [`bffd1da`](https://github.com/brew-lab/thaumic-cast/commit/bffd1dac35de6af3ec0c1f9bdf7a2287afdcf741) Thanks [@skezo](https://github.com/skezo)! - fix(server): stop panicking at startup and serve audio on the streaming runtime

  `thaumic-server` aborted immediately with "Cannot block the current thread from within a runtime" because the
  streaming runtime blocked on a channel from inside `#[tokio::main]`. The runtime is now built on the calling thread
  and handed to a keeper thread, so nothing blocks and it can be created from any context. The server also serves
  HTTP on that runtime, as the desktop app does, so its priority-elevated workers carry the audio path instead of
  sitting idle.

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
