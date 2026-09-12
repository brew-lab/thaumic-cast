---
'@thaumic-cast/server': patch
---

feat(server): one-command install, update and Proxmox setup

Releases now include `thaumic-server-vX.Y.Z-linux-{x64,arm64}.tar.gz` with checksums, a hardened systemd unit and
`install.sh`. The installer (`curl … | sudo bash`) installs or updates in place, verifies checksums and only ever
contacts GitHub releases. `proxmox-lxc.sh` creates an unprivileged Debian 12 container on a Proxmox host and runs the
installer inside it. Added `apps/server/Dockerfile`, refreshed the README (Proxmox guide, network requirements,
correct Rust version) and made the release version sync refresh `Cargo.lock` so `cargo build --locked` passes after a
release.
