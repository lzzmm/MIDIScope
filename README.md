<div align="center">

# 🎼 MIDIScope

**A modern, browser-based MIDI visualizer & player.**
Drop in a `.mid` file → see it animate as a multi-voice piano-roll, hear it
played back through sampled instruments, and export it as a printable score
or as analysis-ready CSV / XLSX.

[![Live demo](https://img.shields.io/badge/live%20demo-MIDIScope-6cc4ff?style=flat-square)](https://lzzmm.github.io/MIDIScope/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![No build step](https://img.shields.io/badge/build-none-brightgreen.svg?style=flat-square)](#develop)

[**English**](README.md) · [**简体中文**](README.zh-CN.md)

</div>

---

## ✨ Highlights

- 🎹 **Piano-roll visualization** — DPR-aware Canvas 2D with per-voice colors,
  smooth melody lines, chord stems, root-progression lines and a minimap.
- 🪄 **13 toggleable visual layers** — pulse, comet, ripple, glow, aurora,
  live trace, beam, … plus 10 ready-made presets (Score / Print / Neon /
  Pulse / Comet / Ripple / Glow / Aurora / Live trace / Minimal).
- 🎼 **Smart voice splitting** — piano tracks auto-cluster into Bass /
  Harmony / Melody; chord names are recognized with inversions (e.g.
  `Em7/G`).
- 🎚 **Modern transport** — large BAR · BEAT · TEMPO · TIME-SIG · KEY
  readouts, fine-grained zoom (4 – 2000 px/s), every slider has a numeric
  input + ± fine-step buttons.
- 🔊 **Realistic playback** — Salamander Grand Piano (A0–C8) + nbrosowsky
  flute samples through Tone.js, with master reverb. Falls back to a
  PolySynth automatically.
- 🖼 **Image export** — multi-system PNG / PDF that wraps long pieces into
  N rows to keep a printable aspect ratio.
- 📊 **Data export** — CSV / XLSX in four layouts (Notes long-form, Score
  grid per beat, Per-instrument grid, Chord progression) plus a fully
  custom column picker.
- 🌗 **Light / dark theme** with theme-aware blend modes — animations stay
  readable on white paper.

## 🚀 Try it online

No install needed. Open in any modern browser:

> **<https://lzzmm.github.io/MIDIScope/>**

The first time you press play with the *Realistic* timbre, the page fetches
piano + flute samples (~10 MB, cached after that). Pick *Synth* for instant
audio with no download.

## 💻 Run it offline

Grab a release ZIP from the **Releases** tab, then:

| OS       | Just double-click          |
| -------- | -------------------------- |
| macOS    | `start.command`            |
| Windows  | `start.bat`                |
| Linux    | `./start.sh`               |

These spawn a tiny bundled static web server (~3 MB) on
`http://127.0.0.1:5173` and open your default browser. **No Python or Node
required.** If your antivirus blocks the bundled binary, the script falls
back automatically to whatever you have installed (`python3 -m http.server`,
`python -m http.server`, `npx serve`).

<details>
<summary>macOS Gatekeeper note</summary>

The first time you run `start.command`, macOS may show a "cannot be opened
because the developer cannot be verified" warning. Either right-click the
file → Open, or unblock from Terminal:

```bash
xattr -dr com.apple.quarantine /path/to/MIDIScope-folder
```
</details>

## ⌨️ Keyboard shortcuts

| Key         | Action                                            |
| ----------- | ------------------------------------------------- |
| `Space`     | Play / pause                                      |
| `Esc`       | Stop and rewind                                   |
| `← / →`     | Seek by 2 s (hold `Shift` for 10 s)               |
| `Home / End`| Jump to start / end                               |
| `+ / −`     | Zoom in / out (1.25× per press)                   |
| `F`         | Fit whole piece — press again to restore zoom     |
| `T`         | Toggle light / dark theme                         |
| `M / S`     | (when hovering a voice) Mute / solo               |

## 🧭 Sidebar reference

All panels are collapsible (click the header). Open/closed state is
remembered across reloads. Hover any control for a one-line tooltip.

| Section        | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| Voices         | Mute (M) or solo (S) individual instrument lines.                         |
| Preset         | Apply a built-in visual preset (Score / Neon / Pulse / Aurora / …).       |
| Layers         | Toggle each visual layer; hover for a description.                        |
| Style          | Dot size · Line width · Line opacity.                                     |
| Sound          | Timbre (Realistic / Synth) + Reverb amount.                               |
| Analysis       | Bass-cutoff — fallback hand-split when no chords are detected.            |
| Image export   | Multi-system PNG / PDF score with optional instrument-color legend.       |
| Data export    | CSV / XLSX with preset row shapes or a fully custom column picker.        |

## 📊 Data export — example outputs

**Notes (long form)** — one row per onset, lossless:

```csv
time,bar,beat,voice,pitch,midi,duration_sec,velocity,chord_name
0,1,1,Chords,C4,60,0.5,0.7,C
0,1,1,Chords,E4,64,0.5,0.7,C
0,1,1,Chords,G4,67,0.5,0.7,C
2,1,3,Chords,A3,57,0.5,0.7,Am
```

**Per-instrument grid** *(new!)* — each row is one beat (or ½ / ¼ / bar);
each column is one voice; cells contain notes with chord name in
parentheses:

```csv
time,bar,beat,Melody,Harmony,Bass,Flute
0.000,1,1,E4,C4+E4+G4 (C),C2,
0.500,1,1.5,F4,C4+E4+G4 (C),C2,
1.000,1,2,G4,C4+E4+G4 (C),C2,A5
```

**Chord progression** — one row per chord change:

```csv
time,bar,beat,chord_name,chord_root,chord_quality,chord_bass,duration_sec
0,1,1,C,C,,,2
2,1,3,Am,A,m,,0.5
```

XLSX exports use the same shape, written as a real Excel workbook (lazy-loads
[SheetJS](https://sheetjs.com/) only when you pick XLSX).

## 🛠 Develop

The whole app is plain ES modules + CDN imports — no bundler needed. Any
static server works:

```bash
cd MIDIScope
python3 -m http.server 5173
# open http://127.0.0.1:5173/
```

Project layout:

```
index.html
style.css
src/
  main.js          UI wiring + tooltips + collapsibles + export hooks
  midiLoader.js    MIDI parsing (uses @tonejs/midi)
  voicing.js       Voice / chord splitter + palette
  chordName.js     Chord namer with inversions
  render.js        Canvas renderer (live + minimap)
  scoreExport.js   Multi-system PNG / PDF export
  dataExport.js    CSV / XLSX builder + serializers
  player.js        Tone.js sampler / synth player
midi/              demo MIDI files
scripts/           start.{sh,bat,command} launchers
```

## 🌐 Browser support

Chrome · Edge · Safari · Firefox — latest. Audio requires a user gesture to
unlock (clicking Play counts).

## 📜 License

MIT — see [LICENSE](LICENSE).

## 🙏 Credits

- [Tone.js](https://tonejs.github.io/) — Web Audio framework + samplers
- [@tonejs/midi](https://github.com/Tonejs/Midi) — MIDI parsing
- [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3)
  — piano samples (CC-BY)
- [SheetJS Community Edition](https://sheetjs.com/) — XLSX export
- [jsPDF](https://github.com/parallax/jsPDF) — PDF wrapping

---

<div align="center">
Made with ♪ by <a href="https://github.com/lzzmm">lzzmm</a>
</div>
