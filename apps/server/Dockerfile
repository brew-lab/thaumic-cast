# syntax=docker/dockerfile:1
# Build from the repository root so the Cargo workspace is available:
#   docker build -f apps/server/Dockerfile -t thaumic-server .
#
# The dependency tree needs Rust 1.88+; `rust:1` tracks the latest stable.
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY . .
# Cache mounts keep the crate registry and compiled dependencies across builds,
# so a source edit only recompiles the workspace crates. The binary is copied
# out inside the same step because cache mounts are not part of the layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked -p thaumic-server \
    && install -m 755 target/release/thaumic-server /thaumic-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /var/lib/thaumic-server --create-home thaumic
COPY --from=builder /thaumic-server /usr/local/bin/thaumic-server

# Manual speakers and optional artwork.jpg persist here.
ENV THAUMIC_DATA_DIR=/var/lib/thaumic-server
VOLUME ["/var/lib/thaumic-server"]

# Sonos speakers must reach this port on the advertised IP. SSDP/mDNS discovery
# needs multicast, so run with `--network host` (see README).
EXPOSE 49400
USER thaumic
ENTRYPOINT ["thaumic-server"]
