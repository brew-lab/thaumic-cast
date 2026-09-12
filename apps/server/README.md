# thaumic-server

Standalone headless server for Thaumic Cast.

## Overview

`thaumic-server` is the "speaking" half of Thaumic Cast without a GUI. It exposes the same HTTP/WebSocket API as the
desktop app, so the browser extension can stream to it from any machine on your LAN. It is designed for:

- Home servers, NAS boxes and Proxmox containers
- Docker containers
- Any headless Linux box running as a system service

The extension is normally paired with a desktop app on the same machine. When the server lives elsewhere, point the
extension at it: **Options → Server → turn off auto-discover → enter `http://<server-ip>:49400` → Test**.

## Network requirements

Thaumic Cast is pull-based: the server advertises a stream URL and each Sonos speaker fetches it over HTTP. That shapes
what the host needs:

| Requirement                        | Why                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Speakers discoverable              | Discovery uses SSDP and mDNS multicast; see below for speakers on another subnet |
| Port `49400/tcp` open inbound      | Speakers pull audio and post GENA events; the extension connects here too        |
| A LAN IP the speakers can reach    | Advertised to Sonos in stream URLs and GENA callbacks (`advertise_ip`)           |
| No NAT between server and speakers | Docker bridge networking breaks both discovery and the advertised IP             |

Easiest is the same L2 network / VLAN as the speakers. A different subnet also works as long as unicast traffic is
routed both ways and one of the following holds:

- your router or access points reflect mDNS between the subnets (Avahi reflector, UniFi "mDNS", etc.), in which case
  the mDNS discovery method finds the speakers even though SSDP cannot cross the boundary, or
- you add the speakers by IP through `POST /api/speakers/manual` (set `data_dir` so they persist).

## Installation

### Installer (recommended)

One command installs or updates the server on any systemd Linux host (Debian, Ubuntu, Proxmox LXC, ...) on x86_64 or
arm64. It downloads the release tarball and its checksum from GitHub, verifies it, creates a `thaumic` system user,
installs the binary, config and systemd unit, and starts the service. Re-running it later updates in place.

```bash
curl -fsSL https://raw.githubusercontent.com/brew-lab/thaumic-cast/main/apps/server/install.sh | sudo bash
```

| Option            | Effect                                                    |
| ----------------- | --------------------------------------------------------- |
| `--check`         | Show installed vs. latest version, change nothing         |
| `--version X.Y.Z` | Install a specific release                                |
| `--tarball PATH`  | Install from a local release tarball (no network access)  |
| `--no-start`      | Install without starting the service                      |
| `--uninstall`     | Remove the service and binary, keep config and data       |
| `--purge`         | With `--uninstall`: also remove config, data and the user |

Pass options after `bash -s --`, e.g. `... | sudo bash -s -- --check`. The installer's only network access is GitHub
releases; nothing else is contacted.

**Updating:** re-run the same command, or `install.sh --check` to see whether a newer release exists. The systemd unit
is replaced on every update so fixes ship with releases; keep local overrides in a drop-in (`systemctl edit
thaumic-server`). Your `config.yaml` and data directory are never touched.

### Manual (tarball)

Each [release](../../../../releases/latest) ships `thaumic-server-vX.Y.Z-linux-x64.tar.gz` and `-linux-arm64.tar.gz`
(plus `.sha256`) containing the binary, this README, `config.example.yaml`, the systemd unit with its sandbox drop-in,
and `install.sh`. The binary needs glibc 2.35 or newer (Debian 12, Ubuntu 22.04 and later); nothing else.

```bash
tar -xzf thaumic-server-vX.Y.Z-linux-x64.tar.gz
sudo bash thaumic-server-vX.Y.Z-linux-x64/install.sh --tarball thaumic-server-vX.Y.Z-linux-x64.tar.gz
```

### From source

Requires Rust 1.88 or newer.

```bash
cargo build --release --locked -p thaumic-server
# → target/release/thaumic-server
```

### Docker

The image is built from the repository root so the Cargo workspace is available:

```bash
docker build -f apps/server/Dockerfile -t thaumic-server .
docker run -d --name thaumic-server --restart unless-stopped \
  --network host \
  -e THAUMIC_ADVERTISE_IP=192.168.1.100 \
  -v thaumic-data:/var/lib/thaumic-server \
  thaumic-server
```

`--network host` is required: SSDP/mDNS discovery needs multicast, and Sonos must be able to reach the advertised IP
directly. With bridge networking the container would advertise an unreachable address.

## Usage

```bash
# Run with default settings (auto-detects the LAN IP, port 49400)
thaumic-server

# Run with a config file
thaumic-server --config /etc/thaumic-server/config.yaml

# Run with CLI overrides
thaumic-server --port 49400 --advertise-ip 192.168.1.100 --data-dir /var/lib/thaumic-server

# Set log level
thaumic-server --log-level debug
```

### CLI options

| Option                    | Environment variable   | Description                             |
| ------------------------- | ---------------------- | --------------------------------------- |
| `-c, --config <FILE>`     | -                      | Path to YAML config file                |
| `-p, --port <PORT>`       | `THAUMIC_BIND_PORT`    | HTTP server port (default `49400`)      |
| `-a, --advertise-ip <IP>` | `THAUMIC_ADVERTISE_IP` | IP address to advertise to Sonos        |
| `-d, --data-dir <DIR>`    | `THAUMIC_DATA_DIR`     | Directory for persistent data           |
| `-l, --log-level <LEVEL>` | `THAUMIC_LOG_LEVEL`    | Log level (error/warn/info/debug/trace) |

CLI flags override environment variables, which override the config file.

## Configuration

The installer writes [`config.example.yaml`](config.example.yaml) to `/etc/thaumic-server/config.yaml`; every key is
commented there. The defaults (port `49400`, auto-detected `advertise_ip`, no `data_dir`) are right for a host with
one network interface. Set `advertise_ip` explicitly on hosts with several interfaces (VPN, Docker, ...) to the
address the speakers can reach, and `data_dir` if you add speakers by IP and want them to persist.

### Environment variables

| Variable                            | Description                         |
| ----------------------------------- | ----------------------------------- |
| `THAUMIC_BIND_PORT`                 | HTTP server port                    |
| `THAUMIC_ADVERTISE_IP`              | Advertise IP address                |
| `THAUMIC_TOPOLOGY_REFRESH_INTERVAL` | Topology refresh interval (seconds) |
| `THAUMIC_DATA_DIR`                  | Directory for persistent data       |
| `THAUMIC_ARTWORK_URL`               | Custom artwork URL for Sonos        |
| `THAUMIC_LOG_LEVEL`                 | Log level                           |

## Running as a service (systemd)

The installer creates the `thaumic` system user, installs the binary to `/usr/local/bin`, the config to
`/etc/thaumic-server/config.yaml`, and the unit from [`thaumic-server.service`](thaumic-server.service) plus its
filesystem-sandbox drop-in from [`thaumic-server.service.d/`](thaumic-server.service.d/). `install.sh --no-start`
does all of that without starting the service if you want to edit the config first.

```bash
sudo systemctl status thaumic-server
journalctl -u thaumic-server -f
sudo systemctl edit thaumic-server      # local overrides survive updates
```

The unit grants `CAP_SYS_NICE` so the streaming workers can raise their scheduling priority. The sandbox drop-in
(`ProtectSystem=strict`, `PrivateTmp`, ...) needs mount namespaces; on an unprivileged LXC container without the
nesting feature the installer skips it with a warning, and re-running the installer after enabling nesting puts it
back.

## Proxmox

Use an **LXC container**, not a VM: the server is a single static binary, needs no kernel modules, and a container
shares the host's bridge so multicast discovery just works. A VM is only worth it if you also want Docker inside it.

### One command

[`proxmox-lxc.sh`](proxmox-lxc.sh) creates an unprivileged Debian 12 container and runs the installer inside it. On
the Proxmox host, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/brew-lab/thaumic-cast/main/apps/server/proxmox-lxc.sh -o proxmox-lxc.sh
BRIDGE=vmbr0 bash proxmox-lxc.sh
```

Defaults: next free container id, hostname `thaumic-cast`, DHCP, 1 core, 512 MB, 4 GB on `local-lvm`, starts on
boot. Everything is overridable through environment variables, e.g.
`CTID=120 IP=192.168.1.50/24 GATEWAY=192.168.1.1 VLAN=20 STORAGE=local-zfs bash proxmox-lxc.sh`. The script prints the
container's IP and, if you did not set `PASSWORD`, the generated root password. Update later with
`pct exec <CTID> -- bash -c 'curl -fsSL .../install.sh | bash'` (the exact command is printed at the end).

### By hand

1. **Create the container.** Debian 12 template, unprivileged, 1 vCPU, 512 MB RAM, 4 GB disk is plenty. Attach the
   network device to the bridge (and VLAN tag, if any) that your Sonos speakers are on, e.g. `vmbr0`. Use a static IP
   or a DHCP reservation; the address is baked into stream URLs the speakers use.
2. **Install** inside the container with the [installer](#installer-recommended). With a single interface the server
   auto-detects the right `advertise_ip`.
3. **Firewall.** If the Proxmox firewall is enabled for the container, allow inbound `49400/tcp` from the LAN. Discovery
   uses outbound multicast and receives unicast replies, which stateful rules allow by default.
4. **Verify.**

   ```bash
   curl http://<container-ip>:49400/health      # {"status":"ok","appType":"server",...}
   curl http://<container-ip>:49400/api/speakers # should list your Sonos devices
   ```

5. **Point the extension at it.** Options → Server → disable auto-discover → `http://<container-ip>:49400` → Test.

Speakers not showing up? Check the [network requirements](#network-requirements): same VLAN, or mDNS reflected across
subnets, or add one by IP with `POST /api/speakers/manual` (`{"ip":"192.168.1.50"}`); it is persisted in `data_dir`
and probed on every refresh.

## API endpoints

The server exposes the same HTTP/WebSocket API as the desktop app:

| Endpoint                             | Description                              |
| ------------------------------------ | ---------------------------------------- |
| `GET /health`                        | Liveness probe                           |
| `GET /ready`                         | Readiness probe                          |
| `GET /api/speakers`                  | List all discovered speakers             |
| `GET /api/groups`                    | List Sonos groups                        |
| `GET /api/state`                     | Current server state                     |
| `POST /api/refresh`                  | Trigger topology refresh                 |
| `POST /api/playback/start`           | Start playback on a speaker              |
| `GET/POST /api/speakers/:ip/volume`  | Get/set speaker volume                   |
| `GET/POST /api/speakers/:ip/mute`    | Get/set speaker mute state               |
| `POST /api/speakers/manual/probe`    | Probe a manual speaker by IP             |
| `GET/POST /api/speakers/manual`      | List/add manual speakers                 |
| `DELETE /api/speakers/manual/:ip`    | Remove a manual speaker                  |
| `ANY /sonos/gena`                    | GENA event callback (called by Sonos)    |
| `GET /stream/{id}/live[.wav\|.flac]` | Audio stream endpoint (for Sonos)        |
| `GET /artwork.jpg`                   | Album artwork for Sonos display          |
| `WS /ws`                             | WebSocket for real-time events and audio |

Cross-origin requests are accepted from browser-extension origins (`chrome-extension://`, `moz-extension://`) only, so
the extension can talk to a remote server while ordinary web pages cannot read API responses.

## Graceful shutdown

The server handles `SIGINT` (Ctrl+C) and `SIGTERM` gracefully:

1. Stops accepting new connections
2. Stops playback on all speakers
3. Unsubscribes from GENA notifications
4. Exits cleanly

## License

AGPL-3.0
