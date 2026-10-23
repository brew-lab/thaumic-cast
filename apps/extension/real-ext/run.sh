#!/usr/bin/env bash
# The real-extension check: builds the extension and the companion, starts the companion on the
# fake household, and runs check.mjs in real Chromium under a virtual display, once per scale
# and scheme, then lifecycle.mjs and upgrade.mjs once. See README.md.
#
#   apps/extension/real-ext/run.sh                 # 100 % light, then 125 % dark
#   RUNS="1:light" apps/extension/real-ext/run.sh  # one run
#   SKIP_BUILD=1 ...                               # reuse dist/ and the companion binary
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
RUNS="${RUNS:-1:light 1.25:dark}"

if [ -z "${SKIP_BUILD:-}" ]; then
  (cd "$ROOT/apps/extension" && bun run build >/dev/null)
fi
# The companion is an ignored test in thaumic-core; --no-run builds it and names the binary.
BIN=$(cd "$ROOT" && cargo test -p thaumic-core --lib --no-run --message-format=json 2>/dev/null |
  sed -n 's/.*"executable":"\([^"]*thaumic_core[^"]*\)".*/\1/p' | tail -1)
[ -n "$BIN" ] || { echo "could not build the thaumic-core test binary" >&2; exit 1; }

status=0
for run in $RUNS; do
  scale="${run%%:*}"
  scheme="${run##*:}"
  log="$(mktemp)"
  "$BIN" testing::real_ext_companion::real_ext_companion --ignored --nocapture --exact >"$log" 2>&1 &
  companion=$!
  for _ in $(seq 1 40); do
    grep -q "REALEXT control" "$log" && break
    sleep 0.25
  done
  echo "== $scale $scheme =="
  SCALE="$scale" SCHEME="$scheme" xvfb-run -a -s "-screen 0 1400x1000x24" \
    node "$HERE/check.mjs" || status=1
  kill "$companion" 2>/dev/null || true
  wait "$companion" 2>/dev/null || true
  rm -f "$log"
done
# Once: the lifecycle pass starts and stops its own companion.
echo "== lifecycle =="
BIN="$BIN" xvfb-run -a -s "-screen 0 1400x1000x24" node "$HERE/lifecycle.mjs" || status=1
# Once: a build copied over the running extension (needs no companion).
echo "== upgrade =="
xvfb-run -a -s "-screen 0 1400x1000x24" node "$HERE/upgrade.mjs" || status=1
exit $status
