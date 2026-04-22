// Canvas rendering with theme support + offscreen export.
import { nameChord } from "./chordName.js";

const PITCH_LABELS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
export function pitchName(m) {
  const o = Math.floor(m / 12) - 1;
  return PITCH_LABELS[m % 12] + o;
}

const RULER_H = 28;
const KEYS_W = 56;

export const DEFAULT_LAYERS = {
  grid: true,
  notes: true,
  connections: true,
  chordStems: true,
  chordLabels: false,
  rootProgression: true,
  liveTrace: false,
  pulse: true,
  comet: false,
  ripple: false,
  glow: false,
  aurora: false,
  beam: false,
  minimap: true,
};

export const PRESETS = {
  "Score":      { ...DEFAULT_LAYERS, chordLabels: true },
  "Print":      { ...DEFAULT_LAYERS, chordLabels: true, glow: false, pulse: false, comet: false, ripple: false, beam: false, aurora: false, liveTrace: false },
  "Neon":       { ...DEFAULT_LAYERS, glow: true, comet: true, beam: true, pulse: true, grid: false, chordLabels: false, connections: false, chordStems: false, rootProgression: false },
  "Live trace": { ...DEFAULT_LAYERS, liveTrace: true, chordLabels: true },
  "Pulse":      { ...DEFAULT_LAYERS, pulse: true, chordLabels: true, comet: false },
  "Comet":      { ...DEFAULT_LAYERS, comet: true, pulse: true, connections: false, rootProgression: false, chordStems: false },
  "Ripple":     { ...DEFAULT_LAYERS, ripple: true, pulse: true, beam: true, chordStems: false, rootProgression: false },
  "Glow":       { ...DEFAULT_LAYERS, glow: true, pulse: false, comet: false, connections: true, chordStems: false },
  "Aurora":     { ...DEFAULT_LAYERS, aurora: true, glow: true, pulse: false, connections: false, chordStems: false, rootProgression: false, grid: false },
  "Minimal":    { ...DEFAULT_LAYERS, connections: false, chordStems: false, rootProgression: false, chordLabels: false, pulse: false },
};

export const THEMES = {
  dark: {
    bg:           "#14161b",
    panel:        "#1b1e25",
    keysText:     "#9aa0ad",
    keysTextDim:  "#5c6273",
    blackKeyFill: "rgba(255,255,255,0.025)",
    cLine:        "#2f3445",
    measureLine:  "#3a4052",
    beatLine:     "#262a35",
    measureNo:    "#9aa0ad",
    tsLabel:      "#5c6273",
    playhead:     "#ff5470",
    chordLabelBg: "rgba(20,22,27,0.85)",
    chordLabelFg: "#ffffff",
    pulseCore:    "#ffffff",
    separator:    "#000000",
    transparent:  true,
  },
  light: {
    bg:           "#ffffff",
    panel:        "#f5f5f7",
    keysText:     "#3a3f4b",
    keysTextDim:  "#9aa0ad",
    blackKeyFill: "rgba(0,0,0,0.045)",
    cLine:        "#cfd4dc",
    measureLine:  "#9aa0ad",
    beatLine:     "#dfe3eb",
    measureNo:    "#3a3f4b",
    tsLabel:      "#5c6273",
    playhead:     "#d6336c",
    chordLabelBg: "rgba(255,255,255,0.92)",
    chordLabelFg: "#14161b",
    pulseCore:    "#14161b",
    separator:    "#9aa0ad",
    transparent:  false,
  },
};

export class Renderer {
  constructor(canvas, minimapCanvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mini = minimapCanvas;
    this.miniCtx = minimapCanvas.getContext("2d");

    this.song = null;
    this.voices = [];
    this.pxPerSec = 160;
    this.minMidi = 24;
    this.maxMidi = 96;
    this.scrollX = 0;
    this.playheadSec = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.layers = { ...DEFAULT_LAYERS };
    this.themeName = "dark";
    this.theme = THEMES.dark;

    // Style knobs (user-adjustable)
    this.style = {
      dotScale: 1.0,        // multiplier on note-dot radius
      lineWidth: 1.4,       // base px for melody/connection lines
      lineAlpha: 0.65,      // 0-1 opacity for melody/connection lines
      chordStemAlpha: 0.55, // 0-1 opacity for chord stems
    };

    // size source (overridable for export)
    this._sizeOverride = null;

    this._raf = null;
    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  // ---------- public API ----------
  setSong(song, voices) {
    this.song = song;
    this.voices = voices;
    if (song) {
      const allNotes = voices.flatMap(v => v.notes);
      if (allNotes.length) {
        const lo = Math.min(...allNotes.map(n => n.midi));
        const hi = Math.max(...allNotes.map(n => n.midi));
        this.minMidi = Math.max(0, lo - 4);
        this.maxMidi = Math.min(127, hi + 4);
      }
    }
    this.scrollX = 0;
    this._cacheChordNames();
  }
  setVoices(voices) { this.voices = voices; this._cacheChordNames(); }
  setLayer(name, on) { this.layers[name] = !!on; }
  setLayers(obj)     { this.layers = { ...this.layers, ...obj }; }
  applyPreset(name)  { if (PRESETS[name]) this.layers = { ...PRESETS[name] }; }
  setTheme(name)     { if (THEMES[name]) { this.themeName = name; this.theme = THEMES[name]; } }
  setStyle(obj)      { this.style = { ...this.style, ...obj }; }

  // Blend mode that "adds light" on dark and "darkens" on white.
  _blendMode(forExport) {
    if (forExport) return "source-over";
    return this.themeName === "light" ? "multiply" : "lighter";
  }

  setPxPerSec(v) {
    const oldPx = this.pxPerSec;
    const center = (this.scrollX + this._stageW() / 2) / oldPx;
    this.pxPerSec = v;
    this.scrollX = Math.max(0, center * v - this._stageW() / 2);
  }

  setPlayhead(sec) {
    this.playheadSec = sec;
    const stageW = this._stageW();
    const px = sec * this.pxPerSec - this.scrollX;
    if (px > stageW * 0.7) {
      this.scrollX = sec * this.pxPerSec - stageW * 0.5;
    } else if (px < stageW * 0.1 && sec > 0) {
      this.scrollX = Math.max(0, sec * this.pxPerSec - stageW * 0.3);
    }
  }

  start() { if (this._raf) return; const loop = () => { this._draw(); this._raf = requestAnimationFrame(loop); }; loop(); }
  stop()  { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  centerOnTime(t) { this.scrollX = Math.max(0, t * this.pxPerSec - this._stageW() / 2); }

  _cacheChordNames() {
    for (const v of this.voices) {
      if (v.kind === "piano-chords") {
        for (const ev of v.events) {
          if (ev.isChord) ev.chordName = nameChord(ev.members.map(m => m.midi));
        }
      }
    }
  }

  // ---------- size / coords ----------
  _w() { return this._sizeOverride ? this._sizeOverride.w : this.canvas.clientWidth; }
  _h() { return this._sizeOverride ? this._sizeOverride.h : this.canvas.clientHeight; }
  _stageW() { return this._w() - KEYS_W; }
  _stageH() { return this._h() - RULER_H; }

  timeToX(t) { return KEYS_W + t * this.pxPerSec - this.scrollX; }
  xToTime(x) { return (x - KEYS_W + this.scrollX) / this.pxPerSec; }
  midiToY(m) {
    const range = this.maxMidi - this.minMidi;
    return RULER_H + this._stageH() - ((m - this.minMidi) / range) * this._stageH();
  }
  _semiH() { return this._stageH() / (this.maxMidi - this.minMidi); }

  hitTest(x, y) {
    const t = this.xToTime(x);
    const range = this.maxMidi - this.minMidi;
    const semiPx = this._stageH() / range;
    const m = this.minMidi + (this._stageH() - (y - RULER_H)) / semiPx;
    let best = null, bestD = 12;
    for (const v of this.voices) {
      if (v.muted) continue;
      for (const n of v.notes) {
        if (t < n.time - 0.05 || t > n.time + n.duration + 0.05) continue;
        const dy = Math.abs(n.midi - m);
        if (dy < bestD) { bestD = dy; best = { note: n, voice: v }; }
      }
    }
    return best;
  }

  _resize() {
    for (const cv of [this.canvas, this.mini]) {
      const w = cv.clientWidth, h = cv.clientHeight;
      cv.width = Math.floor(w * this.dpr);
      cv.height = Math.floor(h * this.dpr);
    }
  }

  // ---------- live draw ----------
  _draw() {
    if (!this.song) { this._clear(); return; }
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    this._drawAll(ctx, /*forExport*/ false);
    ctx.restore();

    if (this.layers.minimap) this._drawMinimap();
    else this.miniCtx.clearRect(0, 0, this.mini.width, this.mini.height);
  }

  _clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

  _drawAll(ctx, forExport) {
    const w = this._w(), h = this._h();
    // background fill (skip in live dark mode to keep CSS bg)
    if (forExport || this.themeName === "light") {
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    if (this.layers.aurora && !forExport) this._drawAurora(ctx);
    if (this.layers.grid) this._drawGrid(ctx);
    if (this.layers.connections || this.layers.chordStems || this.layers.rootProgression) this._drawConnections(ctx);
    if (this.layers.glow) this._drawGlow(ctx, forExport);
    if (this.layers.notes) this._drawNotes(ctx, forExport);
    if (this.layers.beam && !forExport) this._drawBeam(ctx);
    if (this.layers.ripple && !forExport) this._drawRipples(ctx);
    if (this.layers.comet && !forExport) this._drawComet(ctx);
    if (this.layers.chordLabels) this._drawChordLabels(ctx);
    this._drawKeysColumn(ctx);
    this._drawRuler(ctx);
    if (!forExport) this._drawPlayhead(ctx);
  }

  // ---------- grid ----------
  _drawGrid(ctx) {
    const w = this._w();
    for (let m = this.minMidi; m <= this.maxMidi; m++) {
      const y = this.midiToY(m);
      const isC = m % 12 === 0;
      const isBlack = [1,3,6,8,10].includes(m % 12);
      if (isBlack) {
        ctx.fillStyle = this.theme.blackKeyFill;
        ctx.fillRect(KEYS_W, y - this._semiH() / 2, w - KEYS_W, this._semiH());
      }
      if (isC) {
        ctx.strokeStyle = this.theme.cLine;
        ctx.beginPath();
        ctx.moveTo(KEYS_W, y + 0.5);
        ctx.lineTo(w, y + 0.5);
        ctx.stroke();
      }
    }
  }

  _drawKeysColumn(ctx) {
    const w = this._w(), h = this._h();
    ctx.fillStyle = this.theme.panel;
    ctx.fillRect(0, 0, KEYS_W, h);
    ctx.fillRect(0, 0, w, RULER_H);

    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let m = this.minMidi; m <= this.maxMidi; m++) {
      const y = this.midiToY(m);
      if (m % 12 === 0) {
        ctx.fillStyle = this.theme.keysText;
        ctx.fillText(pitchName(m), KEYS_W - 6, y);
      } else if (m % 12 === 5) {
        ctx.fillStyle = this.theme.keysTextDim;
        ctx.fillText(pitchName(m), KEYS_W - 6, y);
      }
    }
    ctx.strokeStyle = this.theme.separator;
    ctx.beginPath();
    ctx.moveTo(KEYS_W + 0.5, 0); ctx.lineTo(KEYS_W + 0.5, h);
    ctx.moveTo(0, RULER_H + 0.5); ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();
  }

  _drawRuler(ctx) {
    const stageW = this._stageW();
    const tStart = this.xToTime(KEYS_W);
    const tEnd = this.xToTime(KEYS_W + stageW);
    const header = this.song.header;
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    const tsList = this.song.timeSignatures.length
      ? this.song.timeSignatures
      : [{ time: 0, ticks: 0, numerator: 4, denominator: 4, measures: 0 }];
    const ppq = this.song.ppq;
    const totalDur = this.song.durationSec;

    for (let i = 0; i < tsList.length; i++) {
      const ts = tsList[i];
      const next = tsList[i + 1];
      const segStartTick = ts.ticks ?? 0;
      const segEndTick = next ? (next.ticks ?? 0) : header.secondsToTicks(totalDur);
      const ticksPerBeat = ppq * (4 / ts.denominator);
      const ticksPerMeasure = ticksPerBeat * ts.numerator;
      const startMeasureNo = Math.round(ts.measures ?? 0);
      const measuresInSeg = Math.max(1, Math.ceil((segEndTick - segStartTick) / ticksPerMeasure));

      for (let mi = 0; mi <= measuresInSeg; mi++) {
        const tickAtMeasure = segStartTick + mi * ticksPerMeasure;
        if (tickAtMeasure > segEndTick + 1) break;
        const sec = header.ticksToSeconds(tickAtMeasure);
        if (sec < tStart - 1) continue;
        if (sec > tEnd + 1) break;
        const x = this.timeToX(sec);
        ctx.strokeStyle = this.theme.measureLine;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_H);
        ctx.lineTo(x + 0.5, this._h());
        ctx.stroke();
        ctx.fillStyle = this.theme.measureNo;
        ctx.fillText(String(startMeasureNo + mi + 1), x + 4, 4);
        for (let b = 1; b < ts.numerator; b++) {
          const beatSec = header.ticksToSeconds(tickAtMeasure + b * ticksPerBeat);
          if (beatSec > tEnd) break;
          const bx = this.timeToX(beatSec);
          ctx.strokeStyle = this.theme.beatLine;
          ctx.beginPath();
          ctx.moveTo(bx + 0.5, RULER_H);
          ctx.lineTo(bx + 0.5, this._h());
          ctx.stroke();
        }
      }
    }
    // time-in-seconds ticks every 1 s; labels auto-thinned when crowded
    ctx.fillStyle = this.theme.tsLabel;
    const labelEvery = Math.max(1, Math.ceil(28 / this.pxPerSec));
    const s0 = Math.ceil(tStart - 1e-6);
    const s1 = Math.floor(tEnd + 1e-6);
    for (let s = s0; s <= s1; s++) {
      const x = this.timeToX(s);
      const labeled = s % labelEvery === 0;
      ctx.strokeStyle = labeled ? this.theme.measureLine : this.theme.beatLine;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - (labeled ? 6 : 3));
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      if (labeled) ctx.fillText(`${s}s`, x + 3, 16);
    }
    ctx.fillText(`${tsList[0].numerator}/${tsList[0].denominator}`, KEYS_W + 4, 16);
  }

  // ---------- notes ----------
  _drawNotes(ctx, forExport) {
    const tStart = this.xToTime(KEYS_W);
    const tEnd = this.xToTime(this._w());
    const t = this.playheadSec;
    const pulse = this.layers.pulse && !forExport;

    for (const v of this.voices) {
      if (v.muted) continue;
      const isChordVoice = v.kind === "piano-chords";
      for (const ev of v.events) {
        if (ev.time < tStart - 1 || ev.time > tEnd + 0.5) continue;
        for (const n of ev.members) {
          if (n.time + n.duration < tStart || n.time > tEnd) continue;
          const x = this.timeToX(n.time);
          const y = this.midiToY(n.midi);
          const wRect = Math.max(2, n.duration * this.pxPerSec);
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = v.color;
          ctx.fillRect(x, y - 2, wRect, 4);
          ctx.globalAlpha = 1.0;

          const isActive = pulse && t >= n.time && t <= n.time + n.duration;
          const baseR = (2.2 + (n.velocity || 0.7) * 4) * this.style.dotScale;
          const r = isActive ? baseR + 3 : baseR;

          if (isActive) {
            ctx.globalAlpha = 0.35;
            ctx.beginPath();
            ctx.arc(x, y, r + 6, 0, Math.PI * 2);
            ctx.fillStyle = v.color; ctx.fill();
            ctx.globalAlpha = 1.0;
          }
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          if (isActive) {
            // Active dot: filled with voice color + ring + small offset
            // white highlight so it reads as a glossy pearl on both
            // light and dark themes (the old near-black core looked
            // dull on a white background).
            ctx.fillStyle = v.color;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = v.color;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x - r * 0.28, y - r * 0.28, Math.max(1, r * 0.38), 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,255,255,0.85)";
            ctx.fill();
          } else {
            // semi-transparent fill + opaque rim so overlapping dots remain visible
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = v.color;
            ctx.fill();
            ctx.globalAlpha = 1.0;
            ctx.lineWidth = 1;
            ctx.strokeStyle = v.color;
            ctx.stroke();
          }
          if (isChordVoice && ev.isChord && this.layers.chordStems) {
            ctx.lineWidth = 1;
            ctx.strokeStyle = hexToRgba(v.color, 0.9);
            ctx.beginPath();
            ctx.arc(x, y, baseR + 2, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }
  }

  // ---------- connections ----------
  _drawConnections(ctx) {
    const tStart = this.xToTime(KEYS_W) - 0.5;
    const tEnd = this.xToTime(this._w()) + 0.5;
    const limitT = this.layers.liveTrace ? this.playheadSec : Infinity;

    for (const v of this.voices) {
      if (v.muted) continue;
      if (v.kind === "piano-chords") {
        if (this.layers.chordStems) {
          ctx.lineWidth = this.style.lineWidth;
          ctx.strokeStyle = hexToRgba(v.color, this.style.chordStemAlpha);
          for (const ev of v.events) {
            if (ev.time < tStart || ev.time > tEnd) continue;
            if (!ev.isChord || ev.time > limitT) continue;
            const x = this.timeToX(ev.time);
            ctx.beginPath();
            ctx.moveTo(x, this.midiToY(ev.root.midi));
            ctx.lineTo(x, this.midiToY(ev.top.midi));
            ctx.stroke();
          }
        }
        if (this.layers.rootProgression) {
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = hexToRgba(v.color, this.style.lineAlpha * 0.7);
          ctx.lineWidth = this.style.lineWidth;
          this._strokePolyline(ctx, v.events, ev => ev.root.midi, tStart, tEnd, limitT);
          ctx.setLineDash([]);
        }
      } else if (this.layers.connections) {
        ctx.strokeStyle = hexToRgba(v.color, this.style.lineAlpha);
        ctx.lineWidth = this.style.lineWidth;
        this._strokePolyline(
          ctx, v.events,
          ev => (ev.isChord ? ev.root.midi : ev.members[0].midi),
          tStart, tEnd, limitT
        );
      }
    }
  }

  _strokePolyline(ctx, events, midiOf, tStart, tEnd, limitT) {
    ctx.beginPath();
    let started = false;
    let lastEv = null;
    for (const ev of events) {
      if (ev.time < tStart - 1 || ev.time > tEnd + 0.5) { started = false; continue; }
      if (ev.time > limitT) {
        if (started && lastEv) {
          const x0 = this.timeToX(lastEv.time);
          const y0 = this.midiToY(midiOf(lastEv));
          const x1 = this.timeToX(ev.time);
          const y1 = this.midiToY(midiOf(ev));
          const t01 = (limitT - lastEv.time) / Math.max(1e-6, ev.time - lastEv.time);
          if (t01 > 0 && t01 < 1) ctx.lineTo(x0 + (x1 - x0) * t01, y0 + (y1 - y0) * t01);
        }
        break;
      }
      const x = this.timeToX(ev.time);
      const y = this.midiToY(midiOf(ev));
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
      lastEv = ev;
    }
    ctx.stroke();
  }

  _drawComet(ctx) {
    const t = this.playheadSec;
    const window = 1.2;
    for (const v of this.voices) {
      if (v.muted) continue;
      for (const n of v.notes) {
        const dt = t - n.time;
        if (dt < 0 || dt > window) continue;
        const x = this.timeToX(n.time);
        const y = this.midiToY(n.midi);
        const a = 1 - dt / window;
        ctx.globalAlpha = 0.45 * a;
        ctx.beginPath();
        ctx.arc(x, y, 6 + 14 * a, 0, Math.PI * 2);
        ctx.fillStyle = v.color; ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Expanding ring when a note hits the playhead.
  _drawRipples(ctx) {
    const t = this.playheadSec;
    const window = 0.8;
    const tStart = this.xToTime(KEYS_W) - 0.5;
    const tEnd = this.xToTime(this._w()) + 0.5;
    ctx.save();
    ctx.lineWidth = 1.5;
    for (const v of this.voices) {
      if (v.muted) continue;
      for (const n of v.notes) {
        const dt = t - n.time;
        if (dt < 0 || dt > window) continue;
        if (n.time < tStart || n.time > tEnd) continue;
        const x = this.timeToX(n.time);
        const y = this.midiToY(n.midi);
        const a = 1 - dt / window;
        const r = 4 + (1 - a) * 28;
        ctx.globalAlpha = 0.55 * a;
        ctx.strokeStyle = v.color;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Persistent soft glow around every onset — works as a static effect too.
  _drawGlow(ctx, forExport) {
    const tStart = this.xToTime(KEYS_W) - 0.5;
    const tEnd = this.xToTime(this._w()) + 0.5;
    const t = this.playheadSec;
    ctx.save();
    ctx.globalCompositeOperation = this._blendMode(forExport);
    for (const v of this.voices) {
      if (v.muted) continue;
      for (const n of v.notes) {
        if (n.time < tStart || n.time > tEnd) continue;
        const x = this.timeToX(n.time);
        const y = this.midiToY(n.midi);
        const active = !forExport && t >= n.time && t <= n.time + n.duration;
        const r = active ? 22 : 12;
        const baseA = this.themeName === "light" ? (active ? 0.45 : 0.22) : (active ? 0.55 : 0.32);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, hexToRgba(v.color, baseA));
        grad.addColorStop(1, hexToRgba(v.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  // Vertical beam at the playhead, reaching each currently-sounding note.
  _drawBeam(ctx) {
    const t = this.playheadSec;
    const x = this.timeToX(t);
    if (x < KEYS_W || x > this._w()) return;
    ctx.save();
    ctx.globalCompositeOperation = this._blendMode(false);
    for (const v of this.voices) {
      if (v.muted) continue;
      for (const n of v.notes) {
        if (t < n.time || t > n.time + n.duration) continue;
        const y = this.midiToY(n.midi);
        const grad = ctx.createLinearGradient(x, this._h(), x, y);
        const tip = this.themeName === "light" ? 0.4 : 0.55;
        grad.addColorStop(0, hexToRgba(v.color, 0));
        grad.addColorStop(1, hexToRgba(v.color, tip));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, this._h());
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Wide horizontal "aurora" swaths tinted by currently-sounding pitches.
  _drawAurora(ctx) {
    const t = this.playheadSec;
    const w = this._w();
    ctx.save();
    ctx.globalCompositeOperation = this._blendMode(false);
    for (const v of this.voices) {
      if (v.muted) continue;
      for (const n of v.notes) {
        const dt = t - n.time;
        if (dt < -0.1 || dt > n.duration + 0.6) continue;
        const y = this.midiToY(n.midi);
        const a = dt < 0 ? Math.max(0, 1 + dt / 0.1) :
                  dt < n.duration ? 1 :
                  Math.max(0, 1 - (dt - n.duration) / 0.6);
        const peak = this.themeName === "light" ? 0.12 : 0.18;
        const grad = ctx.createLinearGradient(KEYS_W, y, w, y);
        grad.addColorStop(0,   hexToRgba(v.color, 0));
        grad.addColorStop(0.5, hexToRgba(v.color, peak * a));
        grad.addColorStop(1,   hexToRgba(v.color, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(KEYS_W, y - 14, w - KEYS_W, 28);
      }
    }
    ctx.restore();
  }

  _drawChordLabels(ctx) {
    const tStart = this.xToTime(KEYS_W);
    const tEnd = this.xToTime(this._w());
    ctx.font = "11px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "center";
    for (const v of this.voices) {
      if (v.muted || v.kind !== "piano-chords") continue;
      for (const ev of v.events) {
        if (!ev.isChord || !ev.chordName) continue;
        if (ev.time < tStart || ev.time > tEnd) continue;
        const x = this.timeToX(ev.time);
        const y = this.midiToY(ev.top.midi) - 8;
        const text = ev.chordName;
        const w = ctx.measureText(text).width + 8;
        ctx.fillStyle = this.theme.chordLabelBg;
        ctx.fillRect(x - w / 2, y - 13, w, 14);
        ctx.strokeStyle = hexToRgba(v.color, 0.85);
        ctx.strokeRect(x - w / 2 + 0.5, y - 13 + 0.5, w - 1, 13);
        ctx.fillStyle = this.theme.chordLabelFg;
        ctx.fillText(text, x, y - 1);
      }
    }
  }

  _drawPlayhead(ctx) {
    const x = this.timeToX(this.playheadSec);
    if (x < KEYS_W || x > this._w()) return;
    ctx.strokeStyle = this.theme.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_H); ctx.lineTo(x + 0.5, this._h());
    ctx.stroke();
  }

  _drawMinimap() {
    const ctx = this.miniCtx;
    const w = this.mini.clientWidth, h = this.mini.clientHeight;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);
    if (!this.song) { ctx.restore(); return; }
    ctx.fillStyle = this.theme.panel;
    ctx.fillRect(0, 0, w, h);
    const dur = this.song.durationSec;
    const range = this.maxMidi - this.minMidi;
    const pad = 4;
    const innerH = h - pad * 2;
    for (const v of this.voices) {
      if (v.muted) continue;
      ctx.fillStyle = v.color;
      ctx.globalAlpha = 0.85;
      for (const n of v.notes) {
        const x = (n.time / dur) * w;
        const wpx = Math.max(1, (n.duration / dur) * w);
        const y = pad + innerH - ((n.midi - this.minMidi) / range) * innerH;
        ctx.fillRect(x, y - 1, wpx, 2);
      }
    }
    ctx.globalAlpha = 1;
    const stageW = this._stageW();
    const vpStart = this.scrollX / this.pxPerSec;
    const vpEnd = (this.scrollX + stageW) / this.pxPerSec;
    const x0 = (vpStart / dur) * w;
    const x1 = (vpEnd / dur) * w;
    ctx.strokeStyle = "#6cc4ff";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0), h - 1);
    ctx.fillStyle = "rgba(108,196,255,0.10)";
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
    const px = (this.playheadSec / dur) * w;
    ctx.strokeStyle = this.theme.playhead;
    ctx.beginPath();
    ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- export ----------
  /**
   * Render the entire song into a freshly allocated canvas.
   * @param {object} opts
   *   pxPerSec - horizontal scale for the export (default current zoom)
   *   height   - output height in CSS pixels (default = current canvas height)
   *   theme    - "light" | "dark"
   *   layers   - layer overrides (e.g. {pulse:false, comet:false})
   *   scale    - device pixel ratio for output (default 2)
   * @returns {HTMLCanvasElement}
   */
  exportCanvas(opts = {}) {
    if (!this.song) return null;
    const pxPerSec = opts.pxPerSec ?? this.pxPerSec;
    const height   = opts.height   ?? this.canvas.clientHeight;
    const themeName = opts.theme   ?? "light";
    const scale    = opts.scale    ?? 2;
    const layerOverrides = opts.layers ?? {};

    // Width = keys + entire song + small right margin
    const width = Math.ceil(KEYS_W + this.song.durationSec * pxPerSec + 24);

    // Backup live state we mutate.
    const back = {
      pxPerSec: this.pxPerSec,
      scrollX:  this.scrollX,
      playhead: this.playheadSec,
      layers:   { ...this.layers },
      theme:    this.themeName,
      sizeOverride: this._sizeOverride,
    };

    // Off-DOM canvas.
    const off = document.createElement("canvas");
    off.width  = Math.floor(width  * scale);
    off.height = Math.floor(height * scale);
    const offCtx = off.getContext("2d");

    try {
      // Apply export state.
      this.pxPerSec = pxPerSec;
      this.scrollX = 0;
      this.playheadSec = 0;
      this.setTheme(themeName);
      this.setLayers({
        // sensible export defaults; user can override
        pulse: false,
        comet: false,
        liveTrace: false,
        minimap: false,
        ...layerOverrides,
      });
      this._sizeOverride = { w: width, h: height };

      offCtx.save();
      offCtx.scale(scale, scale);
      this._drawAll(offCtx, /*forExport*/ true);
      offCtx.restore();
    } finally {
      // Restore live state.
      this.pxPerSec = back.pxPerSec;
      this.scrollX  = back.scrollX;
      this.playheadSec = back.playhead;
      this.setLayers(back.layers);
      this.setTheme(back.theme);
      this._sizeOverride = back.sizeOverride;
    }

    return off;
  }
}

function hexToRgba(hex, a) {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export { KEYS_W, RULER_H };
