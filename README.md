# MIDIScope

A browser-based MIDI visualizer + sampler player. Open a `.mid` file and see it
animate as a multi-voice piano-roll with chord names, multiple animation
presets, exportable score images (PNG / PDF), and exportable structured data
(CSV / XLSX).

## Try it online

No install needed. Open in any modern browser (Chrome, Edge, Safari, Firefox):

**https://lzzmm.github.io/MIDIScope/**

The first time you press play with the **Realistic** timbre, the page fetches
piano + flute samples (~10 MB, cached afterwards). The **Synth** timbre needs
no download.

## Run offline (no install)

If you'd rather run it locally without internet (after the first sample
download), grab a release ZIP from the **Releases** tab and:

- **macOS** — double-click `start.command`
- **Windows** — double-click `start.bat`
- **Linux** — run `./start.sh`

These spawn a tiny bundled static web server (~3 MB) on
`http://127.0.0.1:5173` and open your default browser. **No Python or Node
required.**

If your antivirus blocks the bundled binary, the script falls back
automatically to whatever you have installed (`python3 -m http.server`,
`python -m http.server`, `npx serve`).

### macOS Gatekeeper note

The first time you run `start.command`, macOS may show a "cannot be opened
because the developer cannot be verified" warning. Either right-click the
file → Open, or unblock from Terminal:

```bash
xattr -dr com.apple.quarantine /path/to/midivis-folder
```

## Features

- **Piano-roll visualization** — DPR-aware Canvas 2D rendering with grid,
  notes, voice connections, chord labels, and a minimap.
- **Voice splitting** — piano tracks are clustered into Bass / Chords / Melody;
  flute and other tracks become their own voices. Per-voice mute / solo.
- **Chord naming** — automatic naming with inversions (e.g. `Em7/G`).
- **10 visual presets** — Score, Print, Neon, Live trace, Pulse, Comet,
  Ripple, Glow, Aurora, Minimal. Plus per-layer toggles and Style sliders
  (dot size, line width, line opacity).
- **Realistic samplers** — Salamander piano (A0–C8) + nbrosowsky flute via
  Tone.js, with master reverb. Falls back to PolySynth automatically.
- **Image export** — multi-system PNG/PDF that wraps long pieces into N rows
  to keep a printable aspect ratio. Optional instrument-color legend.
- **Data export** — CSV / XLSX with multiple presets:
  - **Notes (long form)** — one row per onset; lossless.
  - **Score grid (per beat / ½ / ¼ / bar)** — wide layout with `time | bar |
    beat | Melody | Harmony | Bass | Flute` columns.
  - **Chord progression** — one row per chord change.
  - **Custom** — pick your own grouping + columns; choices saved locally.
- **Light / dark theme** with theme-aware blend modes (animations stay
  readable on white).

## Sidebar reference

All sections are collapsible (click the header). The open/closed state is
remembered across reloads. Hover any control for a one-line tooltip.

| Section        | What it does                                                       |
| -------------- | ------------------------------------------------------------------ |
| Voices         | Mute / solo individual instrument lines.                           |
| Preset         | Apply a built-in visual preset.                                    |
| Layers         | Toggle individual visual layers (grid, connections, glow, …).      |
| Style          | Sliders: dot size, line width, line opacity.                       |
| Sound          | Choose timbre (Realistic / Synth) and reverb amount.               |
| Analysis       | Bass-cutoff slider — fallback hand-split when no chords detected.  |
| Image export   | Multi-system PNG / PDF score with optional legend.                 |
| Data export    | CSV / XLSX with preset row shapes or custom column picker.         |

## Data export — example outputs

**Notes (long form)** for a tiny CMaj triad + Am triad:

```
time,bar,beat,voice,pitch,midi,duration_sec,velocity,chord_name
0,1,1,Chords,C4,60,0.5,0.7,C
0,1,1,Chords,E4,64,0.5,0.7,C
0,1,1,Chords,G4,67,0.5,0.7,C
2,1,3,Chords,A3,57,0.5,0.7,Am
```

**Score grid (per beat)**:

```
time,bar,beat,Melody,Harmony,Bass
0,1,1,E4+F4,C,
1,1,2,G4,C,
2,1,3,,Am,
```

**Chord progression**:

```
time,bar,beat,chord_name,chord_root,chord_quality,chord_bass,duration_sec
0,1,1,C,C,,,2
2,1,3,Am,A,m,,0.5
```

XLSX exports use the same shape but as a true Excel workbook (lazy-loads
[SheetJS](https://sheetjs.com/) only when you pick XLSX).

## Develop

The whole app is plain ES modules + CDN imports — no bundler needed. Any
static server works:

```bash
cd midivis
python3 -m http.server 5173
# open http://127.0.0.1:5173/
```

Project layout:

```
index.html
style.css
src/
  main.js          UI wiring + tooltip + collapsibles + export hooks
  midiLoader.js    MIDI parsing (uses @tonejs/midi)
  voicing.js       Voice/chord splitter + palette
  chordName.js     Chord namer with inversions
  render.js        Canvas renderer (live + minimap)
  scoreExport.js   Multi-system PNG/PDF export
  dataExport.js    CSV / XLSX builder + serializers
  player.js        Tone.js sampler / synth player
midi/                                demo MIDI files
```

## Browser support

Chrome / Edge / Safari / Firefox latest. Audio requires a user gesture to
unlock (clicking Play counts).

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [Tone.js](https://tonejs.github.io/) — Web Audio framework + samplers
- [@tonejs/midi](https://github.com/Tonejs/Midi) — MIDI parsing
- [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) — piano samples (CC-BY)
- [SheetJS Community Edition](https://sheetjs.com/) — XLSX export
- [jsPDF](https://github.com/parallax/jsPDF) — PDF wrapping
