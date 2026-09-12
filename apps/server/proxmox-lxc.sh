#!/usr/bin/env bash
#
# Creates a Proxmox LXC container and installs the Thaumic Cast headless server
# in it. Run on the Proxmox host as root:
#
#   bash proxmox-lxc.sh
#
# Everything is configurable through environment variables:
#
#   CTID=120                 container id (default: next free id)
#   CT_HOSTNAME=thaumic-cast
#   BRIDGE=vmbr0             bridge your Sonos speakers are reachable from
#   VLAN=                    optional VLAN tag
#   IP=dhcp                  or e.g. IP=192.168.1.50/24 GATEWAY=192.168.1.1
#   STORAGE=local-lvm        rootfs storage
#   TEMPLATE_STORAGE=local   where the Debian template is downloaded to
#   DISK=4 MEMORY=512 CORES=1
#   PASSWORD=                root password for the CT (default: random, printed)
#   SERVER_VERSION=          pin a release; default latest
#   LOCAL_TARBALL=           install from a local release tarball instead of GitHub
#   LOCAL_INSTALLER=         use a local copy of install.sh instead of fetching it
#
set -euo pipefail

CT_HOSTNAME="${CT_HOSTNAME:-thaumic-cast}"
BRIDGE="${BRIDGE:-vmbr0}"
VLAN="${VLAN:-}"
IP="${IP:-dhcp}"
GATEWAY="${GATEWAY:-}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK="${DISK:-4}"
MEMORY="${MEMORY:-512}"
CORES="${CORES:-1}"
PASSWORD="${PASSWORD:-}"
SERVER_VERSION="${SERVER_VERSION:-}"
LOCAL_TARBALL="${LOCAL_TARBALL:-}"
LOCAL_INSTALLER="${LOCAL_INSTALLER:-}"
INSTALLER_URL="https://raw.githubusercontent.com/brew-lab/thaumic-cast/main/apps/server/install.sh"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

log "Thaumic Cast Proxmox LXC helper"
command -v pct >/dev/null || die "pct not found; run this on a Proxmox VE host"
[ "$(id -u)" -eq 0 ] || die "run as root"

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
pct status "$CTID" >/dev/null 2>&1 && die "container $CTID already exists"

if [ -z "$PASSWORD" ]; then
  PASSWORD="$(openssl rand -hex 12)"
  GENERATED_PASSWORD=1
fi

log "Finding the latest Debian 12 template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -n1)"
[ -n "$TEMPLATE" ] || die "no debian-12-standard template available"
if ! pveam list "$TEMPLATE_STORAGE" | grep -F "$TEMPLATE" >/dev/null; then
  log "Downloading $TEMPLATE to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

NET="name=eth0,bridge=$BRIDGE,ip=$IP"
[ "$IP" != "dhcp" ] && [ -n "$GATEWAY" ] && NET="$NET,gw=$GATEWAY"
[ -n "$VLAN" ] && NET="$NET,tag=$VLAN"

# nesting=1 matches the Proxmox GUI default for unprivileged containers and lets
# systemd use mount namespaces for the unit's filesystem sandboxing.
log "Creating unprivileged container $CTID ($CT_HOSTNAME) on $BRIDGE"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --unprivileged 1 \
  --features nesting=1 \
  --ostype debian \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --swap 0 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "$NET" \
  --password "$PASSWORD" \
  --onboot 1 \
  --start 1 >/dev/null

log "Waiting for network inside the container"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1'; then break; fi
  sleep 1
done

log "Installing curl"
pct exec "$CTID" -- sh -c 'export LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive; apt-get -qq update && apt-get -qq install -y curl ca-certificates >/dev/null'

INSTALL_ARGS=()
if [ -n "$LOCAL_TARBALL" ]; then
  [ -f "$LOCAL_TARBALL" ] || die "LOCAL_TARBALL not found: $LOCAL_TARBALL"
  TARBALL_NAME="$(basename "$LOCAL_TARBALL")"
  pct push "$CTID" "$LOCAL_TARBALL" "/root/$TARBALL_NAME"
  [ -f "$LOCAL_TARBALL.sha256" ] && pct push "$CTID" "$LOCAL_TARBALL.sha256" "/root/$TARBALL_NAME.sha256"
  INSTALL_ARGS=(--tarball "/root/$TARBALL_NAME")
elif [ -n "$SERVER_VERSION" ]; then
  INSTALL_ARGS=(--version "$SERVER_VERSION")
fi

if [ -n "$LOCAL_INSTALLER" ]; then
  pct push "$CTID" "$LOCAL_INSTALLER" /root/install.sh
else
  pct exec "$CTID" -- sh -c "curl -fsSL --connect-timeout 10 --max-time 60 '$INSTALLER_URL' -o /root/install.sh"
fi

log "Running the installer"
pct exec "$CTID" -- bash /root/install.sh ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}

CT_IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
log "Done. Container $CTID ($CT_HOSTNAME) is running at ${CT_IP:-<unknown>}"
[ -n "${GENERATED_PASSWORD:-}" ] && echo "    root password:   $PASSWORD"
echo "    Shell:           pct enter $CTID"
echo "    Update:          pct exec $CTID -- bash -c 'curl -fsSL $INSTALLER_URL | bash'"
