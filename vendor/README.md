# midivis vendored static-web-server binaries

This folder is intended to hold tiny static-file-server binaries (one per OS)
so the offline launcher scripts in `../scripts/` can serve the app without
requiring Python or Node.js.

Recommended binary: **static-web-server**
- Project: https://static-web-server.net/
- License: Apache-2.0
- Single static binary, ~3-5 MB per OS.

Drop the per-OS binaries here using these exact filenames (the launcher
scripts look for them by name):

```
serve-mac-arm64        # macOS Apple Silicon
serve-mac-x64          # macOS Intel
serve-linux-x64        # Linux x86_64
serve-win-x64.exe      # Windows x86_64
```

After adding the binaries:

```bash
chmod +x vendor/serve-mac-arm64 vendor/serve-mac-x64 vendor/serve-linux-x64
```

If a binary is missing, the launcher scripts automatically fall back to
`python3 -m http.server` / `python -m http.server` / `npx serve`.

Download links (current as of 2026):
- macOS arm64: https://github.com/static-web-server/static-web-server/releases — pick `*-aarch64-apple-darwin.tar.gz`
- macOS x64:   `*-x86_64-apple-darwin.tar.gz`
- Linux x64:   `*-x86_64-unknown-linux-gnu.tar.gz`
- Windows x64: `*-x86_64-pc-windows-msvc.zip`

Each archive contains a single `static-web-server` (or `.exe`) binary —
extract and rename to the filenames above.
