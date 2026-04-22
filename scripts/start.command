#!/usr/bin/env bash
# Double-clickable launcher for macOS Finder. Forwards to start.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/start.sh"
