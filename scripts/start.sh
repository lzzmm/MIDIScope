#!/usr/bin/env bash
# midivis offline launcher (macOS / Linux).
# Tries the bundled static-web-server binary first, then falls back to
# python3, python, or `npx serve` — whichever is available.

set -e
cd "$(dirname "$0")/.."   # repo root (script lives in scripts/)

PORT="${MIDIVIS_PORT:-5173}"
URL="http://127.0.0.1:${PORT}/"

OS="$(uname -s)"
ARCH="$(uname -m)"
BIN=""
case "$OS" in
  Darwin)
    [ "$ARCH" = "arm64" ] && BIN="vendor/serve-mac-arm64"
    [ "$ARCH" = "x86_64" ] && BIN="vendor/serve-mac-x64"
    ;;
  Linux)
    BIN="vendor/serve-linux-x64"
    ;;
esac

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  else echo "Open this URL in your browser: $URL"
  fi
}

start_with() {
  echo "[midivis] Serving $(pwd) on $URL"
  ( sleep 1 && open_browser ) &
  exec "$@"
}

if [ -n "$BIN" ] && [ -x "$BIN" ]; then
  start_with "$BIN" --root "$(pwd)" --port "$PORT" --host 127.0.0.1
fi

if command -v python3 >/dev/null 2>&1; then
  start_with python3 -m http.server "$PORT" --bind 127.0.0.1
fi
if command -v python >/dev/null 2>&1; then
  start_with python -m http.server "$PORT" --bind 127.0.0.1
fi
if command -v npx >/dev/null 2>&1; then
  start_with npx --yes serve -l "$PORT" .
fi

cat <<EOF
[midivis] Could not find a way to serve the files.
Tried: bundled static-web-server, python3, python, npx serve.

Quick fixes:
  • Install Python 3 (https://www.python.org/) and re-run this script.
  • Or install Node.js (https://nodejs.org/) and re-run this script.
  • Or open the GitHub Pages URL of this project in your browser.
EOF
exit 1
