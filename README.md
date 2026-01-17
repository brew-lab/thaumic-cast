# Thaumic Cast

A browser-to-Sonos audio streaming system. Capture audio from browser tabs and stream it locally to Sonos speakers via UPnP.

## Features

- **Multi-Cast:** Stream different tabs to different Sonos groups simultaneously
- **Low Latency:** Uses WAV/LPCM for near-instant playback
- **Modern Pipeline:** AudioWorklet, WebCodecs, and SharedArrayBuffer for high-performance audio
- **Flexible Deployment:** Desktop app with GUI or headless server

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser Extension                            │
│  ┌─────────┐    ┌─────────────┐    ┌─────────┐    ┌─────────────┐  │
│  │   Tab   │───▶│ AudioWorklet│───▶│ Encoder │───▶│  WebSocket  │  │
│  └─────────┘    └─────────────┘    └─────────┘    └──────┬──────┘  │
└──────────────────────────────────────────────────────────┼──────────┘
                                                           │
                           ┌───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Desktop App / Server                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      thaumic-core                             │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │   │
│  │  │  Discovery  │  │   Stream    │  │    Sonos Control    │   │   │
│  │  │   (SSDP)    │  │ Coordinator │  │   (UPnP/SOAP/GENA)  │   │   │
│  │  └─────────────┘  └──────┬──────┘  └─────────────────────┘   │   │
│  └──────────────────────────┼───────────────────────────────────┘   │
│                             │                                        │
│                             ▼                                        │
│                    HTTP Stream Server                                │
│                   /stream/{id}/live                                  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    Sonos    │
                    │   Speaker   │
                    └─────────────┘
```

## Monorepo Structure

```
apps/
  desktop/           # Tauri desktop app with GUI
  extension/         # Chrome Extension (MV3)
  server/            # Headless server binary
packages/
  thaumic-core/      # Shared Rust library (Sonos, streaming, API)
  protocol/          # Shared TypeScript types
  ui/                # Shared Preact components
```

| Package                 | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `apps/desktop`          | Tauri + Rust + Preact desktop application      |
| `apps/extension`        | Chrome Extension with AudioWorklet + WebCodecs |
| `apps/server`           | Standalone headless server for NAS/Docker      |
| `packages/thaumic-core` | Core Rust library shared by desktop and server |
| `packages/protocol`     | TypeScript types for WebSocket protocol        |
| `packages/ui`           | Shared Preact components and design system     |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) 1.75+
- [Bun](https://bun.sh/) 1.0+
- [Node.js](https://nodejs.org/) 20+

### Development

```bash
# Install dependencies
bun install

# Run desktop app in development
bun run dev:desktop

# Build extension
bun run build:extension

# Build headless server
cargo build --release -p thaumic-server
```

### Deployment Options

**Desktop App** - For personal use with a GUI:

```bash
bun run build:desktop
```

**Headless Server** - For NAS/server deployments:

```bash
# Build
cargo build --release -p thaumic-server

# Run
./target/release/thaumic-server --config config.yaml
```

See [`apps/server/README.md`](apps/server/README.md) for server configuration and Docker setup.

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md)
- [Desktop App](apps/desktop/README.md)
- [Headless Server](apps/server/README.md)
- [Core Library](packages/thaumic-core/README.md)

## License

MIT
