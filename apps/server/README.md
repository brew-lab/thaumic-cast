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

# Discovery methods
discovery_ssdp_multicast: true
discovery_ssdp_broadcast: true
discovery_mdns: true
```

### Environment Variables

All config options can be overridden with environment variables:

| Variable                            | Description                         |
| ----------------------------------- | ----------------------------------- |
| `THAUMIC_BIND_PORT`                 | HTTP server port                    |
| `THAUMIC_ADVERTISE_IP`              | Advertise IP address                |
| `THAUMIC_TOPOLOGY_REFRESH_INTERVAL` | Topology refresh interval (seconds) |
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

| Endpoint                   | Description                              |
| -------------------------- | ---------------------------------------- |
| `GET /api/groups`          | List Sonos groups                        |
| `GET /api/stats`           | Server statistics                        |
| `POST /api/playback/start` | Start playback on a speaker              |
| `WS /ws`                   | WebSocket for real-time events and audio |
| `GET /stream/{id}/live`    | Audio stream endpoint (for Sonos)        |

## Graceful Shutdown

The server handles `SIGINT` (Ctrl+C) and `SIGTERM` gracefully:

1. Stops accepting new connections
2. Stops playback on all speakers
3. Unsubscribes from GENA notifications
4. Exits cleanly

## License

MIT
