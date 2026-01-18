# @thaumic-cast/server

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
