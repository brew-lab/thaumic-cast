# thaumic-server

Standalone headless server for Thaumic Cast.

## Overview

`thaumic-server` is the "speaking" half of Thaumic Cast without a GUI. It exposes the same HTTP/WebSocket API as the
desktop app, so the browser extension can stream to it from any machine on your LAN. It is designed for:

- Home servers, NAS boxes and Proxmox containers
- Docker containers
- Any headless Linux box running as a system service

The extension is normally paired with a desktop app on the same machine. When the server lives elsewhere, point the
extension at it: **Options → Server → turn off auto-discover → enter `http://<server-ip>:49400` → Connect**, and
accept Chrome's prompt to allow that address.

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

| Option                                    | Environment variable           | Description                                        |
| ----------------------------------------- | ------------------------------ | -------------------------------------------------- |
| `-c, --config <FILE>`                     | -                              | Path to YAML config file                           |
| `-p, --port <PORT>`                       | `THAUMIC_BIND_PORT`            | HTTP server port (default `49400`)                 |
| `-a, --advertise-ip <IP>`                 | `THAUMIC_ADVERTISE_IP`         | IP address to advertise to Sonos                   |
| `-d, --data-dir <DIR>`                    | `THAUMIC_DATA_DIR`             | Directory for persistent data                      |
| `-l, --log-level <LEVEL>`                 | `THAUMIC_LOG_LEVEL`            | Log level (error/warn/info/debug/trace)            |
| `--speaker-monitor <on\|off>`             | `THAUMIC_SPEAKER_MONITOR`      | Keep an eye on each speaker (default `on`)         |
| `--pcm-connect-burst-ms <MS>`             | `THAUMIC_PCM_CONNECT_BURST_MS` | Speaker head start, 0-2000 ms (default `500`)      |
| `--drift-compensation <on\|observe\|off>` | `THAUMIC_DRIFT_COMPENSATION`   | Clock drift correction (default `observe`)         |
| `--strict-stream-access <BOOL>`           | `THAUMIC_STRICT_STREAM_ACCESS` | Refuse unexpected stream fetches (default `false`) |

CLI flags override environment variables, which override the config file, with two exceptions:
`THAUMIC_SPEAKER_MONITOR`, `THAUMIC_PCM_CONNECT_BURST_MS` and `THAUMIC_DRIFT_COMPENSATION` are read again for each
speaker connection and win over both the flag and the config file, and `THAUMIC_SPEAKER_DIAGNOSTICS` turns speaker
monitoring on whatever the other settings say.

## Configuration

The installer writes [`config.example.yaml`](config.example.yaml) to `/etc/thaumic-server/config.yaml`; every key is
commented there. The defaults (port `49400`, auto-detected `advertise_ip`, no `data_dir`) are right for a host with
one network interface. Set `advertise_ip` explicitly on hosts with several interfaces (VPN, Docker, ...) to the
address the speakers can reach, and `data_dir` if you add speakers by IP and want them to persist.

Three settings concern the speakers themselves. `speaker_monitor` (on by default) asks each speaker playing a stream how
much audio it has in hand, which is what drives the speaker notices clients show. `pcm_connect_burst_ms`, the speaker
head start (500 ms by default, 0 to 2000), is audio sent to each speaker at once when it connects so it can ride out
Wi-Fi hiccups on PCM casts; raise it if one speaker on a weak Wi-Fi link cuts out, bearing in mind that it adds that
much delay. `drift_compensation` (`observe` by default) is clock drift correction: no two clocks agree exactly, so over a
long cast a speaker slowly uses up its head start, and `on` stretches or squeezes each speaker's PCM audio by at most
150 ppm to hold it level. `observe` works out and logs what it would do and leaves the audio untouched; `off` does
neither. It steers by the speaker monitor, so with `speaker_monitor` off it runs as `off` and the server says so at
startup. All three apply from each speaker's next connection.

### Environment variables

| Variable                            | Description                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `THAUMIC_BIND_PORT`                 | HTTP server port                                                                             |
| `THAUMIC_ADVERTISE_IP`              | Advertise IP address                                                                         |
| `THAUMIC_TOPOLOGY_REFRESH_INTERVAL` | Topology refresh interval (seconds)                                                          |
| `THAUMIC_DATA_DIR`                  | Directory for persistent data                                                                |
| `THAUMIC_ARTWORK_URL`               | Custom artwork URL for Sonos                                                                 |
| `THAUMIC_LOG_LEVEL`                 | Log level                                                                                    |
| `THAUMIC_SPEAKER_MONITOR`           | `on` or `off`: poll each speaker's playback position and send speaker notices                |
| `THAUMIC_PCM_CONNECT_BURST_MS`      | Speaker head start for PCM casts in ms, 0 (off) to 2000; adds that much delay                |
| `THAUMIC_DRIFT_COMPENSATION`        | `on`, `observe` or `off`: clock drift correction for PCM casts; needs the speaker monitor    |
| `THAUMIC_STRICT_STREAM_ACCESS`      | `true` refuses audio fetches from addresses a stream is not playing on                       |
| `THAUMIC_PCM_HTTP_FRAMING`          | `chunked` (default); experimental: `length` or `close`: how a PCM stream's body is delimited |
| `THAUMIC_PCM_CONTENT_LENGTH`        | Experimental: the `Content-Length` PCM declares with `length` framing (default `4294967295`) |
| `THAUMIC_PCM_WAV_DATA_SIZE`         | Experimental: the WAV header's data size, 0 to 4294967295 (default `4294967295`)             |
| `THAUMIC_PCM_END_AFTER_BYTES`       | Experimental: end each PCM body cleanly after this many bytes; `chunked` or `close` only     |
| `THAUMIC_PCM_SEGMENT_BYTES`         | Test only: data bytes per PCM segment, 1048576 to 4294901760 (default), whole 10 ms frames   |
| `THAUMIC_DRIFT_FORCE_PPM`           | Test only: fix every speaker's PCM rate adapter at this many ppm, -300 to 300 (see below)    |

PCM streams are sent chunked, with no `Content-Length`. A WAV header's size is a length, not an unbounded marker: with
0xFFFFFFFF there a Sonos Playbar played past 2^31 bytes in a field test, then stopped at exactly 2^32 bytes (6h12m50s at
48 kHz stereo), where it hung up and went to STOPPED with no reconnect. So a PCM cast is served in segments: each
connection's WAV header declares 4294901760 data bytes (6h12m49.28s at 48 kHz stereo) and its body ends there, and the
next segment, `/stream/{id}/live/{n}.wav`, carries on from the exact sample the previous one ended at, however long the
speaker takes to fetch it (nothing moves a speaker on to that next segment yet, so for now a cast still ends after the
first). A fetch that resumes a segment with `Range: bytes=X-` (a speaker coming back from a pause)
is answered `206` with exactly the rest of that segment. `THAUMIC_PCM_SEGMENT_BYTES` shortens segments for testing
(`10485760` gives 54.61 s at 48 kHz stereo); it is ignored with a warning while a switch that fixes a connection's end
(`length` framing, `THAUMIC_PCM_WAV_DATA_SIZE` or `THAUMIC_PCM_END_AFTER_BYTES`) is set, and those serve PCM on one
connection as before. A speaker that asks over HTTP/1.0, which cannot take chunks, gets an HTTP/1.0 response
whose body ends only when the connection closes (`http=HTTP/1.0, framing=close` on its connection line), as the
compressed codecs always have. Declaring a length ended every PCM cast to a Playbar after 3h06m at 48 kHz (about 3h23m at 44.1 kHz), since it
caps a declared length at 2^31 bytes.

The `length` and `close` framings and the three experimental variables are switches for field experiments into how
speakers treat a PCM stream, not settings: they are read again for each speaker connection, a connection served with any
of them set logs a `[Stream] PCM HTTP switches` line, and an invalid value (including one that is not valid UTF-8), or
one that does not apply to the chosen framing, is ignored with a warning. `length` declares a `Content-Length`
(4294967295 unless `THAUMIC_PCM_CONTENT_LENGTH` says otherwise), as PCM was served before, and so stops after 3h06m on a
Playbar. `close` answers as HTTP/1.0 with `Connection: close`, so the body ends only when the connection closes.
`THAUMIC_PCM_END_AFTER_BYTES` is refused with `length` framing, where ending the body early would abort the connection
rather than end it cleanly.

`THAUMIC_DRIFT_FORCE_PPM` exists for blind listening tests of the rate adapter and should never be left set. While it
holds a number from -300 to 300, every monitored speaker's PCM connection stretches (positive) or squeezes (negative)
its audio by exactly that many ppm, whatever the drift correction mode and the controller say. It is read again for
each speaker connection, each connection it applies to logs a `[Drift] THAUMIC_DRIFT_FORCE_PPM=... forcing the rate
adapter; for listening tests only` warning, and the 30 s `[SpeakerMonitor]` line shows `forced=+150ppm`. A value that
is not a number in range is ignored with a warning, logged once per value. The 2 s limit on audio inserted or removed
still applies: once it is reached the adapter holds at 0 ppm and the line shows `forced=+150ppm(pinned)`. While a
rate is forced the drift controller does not learn, so a later cast does not start from what the test did. A negative
rate drains the speaker's reserve the way a fast speaker clock does, so the drift and running-low notices may appear
during a test and suggest turning drift correction on; they describe the forced rate, not the speaker.

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

5. **Point the extension at it.** Options → Server → disable auto-discover → `http://<container-ip>:49400` → Connect.
   Chrome asks once to let the extension "read and change your data" on that address (its standard wording for
   any site access, limited to that one host); accept.

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
| `GET /stream/{id}/live/{n}.wav`      | PCM segment `n` ≥ 1 (for Sonos)          |
| `GET /artwork.jpg`                   | Album artwork for Sonos display          |
| `WS /ws`                             | WebSocket for real-time events and audio |

The API sends no CORS headers. The extension may talk to `localhost` out of the box; for a server on another machine
it asks you once, through Chrome's own permission prompt, to allow that address when you click **Connect** in its
settings. Ordinary web pages cannot read API responses.

## Graceful shutdown

The server handles `SIGINT` (Ctrl+C) and `SIGTERM` gracefully:

1. Stops accepting new connections
2. Stops playback on all speakers
3. Unsubscribes from GENA notifications
4. Exits cleanly

## License

AGPL-3.0
