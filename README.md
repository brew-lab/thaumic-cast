<p align="center">
  <a href="../../releases/latest">Download</a> · <a href="#quick-start">Quick start</a> · <a href="#development">Development</a>
</p>

<p align="center">
  <img src="apps/desktop/app-icon.svg" width="160" alt="Thaumic Cast logo" />
</p>

<h1 align="center">Thaumic Cast</h1>

<h3 align="center">
  High-performance, self-hosted browser tab audio streaming to Sonos speakers: private, local, and entirely your
  problem.
</h3>

Thaumic Cast captures audio from your browser and streams it over your local network to Sonos speakers via UPnP. No
accounts, no cloud, just packets.

## Quick start

Thaumic Cast comes in two pieces: the browser extension (it does the listening) and a local server (it does the
speaking). The server can be the Desktop app or the headless server.

1. Download and run the **Desktop app** from the [latest release](../../releases/latest). Prefer headless? Use the
   server instead of the Desktop app: see [`apps/server/README.md`](apps/server/README.md).
2. Download the **Browser extension** `thaumic-cast-extension-vX.Y.Z.zip` from the [latest release](../../releases/latest),
   unzip it, then load it via `chrome://extensions` → Developer mode → **Load unpacked**.
3. Click the extension, pick a Sonos group, and start streaming.

> [!NOTE]
> Thaumic Cast runs a local server on `http://localhost:49400` (it may use any port in `49400–49410`). If you use a
> firewall, open `49400–49410/tcp`.

## Downloads

- Desktop app (Windows/macOS/Linux): [Latest release](../../releases/latest)
- Chrome extension zip: [Latest release](../../releases/latest) (look for `thaumic-cast-extension-vX.Y.Z.zip`)
- Headless server: [`apps/server/README.md`](apps/server/README.md)

> [!NOTE]
> Desktop app releases are currently unsigned. Your OS may warn you (macOS Gatekeeper, Windows SmartScreen). Make sure
> you downloaded it from the [latest release](../../releases/latest).

## What it does

- Streams audio from a browser tab to Sonos speakers on your local network.
- Sends different tabs to different rooms/groups (kitchen gets jazz, office gets “focus noise”, everyone wins).
- Keeps things self-hosted and local: no accounts, no cloud, no “sign in to continue breathing”.
- Runs as a Desktop app or a headless server for NAS/Docker.
- Great for YouTube Music, Spotify Web Player, Bandcamp, and web radio. In other words, getting music onto Sonos without
  sending it on holiday first.

## Documentation

- [Architecture overview](docs/ARCHITECTURE.md)
- [Headless server](apps/server/README.md)
- [Core library](packages/thaumic-core/README.md)

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) 1.0+

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

## Repository layout

```
apps/
  desktop/           # Tauri desktop app with GUI
  extension/         # Chrome Extension (MV3)
  server/            # Headless server binary
packages/
  thaumic-core/      # Shared Rust library (Sonos, streaming, API)
  protocol/          # Shared TypeScript types
  shared/            # Shared TypeScript utilities (logger)
  ui/                # Shared Preact components
```

| Package                 | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `apps/desktop`          | Tauri + Rust + Preact desktop application      |
| `apps/extension`        | Chrome Extension with AudioWorklet + WebCodecs |
| `apps/server`           | Standalone headless server for NAS/Docker      |
| `packages/thaumic-core` | Core Rust library shared by desktop and server |
| `packages/protocol`     | TypeScript types for WebSocket protocol        |
| `packages/shared`       | Shared TypeScript utilities (logger)           |
| `packages/ui`           | Shared Preact components and design system     |

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
