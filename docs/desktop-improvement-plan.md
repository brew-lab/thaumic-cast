# Desktop Improvement Plan

> Implementation plan for hardening the Thaumic Cast desktop companion app.
> Updated with detailed Tauri 2 implementation guidance.

## Executive Summary

This plan addresses validated improvement areas across 4 phases, prioritized by impact on reliability, security, and user experience. All implementations follow **Tauri 2 best practices** using official plugins.

---

## Current State Analysis

| Area                   | Current State                                    | Gap                                          |
| ---------------------- | ------------------------------------------------ | -------------------------------------------- |
| **Type Sharing**       | Uses `@thaumic-cast/protocol`                    | Minor - frontend could use more shared types |
| **Status Reporting**   | `discovered_speakers: 0`, `server_running: true` | Hardcoded values don't reflect reality       |
| **Port Handling**      | HTTP: 3000 (no fallback), GENA: 3001-3005        | HTTP server fails if port occupied           |
| **Config Persistence** | In-memory only                                   | Settings lost on restart                     |
| **Security**           | CORS `Any`, no auth, no CSRF                     | Open to LAN attacks                          |
| **Logging**            | tracing to stdout                                | No file persistence or rotation              |
| **Discovery**          | Manual button triggers                           | No auto-discovery                            |
| **Deep Links**         | None                                             | Extension can't launch app                   |
| **Autostart**          | None                                             | App not available on boot                    |

---

## Phase 1: Core Reliability

**Goal**: Ensure the app starts reliably and persists user settings.

### 1.1 HTTP Server Port Fallback

**Problem**: Server fails silently if port 3000 is occupied.

**Solution**: Implement port range allocation matching GENA strategy.

```rust
// src-tauri/src/server/mod.rs

const HTTP_PORT_RANGE: std::ops::RangeInclusive<u16> = 45100..=45110;

pub async fn find_available_port() -> Result<u16, ServerError> {
    for port in HTTP_PORT_RANGE {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                drop(listener);
                return Ok(port);
            }
            Err(_) => continue,
        }
    }
    Err(ServerError::NoAvailablePort)
}

pub async fn start_server(state: Arc<AppState>) -> Result<ServerHandle, ServerError> {
    let port = match state.config.read().port {
        Some(p) if port_available(p) => p,
        Some(p) => {
            tracing::warn!("Configured port {} unavailable, finding alternative", p);
            find_available_port().await?
        }
        None => find_available_port().await?,
    };

    // Update state with actual bound port
    state.config.write().actual_port = Some(port);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr).await?;

    tracing::info!("HTTP server listening on {}", addr);
    // ... rest of server setup
}
```

**Files to modify**:

- `src-tauri/src/server/mod.rs` - Add port allocation logic
- `src-tauri/src/lib.rs` - Handle startup errors gracefully

### 1.2 Configuration Persistence with Tauri Store Plugin

**Problem**: Settings reset to defaults on restart.

**Solution**: Use `tauri-plugin-store` for JSON-based config persistence.

**Installation**:

```bash
cd desktop
bun tauri add store
bun add @tauri-apps/plugin-store
```

**Rust setup** (`src-tauri/src/lib.rs`):

```rust
use tauri_plugin_store::StoreExt;
use serde_json::json;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // Load or create config store
            let store = app.store("config.json")?;

            // Load existing config or use defaults
            let config = Config {
                preferred_port: store.get("preferred_port")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u16),
                preferred_coordinator: store.get("preferred_coordinator")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                bind_loopback_only: store.get("bind_loopback_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                cors_allowed_origins: store.get("cors_allowed_origins")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_else(default_cors_origins),
            };

            app.manage(AppState::new(config));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Frontend usage** (`src/lib/config.ts`):

```typescript
import { load } from '@tauri-apps/plugin-store';

const store = await load('config.json', { autoSave: true });

export async function getConfig(): Promise<AppConfig> {
  return {
    preferredPort: (await store.get<number>('preferred_port')) ?? null,
    preferredCoordinator: (await store.get<string>('preferred_coordinator')) ?? null,
    bindLoopbackOnly: (await store.get<boolean>('bind_loopback_only')) ?? true,
    corsAllowedOrigins: (await store.get<string[]>('cors_allowed_origins')) ?? [],
  };
}

export async function setConfig(key: string, value: unknown): Promise<void> {
  await store.set(key, value);
}
```

**Config schema** (`src-tauri/src/config.rs`):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// User-preferred HTTP port (null = auto-allocate from range)
    pub preferred_port: Option<u16>,

    /// Actually bound HTTP port (runtime, not persisted)
    #[serde(skip)]
    pub actual_http_port: Option<u16>,

    /// Actually bound GENA port (runtime, not persisted)
    #[serde(skip)]
    pub actual_gena_port: Option<u16>,

    /// Preferred Sonos coordinator IP
    pub preferred_coordinator: Option<String>,

    /// Bind to loopback only (127.0.0.1) vs all interfaces
    #[serde(default = "default_true")]
    pub bind_loopback_only: bool,

    /// Allowed CORS origins (empty = extension origin only)
    #[serde(default)]
    pub cors_allowed_origins: Vec<String>,

    /// Enable session token for mutating routes
    #[serde(default = "default_true")]
    pub require_session_token: bool,

    /// Auto-generated session token (runtime, not persisted)
    #[serde(skip)]
    pub session_token: Option<String>,
}

fn default_true() -> bool { true }

impl Default for Config {
    fn default() -> Self {
        Self {
            preferred_port: None, // Auto-allocate
            actual_http_port: None,
            actual_gena_port: None,
            preferred_coordinator: None,
            bind_loopback_only: true,
            cors_allowed_origins: vec![],
            require_session_token: true,
            session_token: None,
        }
    }
}
```

**Files to create/modify**:

- `src-tauri/src/config.rs` - New config module
- `src-tauri/Cargo.toml` - Add `tauri-plugin-store`
- `src-tauri/src/lib.rs` - Initialize store plugin
- `src-tauri/capabilities/default.json` - Add `store:default` permission
- `src/lib/config.ts` - Frontend config helpers
- `package.json` - Add `@tauri-apps/plugin-store`

### 1.3 Accurate Status Reporting

**Problem**: `discovered_speakers` always 0, `server_running` always true.

**Solution**: Track real state and expose comprehensive status.

**Enhanced StatusResponse** (`packages/protocol/openapi.yaml`):

```yaml
StatusResponse:
  type: object
  required:
    - server_running
    - http_port
    - active_streams
  properties:
    server_running:
      type: boolean
      description: Whether HTTP server successfully started
    http_port:
      type: integer
      format: uint16
      description: Actual HTTP server port
    gena_port:
      type: integer
      format: uint16
      nullable: true
      description: Actual GENA listener port (null if not started)
    local_ip:
      type: string
      nullable: true
      description: Local network IP address
    active_streams:
      type: integer
      format: uint64
    discovered_speakers:
      type: integer
      format: uint64
      description: Number of speakers from last discovery
    last_discovery_at:
      type: string
      format: date-time
      nullable: true
      description: ISO8601 timestamp of last speaker discovery
    gena_subscriptions:
      type: integer
      format: uint64
      description: Number of active GENA subscriptions
    startup_errors:
      type: array
      items:
        type: string
      description: Any errors encountered during startup
```

**Rust implementation** (`src-tauri/src/commands.rs`):

```rust
#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let config = state.config.read();
    let stream_count = state.streams.count();

    // Get real speaker count from cache
    let (speaker_count, last_discovery) = {
        let cache = SPEAKER_CACHE.read();
        match cache.as_ref() {
            Some(c) => (c.speakers.len() as u64, Some(c.cached_at)),
            None => (0, None),
        }
    };

    // Get GENA subscription count
    let gena_subscriptions = state.gena.read().await
        .as_ref()
        .map(|g| g.subscription_count())
        .unwrap_or(0);

    // Get local IP
    let local_ip = local_ip_address::local_ip()
        .ok()
        .map(|ip| ip.to_string());

    Ok(StatusResponse {
        server_running: state.server_handle.is_some(),
        http_port: config.actual_http_port.unwrap_or(0),
        gena_port: config.actual_gena_port,
        local_ip,
        active_streams: stream_count as u64,
        discovered_speakers: speaker_count,
        last_discovery_at: last_discovery.map(|t| t.to_rfc3339()),
        gena_subscriptions,
        startup_errors: state.startup_errors.read().clone(),
    })
}
```

### 1.4 Startup Error Surfacing

**Problem**: Failures in server/GENA startup are logged but not visible to users.

**Solution**: Collect startup errors and expose via status.

```rust
// src-tauri/src/lib.rs

pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub streams: Arc<StreamManager>,
    pub gena: Arc<tokio::sync::RwLock<Option<GenaListener>>>,
    pub server_handle: Arc<RwLock<Option<ServerHandle>>>,
    pub startup_errors: Arc<RwLock<Vec<String>>>,
}

impl AppState {
    pub fn add_startup_error(&self, error: impl ToString) {
        self.startup_errors.write().push(error.to_string());
    }
}
```

---

## Phase 2: Port & Network Improvements

**Goal**: Use sensible defaults and expose network context.

### 2.1 High-Numbered Port Range

**Problem**: Ports 3000/3001 conflict with dev servers (Vite, Next.js, etc.).

**Solution**: Default to high-numbered range (45100-45200).

```rust
// src-tauri/src/server/mod.rs

/// HTTP server port range (avoids common dev ports)
pub const HTTP_PORT_RANGE: std::ops::RangeInclusive<u16> = 45100..=45110;

/// GENA listener port range
pub const GENA_PORT_RANGE: std::ops::RangeInclusive<u16> = 45111..=45120;
```

### 2.2 Auto-Discovery on Startup

**Problem**: Users must manually click Discover button.

**Solution**: Run discovery automatically on startup and at intervals.

```rust
// src-tauri/src/lib.rs

const DISCOVERY_INTERVAL: Duration = Duration::from_secs(300); // 5 minutes

.setup(|app| {
    let state = app.state::<AppState>().inner().clone();

    // Initial discovery
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sonos::discover_speakers(true).await {
            tracing::warn!("Initial speaker discovery failed: {}", e);
        }
    });

    // Periodic discovery
    let state_clone = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(DISCOVERY_INTERVAL);
        loop {
            interval.tick().await;
            if let Err(e) = sonos::discover_speakers(true).await {
                tracing::warn!("Periodic speaker discovery failed: {}", e);
            }
        }
    });

    Ok(())
})
```

**Frontend changes**: Remove manual Discover/Refresh buttons, show "Last updated: X" timestamp.

---

## Phase 3: Security Hardening

**Goal**: Protect against LAN-based attacks while maintaining usability.

### 3.1 CORS Restriction

**Problem**: CORS allows any origin, enabling drive-by requests from malicious sites.

**Solution**: Default to extension origin only, with configurable allowlist.

```rust
// src-tauri/src/server/mod.rs

use tower_http::cors::{CorsLayer, AllowOrigin};

fn build_cors_layer(config: &Config) -> CorsLayer {
    let default_origins = vec![
        "chrome-extension://".to_string(),
        "moz-extension://".to_string(),
    ];

    let allowed_origins: Vec<_> = if config.cors_allowed_origins.is_empty() {
        default_origins
    } else {
        config.cors_allowed_origins.clone()
    };

    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            let origin_str = origin.to_str().unwrap_or("");
            allowed_origins.iter().any(|allowed| {
                origin_str.starts_with(allowed)
            })
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static("x-session-token"),
        ])
        .allow_credentials(false)
}
```

### 3.2 Session Token for Mutating Routes

**Problem**: Any device on LAN can control playback, volume, etc.

**Solution**: Generate session token on startup, require for mutating routes.

```rust
// src-tauri/src/server/middleware.rs

pub async fn require_session_token<B>(
    State(state): State<Arc<AppState>>,
    request: Request<B>,
    next: Next<B>,
) -> Result<Response, StatusCode> {
    let config = state.config.read();

    if !config.require_session_token {
        return Ok(next.run(request).await);
    }

    // Skip for safe methods
    if request.method() == Method::GET || request.method() == Method::OPTIONS {
        return Ok(next.run(request).await);
    }

    let token = request.headers()
        .get("x-session-token")
        .and_then(|v| v.to_str().ok());

    match (token, &config.session_token) {
        (Some(provided), Some(expected)) if provided == expected => {
            Ok(next.run(request).await)
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

pub fn generate_session_token() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}
```

### 3.3 Loopback Binding Default

**Problem**: Server binds to all interfaces, exposing to entire LAN.

**Solution**: Default to loopback (127.0.0.1), configurable via settings.

```rust
pub async fn start_server(state: Arc<AppState>) -> Result<ServerHandle, ServerError> {
    let config = state.config.read();

    let bind_addr = if config.bind_loopback_only {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    };

    // Note: GENA must bind to routable IP for Sonos callbacks
    let port = find_available_port_on(bind_addr).await?;
    // ...
}
```

---

## Phase 4: Extended Features

**Goal**: Improve integration and observability.

### 4.1 Deep Link Support

**Problem**: Extension can't launch desktop app when health check fails.

**Solution**: Register custom URI scheme using `tauri-plugin-deep-link`.

**Installation**:

```bash
cd desktop
bun tauri add deep-link
bun add @tauri-apps/plugin-deep-link
```

**Configuration** (`src-tauri/tauri.conf.json`):

```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["thaumic-cast"]
      }
    }
  }
}
```

**Rust handler**:

```rust
use tauri_plugin_deep_link::DeepLinkExt;

.plugin(tauri_plugin_deep_link::init())
.setup(|app| {
    app.deep_link().on_open_url(|event| {
        let urls = event.urls();
        for url in urls {
            tracing::info!("Deep link received: {}", url);
            // thaumic-cast://launch - bring to foreground
            // thaumic-cast://status - show status
        }
    });
    Ok(())
})
```

**Extension usage**:

```typescript
export function launchDesktopApp(): void {
  window.open('thaumic-cast://launch', '_blank');
}
```

### 4.2 Run on Startup (Autostart)

**Problem**: User must manually launch app; extension fails if app not running.

**Solution**: Use `tauri-plugin-autostart` with user opt-in.

**Installation**:

```bash
cd desktop
bun tauri add autostart
bun add @tauri-apps/plugin-autostart
```

**Rust setup**:

```rust
.plugin(
    tauri_plugin_autostart::Builder::new()
        .args(["--minimized"])
        .build()
)
```

**Frontend controls**:

```typescript
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

async function toggleAutostart() {
  if (await isEnabled()) {
    await disable();
  } else {
    await enable();
  }
}
```

**Capabilities**:

```json
{
  "permissions": ["autostart:allow-enable", "autostart:allow-disable", "autostart:allow-is-enabled"]
}
```

### 4.3 Structured Logging with Rotation

**Problem**: Logs only go to stdout; no persistence for debugging.

**Solution**: Use `tauri-plugin-log` with file rotation.

**Installation**:

```bash
cd desktop
bun tauri add log
bun add @tauri-apps/plugin-log
```

**Rust setup**:

```rust
use tauri_plugin_log::{Target, TargetKind, RotationStrategy};

.plugin(
    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some("thaumic-cast".to_string()),
            }),
        ])
        .max_file_size(5_000_000) // 5MB
        .rotation_strategy(RotationStrategy::KeepAll)
        .level(log::LevelFilter::Info)
        .build()
)
```

**Frontend console forwarding**:

```typescript
import { attachConsole } from '@tauri-apps/plugin-log';
attachConsole();
```

---

## Implementation Checklist

### Phase 1: Core Reliability

- [x] Implement port fallback in `server/mod.rs` _(aebee91)_
- [x] Centralize port utilities in `network.rs` _(aebee91)_
- [x] Track actual bound ports in AppState _(aebee91)_
- [x] Add `tauri-plugin-store` dependency _(084aaba)_
- [x] Load config from store on startup _(084aaba)_
- [x] Persist config changes to store _(084aaba)_
- [x] Update `StatusResponse` in protocol schema (added gena*port, local_ip, gena_subscriptions) *(11b9f0b)\_
- [x] Run `bun run codegen` to regenerate types _(11b9f0b)_
- [x] Update `get_status` command with real values (speaker count, GENA subscriptions) _(11b9f0b)_
- [x] Add startup error collection _(08832e4)_
- [ ] Update frontend to use store plugin
- [ ] Update frontend to display enhanced status

### Phase 2: Port & Network

- [x] Change default port range to 45100-45120 _(aebee91)_
- [x] Add `local_ip` and ports to status response _(11b9f0b)_
- [x] Implement auto-discovery on startup _(5283885)_
- [x] Add discovery interval (5 min default) _(5283885)_
- [x] Add `last_discovery_at` to StatusResponse _(5283885)_
- [ ] Remove manual Discover/Refresh buttons from UI
- [ ] Add "last updated" timestamp display

### Phase 3: Security

- [x] Implement CORS origin allowlist _(f5c3305)_
- [x] Add configurable `trusted_origins` to Config _(f5c3305)_
- [x] Remove debug endpoint `/api/debug/gena` _(3340109)_
- [~] Session token - removed (CORS is sufficient, no secure way to distribute token to extension)
- [~] Loopback binding - skipped (HTTP server must be LAN-accessible for Sonos streaming)

### Phase 4: Extended Features

- [x] Add `tauri-plugin-deep-link` dependency _(04ddb60)_
- [x] Configure `thaumic-cast://` URI scheme _(04ddb60)_
- [x] Implement deep link handler _(04ddb60)_
- [x] Add `tauri-plugin-autostart` dependency
- [ ] Add autostart toggle to settings UI
- [ ] Add `tauri-plugin-log` dependency
- [ ] Configure log rotation
- [ ] Add console forwarding in frontend

---

## Dependencies Summary

### New Cargo Dependencies

```toml
[dependencies]
tauri-plugin-store = "2"
tauri-plugin-autostart = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-log = "2"
hex = "0.4"
rand = "0.8"
hostname = "0.4"
```

### New PNPM Dependencies

```json
{
  "@tauri-apps/plugin-store": "^2",
  "@tauri-apps/plugin-autostart": "^2",
  "@tauri-apps/plugin-deep-link": "^2",
  "@tauri-apps/plugin-log": "^2"
}
```

### Capability Permissions

```json
{
  "permissions": [
    "store:default",
    "autostart:allow-enable",
    "autostart:allow-disable",
    "autostart:allow-is-enabled",
    "deep-link:default",
    "log:default"
  ]
}
```

---

## Testing Strategy

### Unit Tests

- Port availability checking
- Config serialization/deserialization
- Session token generation
- CORS origin matching

### Integration Tests

- Server startup with port conflict
- Config persistence across restarts
- GENA subscription lifecycle
- Deep link handling

### Manual Testing

- Fresh install (no config file)
- Upgrade from existing install
- Port conflict scenarios
- Extension ↔ desktop communication with token
- Autostart enable/disable per OS
