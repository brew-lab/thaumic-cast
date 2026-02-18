# thaumic-server

Standalone headless server for Thaumic Cast.

## Overview

This is a headless server binary that provides the same audio streaming functionality as the Thaumic Cast desktop app, but without a GUI. It's designed for:

- Server/NAS deployments
- Docker containers
- Headless Linux systems
- Running as a system service

## Installation

### From Source

```bash
cargo build --release -p thaumic-server
```

The binary will be at `target/release/thaumic-server`.

## Usage

```bash
# Run with default settings
thaumic-server

# Run with a config file
thaumic-server --config /path/to/config.yaml

# Run with CLI overrides
thaumic-server --port 8080 --advertise-ip 192.168.1.100

# Set log level
thaumic-server --log-level debug
```

### CLI Options

| Option                    | Environment Variable   | Description                             |
| ------------------------- | ---------------------- | --------------------------------------- |
| `-c, --config <FILE>`     | -                      | Path to YAML config file                |
| `-p, --port <PORT>`       | `THAUMIC_BIND_PORT`    | HTTP server port                        |
| `-a, --advertise-ip <IP>` | `THAUMIC_ADVERTISE_IP` | IP address to advertise to Sonos        |
| `-d, --data-dir <DIR>`    | `THAUMIC_DATA_DIR`     | Directory for persistent data           |
| `-l, --log-level <LEVEL>` | `THAUMIC_LOG_LEVEL`    | Log level (error/warn/info/debug/trace) |

## Configuration

Create a `config.yaml` file (see `config.example.yaml`):

```yaml
# Port to bind the HTTP server to
bind_port: 49400

# IP address to advertise to Sonos speakers
# This must be reachable from your Sonos speakers
advertise_ip: '192.168.1.100'

# Topology refresh interval in seconds
topology_refresh_interval: 30

# Directory for persistent data (manual speakers, etc.)
# data_dir: '/var/lib/thaumic-server'

# Custom artwork URL for Sonos album art (optional, must be HTTPS for Android)
# artwork_url: 'https://cdn.example.com/my-artwork.jpg'
```

### Environment Variables

All config options can be overridden with environment variables:

| Variable                            | Description                         |
| ----------------------------------- | ----------------------------------- |
| `THAUMIC_BIND_PORT`                 | HTTP server port                    |
| `THAUMIC_ADVERTISE_IP`              | Advertise IP address                |
| `THAUMIC_TOPOLOGY_REFRESH_INTERVAL` | Topology refresh interval (seconds) |
| `THAUMIC_DATA_DIR`                  | Directory for persistent data       |
| `THAUMIC_ARTWORK_URL`               | Custom artwork URL for Sonos        |
| `THAUMIC_LOG_LEVEL`                 | Log level                           |

## Running as a Service

### systemd (Linux)

Create `/etc/systemd/system/thaumic-server.service`:

```ini
[Unit]
Description=Thaumic Cast Server
After=network.target

[Service]
Type=simple
User=thaumic
ExecStart=/usr/local/bin/thaumic-server --config /etc/thaumic-server/config.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable thaumic-server
sudo systemctl start thaumic-server
```

### Docker

```dockerfile
FROM rust:1.75 as builder
WORKDIR /app
COPY . .
RUN cargo build --release -p thaumic-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/thaumic-server /usr/local/bin/
EXPOSE 49400
CMD ["thaumic-server"]
```

## API Endpoints

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
| `GET /stream/{id}/live[.wav\|.flac]` | Audio stream endpoint (for Sonos)        |
| `GET /artwork.jpg`                   | Album artwork for Sonos display          |
| `WS /ws`                             | WebSocket for real-time events and audio |

## Graceful Shutdown

The server handles `SIGINT` (Ctrl+C) and `SIGTERM` gracefully:

1. Stops accepting new connections
2. Stops playback on all speakers
3. Unsubscribes from GENA notifications
4. Exits cleanly

## License

MIT
