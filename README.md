<p align="center">
  <a href="../../releases/latest">Download</a> · <a href="https://chromewebstore.google.com/detail/thaumic-cast/hpemmkbecklfacogdidaoncjmfadgedm">Chrome extension</a> · <a href="#quick-start">Quick start</a> · <a href="#development">Development</a>
</p>

<p align="center">
  <img src="apps/desktop/app-icon.svg" width="160" alt="Thaumic Cast logo" />
</p>

<h1 align="center">Thaumic Cast</h1>

<h3 align="center">
  Plays what your browser is playing on your Sonos speakers, over your own network. Private, local, and entirely your
  problem.
</h3>

A Sonos speaker will play almost anything, provided fetching it was the speaker's idea. Thaumic Cast arranges for your
browser's audio to be the speaker's idea. It does so over your own network and nobody else's. There is no account,
because there is nobody to have an account with.

## Quick start

It comes in two pieces. The extension lives in Chrome and is where you press Cast. The other piece finds the speakers
and serves them the audio: either the desktop app, or Thaumic Cast Server, which is the same machinery with the window
taken off, for the sort of computer that is kept in a cupboard and visited twice a year.[^1]

1. Download and run the **desktop app** from the [latest release](../../releases/latest). If the computer in question
   has no screen to show it on, run the server instead: see [`apps/server/README.md`](apps/server/README.md).
2. Install the **extension** from the [Chrome Web Store](https://chromewebstore.google.com/detail/thaumic-cast/hpemmkbecklfacogdidaoncjmfadgedm). To load it yourself, download
   `thaumic-cast-extension-vX.Y.Z.zip` from the [latest release](../../releases/latest), unzip it, then load it via
   `chrome://extensions` → Developer mode → **Load unpacked**.
3. Open a tab that is playing something, click the extension, choose a speaker or a group, and press **Cast**.

> [!NOTE]
> The desktop app listens on `http://localhost:49400`, or on the first free port up to `49410` if that one is taken.
> If this computer runs a firewall, open `49400–49410/tcp`: the speakers fetch the audio from this computer, and have
> to be let in to do it.

## Downloads

- Desktop app (Windows/macOS/Linux): [Latest release](../../releases/latest)
- Chrome extension: [Chrome Web Store](https://chromewebstore.google.com/detail/thaumic-cast/hpemmkbecklfacogdidaoncjmfadgedm), or the zip from the [latest release](../../releases/latest) (look for `thaumic-cast-extension-vX.Y.Z.zip`)
- Thaumic Cast Server (Linux x64/arm64): [Latest release](../../releases/latest) (look for `thaumic-server-vX.Y.Z-linux-*.tar.gz`), setup in [`apps/server/README.md`](apps/server/README.md)

> [!NOTE]
> Desktop app releases are not signed yet, and macOS Gatekeeper and Windows SmartScreen will each say so in their own
> way. Check that your copy came from the [latest release](../../releases/latest), then let it through.

## What it does

- Casts the audio of a browser tab to Sonos speakers on your own network.
- Sends different tabs to different speakers or groups: jazz in the kitchen, “focus noise” in the office, and neither
  room need know about the other.
- Keeps the audio in the house. It goes from your computer to your speakers, and at no point calls in at anybody
  else's computer on the way.
- Runs as the desktop app, or as Thaumic Cast Server on a NAS, in Docker, or on anything else that has no screen.
- Works with whatever plays in a tab: YouTube Music, the Spotify web player, Bandcamp, web radio. Thaumic Cast does not
  ask what the audio is, only where it is going.

## Documentation

- [Architecture overview](docs/ARCHITECTURE.md)
- [Headless server](apps/server/README.md)
- [Core library](packages/thaumic-core/README.md)
- [Privacy policy](PRIVACY.md)

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

[^1]: The speakers play a little behind the browser. Songs do not mind. Films mind very much, which is what video sync is for.
