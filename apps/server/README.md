# thaumic-server

Thaumic Cast Server: browser audio to Sonos speakers, for a machine with no screen.

## Overview

`thaumic-server` is the half of Thaumic Cast that talks to the speakers, with no window of its own. It serves the same
HTTP/WebSocket API as the desktop app, so the extension can cast through it from any machine on your LAN. It suits:

- Home servers, NAS boxes and Proxmox containers
- Docker containers
- Any headless Linux box, running as a system service

Left to itself, the extension looks for a companion on its own machine and nowhere else. When the server is somewhere
else, the extension has to be told: **Settings → Server → Specify manually → enter `http://<server-ip>:49400` →
Connect**, then say yes when Chrome asks whether the extension may use that address.

## Network requirements

Thaumic Cast does not send audio to a speaker. The server gives each speaker a URL, and the speaker fetches the audio
from it over HTTP. Most of what the host needs follows from that: the speakers have to be able to find their way to
it.

| Requirement                        | Why                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Speakers discoverable              | Discovery uses SSDP and mDNS multicast; see below for speakers on another subnet |
| Port `49400/tcp` open inbound      | Speakers pull audio and post GENA events; the extension connects here too        |
| A LAN IP the speakers can reach    | Advertised to Sonos in stream URLs and GENA callbacks (`advertise_ip`)           |
| No NAT between server and speakers | Docker bridge networking breaks both discovery and the advertised IP             |

The least trouble is the same L2 network / VLAN as the speakers. A different subnet also works, provided unicast
traffic is routed both ways and one of these holds:

- your router or access points reflect mDNS between the subnets (Avahi reflector, UniFi "mDNS", etc.), in which case
  the mDNS discovery method finds the speakers even though SSDP cannot cross the boundary, or
- you add the speakers by IP address through `POST /api/speakers/manual`, which needs `data_dir` set, since that is
  where they are kept.

## Installation

### Installer (recommended)

One command installs or updates the server on any systemd Linux host (Debian, Ubuntu, Proxmox LXC, ...) on x86_64 or
arm64. It downloads the release tarball and its checksum from GitHub, checks the one against the other, creates a
`thaumic` system user, installs the binary, the config and the systemd unit, and starts the service. Run it again
later and it updates what is there.

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

Pass options after `bash -s --`, e.g. `... | sudo bash -s -- --check`. The installer talks to GitHub releases and to
nothing else.

**Updating:** run the same command again, or `install.sh --check` to find out whether there is anything newer. The
systemd unit is replaced on every update, so that fixes to it arrive with the release; keep your own changes in a
drop-in (`systemctl edit thaumic-server`), where an update leaves them alone. Your `config.yaml` and data directory
are never touched.

### Manual (tarball)

Each [release](../../../../releases/latest) ships `thaumic-server-vX.Y.Z-linux-x64.tar.gz` and `-linux-arm64.tar.gz`
(plus `.sha256`) containing the binary, this README, `config.example.yaml`, the systemd unit with its sandbox drop-in,
and `install.sh`. The binary needs glibc 2.35 or newer (Debian 12, Ubuntu 22.04 and later) and nothing else.

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

`--network host` is not optional. Discovery needs multicast (SSDP and mDNS), and the speakers must be able to reach the
advertised IP directly. On a bridge network the container would advertise an address that no speaker can reach.

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

| Option                                    | Environment variable           | Description                                                                |
| ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `-c, --config <FILE>`                     | -                              | Path to YAML config file                                                   |
| `-p, --port <PORT>`                       | `THAUMIC_BIND_PORT`            | HTTP server port (default `49400`)                                         |
| `-a, --advertise-ip <IP>`                 | `THAUMIC_ADVERTISE_IP`         | IP address to advertise to Sonos                                           |
| `-d, --data-dir <DIR>`                    | `THAUMIC_DATA_DIR`             | Directory for persistent data                                              |
| `-l, --log-level <LEVEL>`                 | `THAUMIC_LOG_LEVEL`            | Log level (error/warn/info/debug/trace)                                    |
| `--speaker-monitor <on\|off>`             | `THAUMIC_SPEAKER_MONITOR`      | Speaker monitoring (default `on`)                                          |
| `--pcm-connect-burst-ms <MS>`             | `THAUMIC_PCM_CONNECT_BURST_MS` | Speaker head start, 0-2000 ms (default `500`)                              |
| `--drift-compensation <on\|observe\|off>` | `THAUMIC_DRIFT_COMPENSATION`   | Clock drift correction (default `on`)                                      |
| `--strict-stream-access <BOOL>`           | `THAUMIC_STRICT_STREAM_ACCESS` | Refuse fetches from addresses the cast is not playing on (default `false`) |

A flag overrides an environment variable, which overrides the config file. There are two exceptions.
`THAUMIC_SPEAKER_MONITOR`, `THAUMIC_PCM_CONNECT_BURST_MS` and `THAUMIC_DRIFT_COMPENSATION` are read again each time a
speaker connects, and there they win over both the flag and the config file. And `THAUMIC_SPEAKER_DIAGNOSTICS` turns
speaker monitoring on whatever anything else says.

## Configuration

The installer writes [`config.example.yaml`](config.example.yaml) to `/etc/thaumic-server/config.yaml`; every key is
commented there. The defaults (port `49400`, auto-detected `advertise_ip`, no `data_dir`) are right for a host with
one network interface. A host with several (a VPN, Docker, ...) should have `advertise_ip` set to the address the
speakers can reach: auto-detection has to settle on one of them, when it can settle at all, and it is not always that
one. Set `data_dir` if you mean to add speakers by IP address. Without it they cannot be added.

Three settings concern the speakers themselves, and all three take effect when a speaker next connects.

`speaker_monitor` (on by default) asks each speaker that is playing a cast how much audio it has in reserve. The
speaker notices the apps show are made from the answers.

`pcm_connect_burst_ms` is the speaker head start (500 ms by default, 0 to 2000): audio sent to each speaker in advance
when it connects, so that it has some in reserve when the Wi-Fi stalls. PCM casts only. Raise it if one speaker on a
weak Wi-Fi link cuts out. It adds that much delay, which is the price.

`drift_compensation` is clock drift correction (`on` by default). No two clocks agree exactly, so over a long cast a
speaker slowly uses up its reserve; `on` stretches or squeezes each speaker's PCM audio by at most 150 ppm to hold the
reserve level. `observe` works out the correction, logs it, and leaves the audio alone. `off` does neither. A config
file that leaves the key out gets `on`; one that sets it keeps what it says. It steers by what speaker monitoring
reports, so with `speaker_monitor` off it runs as `off`, and the server says so at startup.

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
| `THAUMIC_DRIFT_COMPENSATION`        | `on`, `observe` or `off`: clock drift correction for PCM casts; needs speaker monitoring     |
| `THAUMIC_STRICT_STREAM_ACCESS`      | `true` refuses audio fetches from addresses the cast is not playing on                       |
| `THAUMIC_PCM_HTTP_FRAMING`          | `chunked` (default); experimental: `length` or `close`: how a PCM stream's body is delimited |
| `THAUMIC_PCM_CONTENT_LENGTH`        | Experimental: the `Content-Length` PCM declares with `length` framing (default `4294967295`) |
| `THAUMIC_PCM_WAV_DATA_SIZE`         | Experimental: the WAV header's data size, 0 to 4294967295 (default `4294967295`)             |
| `THAUMIC_PCM_END_AFTER_BYTES`       | Experimental: end each PCM body cleanly after this many bytes; `chunked` or `close` only     |
| `THAUMIC_PCM_SEGMENT_BYTES`         | Test only: data bytes per PCM segment, 1048576 to 4294901760 (default), whole 10 ms frames   |
| `THAUMIC_PCM_CONTINUATION`          | `auto` (default), `next`, `restart` or `off`: how a speaker moves on to the next PCM segment |
| `THAUMIC_PCM_SEGMENT_DIDL`          | Experimental: `broadcast` (default) or `track`: how a queued PCM segment is described        |
| `THAUMIC_DRIFT_FORCE_PPM`           | Test only: fix every speaker's PCM rate adapter at this many ppm, -300 to 300 (see below)    |

PCM is sent chunked, with no `Content-Length`. The size in a WAV header is a length, and a Playbar, at least, reads it
as one, not as a marker for "unbounded": with 0xFFFFFFFF there, a Sonos Playbar in a field test played past 2^31
bytes, then stopped at exactly 2^32 bytes (6h12m50s at 48 kHz stereo), where it hung up and went to STOPPED with no
reconnect. So a PCM cast is served in segments. Each connection's WAV header declares 4294901760 data bytes
(6h12m49.28s at 48 kHz stereo) and its body ends there; the next segment, `/stream/{id}/live/{n}.wav`, carries on from
the exact sample the previous one ended at, however long the speaker takes to fetch it.

Ten seconds after a speaker reports playing a segment, the server queues the next one as the speaker's next item
(`SetNextAVTransportURI`, described like the cast itself). The speaker fetches it the moment the current segment's
body ends and switches once it has played out what it holds, with no gap and no STOPPED: a Playbar and a Play:1 group
(S2 86.10) both did so in a field probe. Only the segment after the one the speaker is playing is ever queued, and a
queue that the speaker reports cleared is queued again. A speaker that stops on the old segment instead is restarted
as below, and from then on, until the server restarts, every boundary of that speaker is a restart.
`THAUMIC_PCM_CONTINUATION=next` queues the next segment every time regardless (still restarting a speaker that does
not follow it), and `restart` never queues one.

A restart works like this. Once a speaker has played a segment to its end and reported STOPPED on it for a second
(confirmed by asking it), the server tells it to play the next one. What is heard is a short pause (a few seconds),
with no notice and no change in the extension, which is not shown the STOPPED of the switch for the speaker or any
speaker grouped with it. Unless clock drift correction is steering the speaker, it rejoins with just its head start,
so the pause adds no lasting delay; with clock drift correction on, up to 2 s of it is kept and paid back. A speaker
that will not play the next segment is told once more, and then the cast ends on it and the extension says why.
`THAUMIC_PCM_CONTINUATION=off` turns all of this off, and a cast then ends after its first segment.

A fetch that resumes a segment with `Range: bytes=X-` (a speaker coming back from a pause) is answered `206` with
exactly the rest of that segment. `THAUMIC_PCM_SEGMENT_DIDL=track` describes a queued segment as a music track with
its duration and size instead, for comparison: a Playbar then fetches it early and past its end.
`THAUMIC_PCM_SEGMENT_BYTES` shortens segments for testing (`10485760` gives 54.61 s at 48 kHz stereo; the next segment
is only queued with at least 15 s of the current one left, so segments much under 30 s are always restarted). It is
ignored with a warning while a switch that fixes a connection's end (`length` framing, `THAUMIC_PCM_WAV_DATA_SIZE` or
`THAUMIC_PCM_END_AFTER_BYTES`) is set, and those serve PCM on one connection as before.

A speaker that asks over HTTP/1.0, which cannot take chunks, gets an HTTP/1.0 response whose body ends only when the
connection closes (`http=HTTP/1.0, framing=close` on its connection line), as the compressed codecs always have.
Declaring a length ended every PCM cast to a Playbar after 3h06m at 48 kHz (about 3h23m at 44.1 kHz), since a Playbar
caps a declared length at 2^31 bytes.

The `length` and `close` framings and the four experimental variables are switches for field experiments into how
speakers treat a PCM stream. They are not settings. They are read again for each speaker connection, a connection
served with any of them set logs a `[Stream] PCM HTTP switches` line, and an invalid value (including one that is not
valid UTF-8), or one that does not apply to the chosen framing, is ignored with a warning. `length` declares a
`Content-Length` (4294967295 unless `THAUMIC_PCM_CONTENT_LENGTH` says otherwise), as PCM was served before, and so
stops after 3h06m on a Playbar. `close` answers as HTTP/1.0 with `Connection: close`, so the body ends only when the
connection closes. `THAUMIC_PCM_END_AFTER_BYTES` is refused with `length` framing, where ending the body early would
abort the connection, which is not the same as ending it cleanly.

`THAUMIC_DRIFT_FORCE_PPM` exists for blind listening tests of the rate adapter, and should never be left set. While it
holds a number from -300 to 300, every monitored speaker's PCM connection stretches (positive) or squeezes (negative)
its audio by exactly that many ppm, whatever the clock drift correction mode and the controller say. It is read again
for each speaker connection, each connection it applies to logs a `[Drift] THAUMIC_DRIFT_FORCE_PPM=... forcing the
rate adapter; for listening tests only` warning, and the 30 s `[SpeakerMonitor]` line shows `forced=+150ppm`. A value
that is not a number in range is ignored with a warning, logged once per value. The 2 s limit on audio inserted or
removed still applies: once it is reached the adapter holds at 0 ppm and the line shows `forced=+150ppm(pinned)`.
While a rate is forced the drift controller does not learn, so a later cast does not start from what the test did. A
negative rate drains the speaker's reserve the way a fast speaker clock does, so the drift and running-low notices may
appear during a test and suggest turning clock drift correction on. They are describing the forced rate, not the
speaker.

## Running as a service (systemd)

The installer creates the `thaumic` system user, puts the binary in `/usr/local/bin` and the config at
`/etc/thaumic-server/config.yaml`, and installs the unit from [`thaumic-server.service`](thaumic-server.service)
together with its filesystem-sandbox drop-in from [`thaumic-server.service.d/`](thaumic-server.service.d/). To edit
the config before anything runs, use `install.sh --no-start`, which does all of that and stops short of starting the
service.

```bash
sudo systemctl status thaumic-server
journalctl -u thaumic-server -f
sudo systemctl edit thaumic-server      # local overrides survive updates
```

The unit grants `CAP_SYS_NICE` so the streaming workers can raise their scheduling priority. The sandbox drop-in
(`ProtectSystem=strict`, `PrivateTmp`, ...) needs mount namespaces. An unprivileged LXC container without the nesting
feature has none to give, so there the installer skips the drop-in with a warning; turn nesting on, run the installer
again, and the drop-in is put back.

## Proxmox

Use an **LXC container**, not a VM. The server is a single binary and needs no kernel modules, and a container shares
the host's bridge, so multicast discovery works without being arranged. A VM is worth it only if you also want Docker
inside it.

### One command

[`proxmox-lxc.sh`](proxmox-lxc.sh) creates an unprivileged Debian 12 container and runs the installer inside it. On
the Proxmox host, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/brew-lab/thaumic-cast/main/apps/server/proxmox-lxc.sh -o proxmox-lxc.sh
BRIDGE=vmbr0 bash proxmox-lxc.sh
```

Defaults: next free container id, hostname `thaumic-cast`, DHCP, 1 core, 512 MB, 4 GB on `local-lvm`. Each of these
gives way to an environment variable, e.g.
`CTID=120 IP=192.168.1.50/24 GATEWAY=192.168.1.1 VLAN=20 STORAGE=local-zfs bash proxmox-lxc.sh`. The container starts
on boot, and there is no variable for that. The script prints the container's IP and, if you did not set `PASSWORD`,
the root password it made up. Update later with `pct exec <CTID> -- bash -c 'curl -fsSL .../install.sh | bash'` (the
exact command is printed at the end).

### By hand

1. **Create the container.** Debian 12 template, unprivileged; 1 vCPU, 512 MB RAM and a 4 GB disk are plenty. Attach
   the network device to the bridge (and VLAN tag, if any) that your Sonos speakers are on, e.g. `vmbr0`. Give it a
   static IP or a DHCP reservation: this is the address the speakers are told to fetch from, so it should not be one
   that changes.
2. **Install** inside the container with the [installer](#installer-recommended). With a single interface the server
   works out the right `advertise_ip` by itself.
3. **Firewall.** If the Proxmox firewall is enabled for the container, allow inbound `49400/tcp` from the LAN. Discovery
   uses outbound multicast and receives unicast replies, which stateful rules allow by default.
4. **Verify.**

   ```bash
   curl http://<container-ip>:49400/health      # {"status":"ok","appType":"server",...}
   curl http://<container-ip>:49400/api/speakers # should list your Sonos devices
   ```

5. **Point the extension at it.** Settings → Server → Specify manually → `http://<container-ip>:49400` → Connect.
   Chrome asks once whether the extension may "read and change your data" at that address. That is its standard
   wording for access to any site, and here it covers that one host and no other; say yes.

No speakers in the list? Go back to the [network requirements](#network-requirements): same VLAN, or mDNS reflected
across subnets, or add one by IP address with `POST /api/speakers/manual` (`{"ip":"192.168.1.50"}`). It is kept in
`data_dir` and probed on every refresh.

## API endpoints

The server serves the same HTTP/WebSocket API as the desktop app:

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

The API sends no CORS headers. The extension may talk to `localhost` without asking. For a server on another machine
it asks you once, through Chrome's own permission prompt, when you press **Connect** in its settings. Ordinary web
pages cannot read API responses.

## Graceful shutdown

On `SIGINT` (Ctrl+C) or `SIGTERM` the server puts things away before it goes:

1. Stops every cast, and playback on the speakers that were playing one
2. Unsubscribes from the speakers' GENA events
3. Closes the HTTP server and exits

## License

AGPL-3.0
