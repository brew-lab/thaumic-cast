#!/usr/bin/env bash
#
# Thaumic Cast headless server: install / update / uninstall.
#
# Idempotent: run it once to install, run it again to update. Works on any
# systemd-based Linux (Debian, Ubuntu, Proxmox LXC containers, ...) on x86_64
# or aarch64. The only network access is downloading the release tarball and
# its checksum from GitHub; pass --tarball to install from a local file instead.
#
#   curl -fsSL https://raw.githubusercontent.com/brew-lab/thaumic-cast/main/apps/server/install.sh | sudo bash
#
# Options: see --help.
#
set -euo pipefail

REPO="brew-lab/thaumic-cast"
BIN="/usr/local/bin/thaumic-server"
CONFIG_DIR="/etc/thaumic-server"
DATA_DIR="/var/lib/thaumic-server"
UNIT_PATH="/etc/systemd/system/thaumic-server.service"
SANDBOX_DROPIN="$UNIT_PATH.d/10-sandbox.conf"
SERVICE_USER="thaumic"

VERSION=""
TARBALL=""
CHECK_ONLY=0
NO_START=0
UNINSTALL=0
PURGE=0

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --version X.Y.Z   Install a specific release instead of the latest
  --tarball PATH    Install from a local release tarball (no download)
  --check           Show installed vs. latest version and exit
  --no-start        Install but don't (re)start the service
  --uninstall       Stop and remove the service and binary (keeps config/data)
  --purge           With --uninstall: also remove config, data and the user
  -h, --help        Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --tarball) TARBALL="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

log "Thaumic Cast server installer"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash install.sh (or: curl ... | sudo bash)"
command -v systemctl >/dev/null || die "systemd is required"

case "$(uname -m)" in
  x86_64) ARCH="linux-x64" ;;
  aarch64|arm64) ARCH="linux-arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

# Prints the version of a thaumic-server binary ("thaumic-server 1.2.3" -> "1.2.3").
binary_version() { "$1" --version 2>/dev/null | awk '{print $2}'; }

latest_version() {
  command -v curl >/dev/null || die "curl is required to look up releases"
  log "Checking the latest release on GitHub" >&2
  # Captured first so no pipe stage can hit SIGPIPE under pipefail.
  local json
  json="$(curl -fsSL --connect-timeout 10 --max-time 30 "https://api.github.com/repos/$REPO/releases/latest")"
  printf '%s\n' "$json" | sed -n '/"tag_name"/{s/.*"tag_name": *"v\([^"]*\)".*/\1/p;q}'
}

# ── Uninstall ────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  log "Stopping and removing thaumic-server"
  systemctl disable --now thaumic-server 2>/dev/null || true
  rm -rf "$UNIT_PATH" "$UNIT_PATH.d" "$BIN"
  systemctl daemon-reload
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$CONFIG_DIR" "$DATA_DIR"
    userdel "$SERVICE_USER" 2>/dev/null || true
    log "Removed config, data and the $SERVICE_USER user"
  else
    log "Kept $CONFIG_DIR and $DATA_DIR (use --purge to remove them)"
  fi
  exit 0
fi

# ── Check ────────────────────────────────────────────────────────────────────
CURRENT=""
if [ -x "$BIN" ]; then
  CURRENT="$(binary_version "$BIN")"
fi
if [ "$CHECK_ONLY" -eq 1 ]; then
  LATEST="$(latest_version)"
  echo "installed: ${CURRENT:-none}"
  echo "latest:    ${LATEST:-unknown}"
  if [ -n "$CURRENT" ] && [ "$CURRENT" = "$LATEST" ]; then
    echo "up to date"
  else
    echo "update available: re-run without --check"
  fi
  exit 0
fi

# ── Obtain tarball ───────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
  cp "$TARBALL" "$TMP/"
  ARCHIVE="$TMP/$(basename "$TARBALL")"
  [ -f "$TARBALL.sha256" ] && cp "$TARBALL.sha256" "$TMP/"
else
  command -v curl >/dev/null || die "curl is required (apt-get install -y curl ca-certificates)"
  [ -n "$VERSION" ] || VERSION="$(latest_version)"
  [ -n "$VERSION" ] || die "could not determine the latest release; pass --version X.Y.Z"
  NAME="thaumic-server-v$VERSION-$ARCH.tar.gz"
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  log "Downloading $NAME"
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 600 -o "$TMP/$NAME" "$BASE/$NAME" \
    || die "download failed: $BASE/$NAME (does this release ship server binaries?)"
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 30 -o "$TMP/$NAME.sha256" "$BASE/$NAME.sha256" \
    || die "checksum download failed: $BASE/$NAME.sha256"
  ARCHIVE="$TMP/$NAME"
fi

if [ -f "$ARCHIVE.sha256" ]; then
  log "Verifying checksum"
  (cd "$TMP" && sha256sum -c --quiet "$(basename "$ARCHIVE").sha256") || die "checksum mismatch"
else
  warn "no .sha256 next to the tarball; skipping checksum verification"
fi

tar -xzf "$ARCHIVE" -C "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d -name 'thaumic-server-*' -print -quit)"
[ -n "$SRC" ] && [ -x "$SRC/thaumic-server" ] || die "unexpected tarball layout"
NEW_VERSION="$(binary_version "$SRC/thaumic-server")"

# ── Install ──────────────────────────────────────────────────────────────────
# The data directory itself is created and owned via StateDirectory= in the unit.
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user $SERVICE_USER"
  useradd --system --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

log "Installing thaumic-server ${NEW_VERSION:-?}${CURRENT:+ (replacing $CURRENT)}"
install -m 755 "$SRC/thaumic-server" "$BIN.new"
mv -f "$BIN.new" "$BIN"

mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
  log "Writing default config to $CONFIG_DIR/config.yaml"
  install -m 644 "$SRC/config.example.yaml" "$CONFIG_DIR/config.yaml"
fi

# The unit and its drop-ins are owned by the installer so fixes ship with
# updates. Local changes belong in your own drop-in: systemctl edit thaumic-server
install -m 644 "$SRC/thaumic-server.service" "$UNIT_PATH"
mkdir -p "$UNIT_PATH.d"
if command -v unshare >/dev/null && ! unshare -m true >/dev/null 2>&1; then
  warn "mount namespaces unavailable (unprivileged container without nesting); skipping filesystem sandboxing"
  rm -f "$SANDBOX_DROPIN"
else
  install -m 644 "$SRC/thaumic-server.service.d/10-sandbox.conf" "$SANDBOX_DROPIN"
fi
systemctl daemon-reload
systemctl enable thaumic-server >/dev/null 2>&1

if [ "$NO_START" -eq 1 ]; then
  log "Installed. Start with: systemctl start thaumic-server"
  exit 0
fi

log "Starting service"
systemctl restart thaumic-server

PORT="$(sed -n '/^bind_port:/{s/^bind_port: *\([0-9]*\).*/\1/p;q}' "$CONFIG_DIR/config.yaml")"
PORT="${PORT:-49400}"
for _ in $(seq 1 20); do
  if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo
    log "thaumic-server $NEW_VERSION is running"
    echo "    Extension server URL:  http://${IP:-<this-host-ip>}:$PORT"
    echo "    Config:                $CONFIG_DIR/config.yaml"
    echo "    Logs:                  journalctl -u thaumic-server -f"
    echo "    Update:                re-run this script"
    exit 0
  fi
  sleep 0.5
done
warn "service did not answer on port $PORT within 10s"
echo
systemctl --no-pager -l status thaumic-server || true
echo
journalctl -u thaumic-server -n 30 --no-pager || true
exit 1
