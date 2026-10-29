#!/usr/bin/env bash
# serve.sh — start the Maigo-chan preview on :8080 (idempotent, safe to re-run)
#
#   ./serve.sh              # serve this folder on 0.0.0.0:8080
#   PORT=9000 ./serve.sh    # different port
#
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8080}"
BIND="${BIND:-0.0.0.0}"

# --- already serving? then do nothing -------------------------------------
if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/index.html"; then
  echo "✓ already serving on http://localhost:${PORT}/ — nothing to do"
  exit 0
fi

# --- clear a stale/zombie process still holding the port -------------------
if command -v ss >/dev/null 2>&1; then
  STALE=$(ss -tlnp 2>/dev/null | awk -v p=":${PORT}\$" '$4 ~ p {print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -n1 || true)
  if [ -n "${STALE:-}" ]; then
    echo "… killing stale listener on :${PORT} (pid ${STALE})"
    kill -9 "${STALE}" 2>/dev/null || true
    sleep 0.4
  fi
fi

# --- sanity: the game's entry points must exist ---------------------------
for f in index.html styles.css js/main.js js/world.js js/audio.js js/mechanics.js \
         js/vendor/three.module.js js/vendor/addons/loaders/GLTFLoader.js; do
  [ -f "$f" ] || { echo "✗ missing required file: $f" >&2; exit 1; }
done

echo "▸ serving $(pwd) on http://${BIND}:${PORT}/  (ctrl-c to stop)"
exec env PORT="${PORT}" BIND="${BIND}" python3 serve.py
