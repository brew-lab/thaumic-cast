# thaumic-core

Core library for Thaumic Cast - a browser-to-Sonos audio streaming system.

## Overview

This crate provides the platform-independent core functionality for Thaumic Cast. It's designed to be used by both:

- **Desktop app** (`apps/desktop`) - Tauri-based GUI application
- **Headless server** (`apps/server`) - Standalone server binary

## Architecture

The crate is organized into several modules:

| Module      | Description                                               |
| ----------- | --------------------------------------------------------- |
| `api`       | HTTP/WebSocket server (Axum-based)                        |
| `bootstrap` | Service composition and dependency wiring                 |
| `context`   | Network configuration and URL building                    |
| `events`    | Event system for real-time client communication           |
| `services`  | Business logic (discovery, streaming, latency monitoring) |
| `sonos`     | Sonos speaker control (UPnP/SOAP, GENA subscriptions)     |
| `state`     | Configuration and runtime state                           |
| `stream`    | Audio streaming and transcoding                           |

## Key Types

### Abstraction Traits

These traits decouple core logic from platform-specific implementations:

- `EventEmitter` - Emitting domain events
- `IpDetector` - Local IP detection

### Bootstrap

```rust
use thaumic_core::{bootstrap_services, Config};

// Auto-detect network configuration (for desktop apps with Tauri)
let handle = tauri::async_runtime::handle().inner().clone();
let services = bootstrap_services(&Config::default(), handle)?;

// Or with explicit network configuration (for servers in #[tokio::main])
use thaumic_core::{bootstrap_services_with_network, NetworkContext};

let handle = tokio::runtime::Handle::current();
let network = NetworkContext::explicit(8080, "192.168.1.100".parse()?);
let services = bootstrap_services_with_network(&Config::default(), network, handle)?;
```

### Starting the Server

```rust
use thaumic_core::{AppStateBuilder, start_server};

let app_state = AppStateBuilder::new()
    .sonos(services.sonos.clone())
    .stream_coordinator(services.stream_coordinator.clone())
    // ... other fields
    .build();

start_server(app_state).await?;
```

## Features

- **Sonos Discovery**: SSDP multicast/broadcast and mDNS/Bonjour
- **GENA Subscriptions**: Real-time transport state notifications
- **Audio Streaming**: WAV with ICY metadata, configurable buffering
- **Latency Monitoring**: End-to-end latency measurement
- **WebSocket API**: Real-time communication with browser extensions

## Configuration

See `Config` and `StreamingConfig` in `src/state.rs` for all available options.

Key configuration options:

| Option                      | Default  | Description                         |
| --------------------------- | -------- | ----------------------------------- |
| `preferred_port`            | 0 (auto) | HTTP server port                    |
| `topology_refresh_interval` | 30s      | How often to refresh Sonos topology |

## License

MIT
