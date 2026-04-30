#!/usr/bin/env bash
# Usage: scripts/bump-version.sh 0.4.10
# Rewrites every relative ES-module import in src/*.js to carry
# `?v=<VERSION>`, and updates the dynamic-import cache-buster in
# index.html and the VERSION/BUILD_DATE constants in src/version.js.
# Static ES-module imports cannot template a query string at runtime,
# so we hard-code the version into the import strings on every release.
set -euo pipefail
V="${1:?usage: bump-version.sh <semver>}"
cd "$(dirname "$0")/.."
find src -name "*.js" -print0 | xargs -0 perl -i -pe \
  's{from "\./([a-zA-Z0-9_]+)\.js(\?v=[^"]*)?"}{from "./$1.js?v='"$V"'"}g'
perl -i -pe 's{import\("\./src/main\.js\?v=[^"]*"\)}{import("./src/main.js?v='"$V"'")}' index.html
perl -i -pe 's{export const VERSION\s*=\s*"[^"]*";}{export const VERSION    = "'"$V"'";}' src/version.js
TODAY="$(date +%Y-%m-%d)"
perl -i -pe 's{export const BUILD_DATE\s*=\s*"[^"]*";}{export const BUILD_DATE = "'"$TODAY"'";}' src/version.js
echo "bumped to $V (build $TODAY)"
