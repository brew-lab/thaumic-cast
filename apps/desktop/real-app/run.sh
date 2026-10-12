#!/usr/bin/env bash
# The real-app check: builds the desktop frontend (its production bundle) and the companion,
# starts the companion on the fake household with the desktop's IPC, and runs check.mjs in
# Playwright's WebKit and Chromium, once per engine, scale and scheme. See README.md.
#
#   apps/desktop/real-app/run.sh                          # the four runs below
#   RUNS="webkit:1:light" apps/desktop/real-app/run.sh    # one run
#   SKIP_BUILD=1 ...                                      # reuse dist/
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
RUNS="${RUNS:-chromium:1:light chromium:1.25:dark webkit:1:light webkit:1.25:dark}"
# Ports of their own, so the real-extension rig can run alongside.
export REALEXT_PORT="${REALEXT_PORT:-49410}"
export REALEXT_CONTROL_PORT="${REALEXT_CONTROL_PORT:-49509}"
export REALAPP_PORT="${REALAPP_PORT:-49520}"
COMPANION="$ROOT/packages/thaumic-core/src/testing/real_desktop.rs"

# Every command the app registers must be answered by the companion, or the rig is not the app.
missing=""
for cmd in $(sed -n '/generate_handler!\[/,/\]/p' "$ROOT/apps/desktop/src-tauri/src/lib.rs" |
  grep -oE '^\s+[a-z_]+' | tr -d ' '); do
  grep -q "\"$cmd\" =>" "$COMPANION" || missing="$missing $cmd"
done
[ -z "$missing" ] || { echo "real_desktop.rs answers no:$missing" >&2; exit 1; }

if [ -z "${SKIP_BUILD:-}" ]; then
  (cd "$ROOT/apps/desktop" && bun run build >/dev/null)
fi
# The companion is an ignored test in thaumic-core; --no-run builds it and names the binary.
BIN=$(cd "$ROOT" && cargo test -p thaumic-core --lib --no-run --message-format=json 2>/dev/null |
  sed -n 's/.*"executable":"\([^"]*thaumic_core[^"]*\)".*/\1/p' | tail -1)
[ -n "$BIN" ] || { echo "could not build the thaumic-core test binary" >&2; exit 1; }

status=0
for run in $RUNS; do
  IFS=: read -r engine scale scheme <<<"$run"
  log="$(mktemp)"
  "$BIN" testing::real_desktop::real_desktop_companion --ignored --nocapture --exact >"$log" 2>&1 &
  companion=$!
  for _ in $(seq 1 40); do
    grep -q "REALAPP control" "$log" && break
    sleep 0.25
  done
  grep -q "REALAPP control" "$log" || { cat "$log" >&2; kill "$companion" 2>/dev/null; exit 1; }
  echo "== $engine $scale $scheme =="
  ENGINE="$engine" SCALE="$scale" SCHEME="$scheme" node "$HERE/check.mjs" || status=1
  kill "$companion" 2>/dev/null || true
  wait "$companion" 2>/dev/null || true
  rm -f "$log"
done
exit $status
