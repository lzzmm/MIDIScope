// Standalone score-style exporter.
// Wraps the entire piece into multiple horizontal "systems" (rows) so the
// final image stays within a max aspect ratio. Returns a freshly allocated
// canvas; caller turns it into a PNG / PDF.

import { nameChord } from "./chordName.js";

const PITCH_LABELS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const pitchName = (m) => PITCH_LABELS[m % 12] + (Math.floor(m / 12) - 1);

const PALETTE = {
  light: {
    bg: "#ffffff",
    panel: "#f3f4f7",
    grid: "#e5e7eb",
    cLine: "#cbd1da",
    measureLine: "#9aa0ad",
    beatLine: "#e5e7eb",
    text: "#14161b",
    textDim: "#5c6273",
    blackKey: "rgba(0,0,0,0.045)",
    chordBg: "rgba(255,255,255,0.92)",
    chordBorder: "#cbd1da",
    separator: "#9aa0ad",
    title: "#14161b",
  },
  dark: {
    bg: "#14161b",
    panel: "#1b1e25",
    grid: "#262a35",
    cLine: "#2f3445",
    measureLine: "#3a4052",
    beatLine: "#262a35",
    text: "#e6e8ee",
    textDim: "#9aa0ad",
    blackKey: "rgba(255,255,255,0.025)",
    chordBg: "rgba(20,22,27,0.85)",
    chordBorder: "#3a4052",
    separator: "#000000",
    title: "#e6e8ee",
  },
};

/**
 * Render the whole song as a wrapped multi-system score image.
 * @param {object} song      from midiLoader
 * @param {Array}  voices    from voicing.buildVoices
 * @param {object} opts
 *   width        target image width in CSS px (default 2000)
 *   maxAspect    maximum width/height ratio (default 4)
 *   theme        "light" | "dark" (default "light")
 *   scale        device pixel ratio (default 2)
 *   semiPx       vertical px per semitone (default 5)
 *   layers       { notes, connections, chordStems, rootProgression, chordLabels, grid }
 *   title        optional string drawn at the top
 * @returns {{canvas:HTMLCanvasElement,widthCss:number,heightCss:number}}
 */
export function renderScore(song, voices, opts = {}) {
  const W           = opts.width      ?? 2000;
  const MAX_ASPECT  = opts.maxAspect  ?? 4;
  const themeName   = opts.theme      ?? "light";
  const scale       = opts.scale      ?? 2;
  const SEMI        = opts.semiPx     ?? 5;
  const FIXED_ROWS  = opts.rows       ?? null; // explicit row count overrides auto
  const showLegend  = opts.legend     ?? true;
  const style = {
    dotScale: 1.0,
    lineWidth: 1.4,
    lineAlpha: 0.65,
    chordStemAlpha: 0.55,
    ...(opts.style || {}),
  };
  const layers = {
    notes: true, connections: true, chordStems: true,
    rootProgression: true, chordLabels: true, grid: true,
    ...(opts.layers || {}),
  };
  const title       = opts.title      ?? "";
  const theme       = PALETTE[themeName] ?? PALETTE.light;

  // ---- pitch range ----
  const allNotes = voices.flatMap(v => v.notes);
  if (!allNotes.length) {
    const c = document.createElement("canvas");
    c.width = W * scale; c.height = 200 * scale;
    return { canvas: c, widthCss: W, heightCss: 200 };
  }
  const lo = Math.min(...allNotes.map(n => n.midi));
  const hi = Math.max(...allNotes.map(n => n.midi));
  const minMidi = Math.max(0, lo - 3);
  const maxMidi = Math.min(127, hi + 3);
  const range = maxMidi - minMidi;

  // ---- layout constants ----
  const KEYS_W = 56;
  const RIGHT_PAD = 16;
  const RULER_H = 22;        // top: bars + beats
  const TIME_H = 16;         // bottom: seconds
  const CHORD_PAD = layers.chordLabels ? 16 : 0;
  const SYSTEM_BODY = range * SEMI;
  const SYSTEM_H = RULER_H + CHORD_PAD + SYSTEM_BODY + TIME_H;
  const SYSTEM_GAP = 24;
  const HEADER_H = title ? 40 : 18;
  const LEGEND_H = (showLegend && voices.length) ? 24 : 0;
  const FOOTER_H = 18;

  const innerW = W - KEYS_W - RIGHT_PAD;
  const dur = song.durationSec;

  // ---- choose number of systems so aspect ≤ MAX_ASPECT (or honor explicit rows) ----
  const totalHFor = (n) => HEADER_H + LEGEND_H + FOOTER_H + n * SYSTEM_H + (n - 1) * SYSTEM_GAP;
  let N;
  if (FIXED_ROWS && FIXED_ROWS >= 1) {
    N = FIXED_ROWS;
  } else {
    N = 1;
    while (W / totalHFor(N) > MAX_ASPECT) N++;
  }
  // also: avoid silly tiny systems — cap pxPerSec to a reasonable max
  const minPxPerSec = 30;
  const maxN = Math.max(1, Math.ceil((dur * minPxPerSec) / innerW));
  if (N < 1) N = 1;
  if (maxN < N) N = N; // keep N if larger than maxN (means pxPerSec grows)
  const secsPerSystem = dur / N;
  const pxPerSec = innerW / secsPerSystem;

  const totalH = totalHFor(N);

  // ---- allocate canvas ----
  const canvas = document.createElement("canvas");
  canvas.width  = Math.floor(W * scale);
  canvas.height = Math.floor(totalH * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.textRendering = "geometricPrecision";

  // ---- background ----
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, totalH);

  // ---- title / meta ----
  ctx.fillStyle = theme.title;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  if (title) {
    ctx.font = "600 18px ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
    ctx.fillText(title, 16, 12);
  }
  ctx.fillStyle = theme.textDim;
  ctx.font = "11px ui-sans-serif, -apple-system, sans-serif";
  const meta = `${fmtTime(dur)} · ${pxPerSec.toFixed(0)} px/s · ${N} system${N>1?"s":""}`;
  ctx.textAlign = "right";
  ctx.fillText(meta, W - 16, title ? 18 : 4);

  // ---- legend (instrument color key) ----
  if (LEGEND_H) {
    drawLegend(ctx, voices, 16, HEADER_H - 2, W - 32, LEGEND_H, theme);
  }

  // ---- per-system geometry helpers ----
  const sysTop = (i) => HEADER_H + LEGEND_H + i * (SYSTEM_H + SYSTEM_GAP);
  const sysT0  = (i) => i * secsPerSystem;
  const sysT1  = (i) => Math.min(dur, (i + 1) * secsPerSystem);
  const tToX = (i, t) => KEYS_W + (t - sysT0(i)) * pxPerSec;
  const mToY = (i, m) => sysTop(i) + RULER_H + CHORD_PAD + SYSTEM_BODY - ((m - minMidi) / range) * SYSTEM_BODY;

  // Cache chord names if not already
  for (const v of voices) {
    if (v.kind === "piano-chords") {
      for (const ev of v.events) {
        if (ev.isChord && !ev.chordName) ev.chordName = nameChord(ev.members.map(m => m.midi));
      }
    }
  }

  // ---- draw each system ----
  for (let i = 0; i < N; i++) {
    const t0 = sysT0(i);
    const t1 = sysT1(i);
    const top = sysTop(i);
    const stageW = (t1 - t0) * pxPerSec;
    const bodyTop = top + RULER_H + CHORD_PAD;
    const bodyBottom = bodyTop + SYSTEM_BODY;
    const timeTop = bodyBottom;            // bottom strip starts here

    // --- system background panels (key column + ruler + time strip) ---
    ctx.fillStyle = theme.panel;
    ctx.fillRect(0, top, KEYS_W, SYSTEM_H);
    ctx.fillRect(0, top, W, RULER_H);
    ctx.fillRect(0, timeTop, W, TIME_H);

    // --- grid (black-key shading + C lines) ---
    if (layers.grid) {
      const semiH = SYSTEM_BODY / range;
      for (let m = minMidi; m <= maxMidi; m++) {
        const y = mToY(i, m);
        if ([1,3,6,8,10].includes(m % 12)) {
          ctx.fillStyle = theme.blackKey;
          ctx.fillRect(KEYS_W, y - semiH/2, stageW, semiH);
        }
        if (m % 12 === 0) {
          ctx.strokeStyle = theme.cLine;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(KEYS_W, y + 0.5);
          ctx.lineTo(KEYS_W + stageW, y + 0.5);
          ctx.stroke();
        }
      }
    }

    // --- key column labels ---
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let m = minMidi; m <= maxMidi; m++) {
      if (m % 12 !== 0 && m % 12 !== 5) continue;
      const y = mToY(i, m);
      ctx.fillStyle = m % 12 === 0 ? theme.text : theme.textDim;
      ctx.fillText(pitchName(m), KEYS_W - 6, y);
    }
    ctx.strokeStyle = theme.separator;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(KEYS_W + 0.5, top);
    ctx.lineTo(KEYS_W + 0.5, timeTop + TIME_H);
    ctx.moveTo(0, top + RULER_H + 0.5);
    ctx.lineTo(KEYS_W + stageW, top + RULER_H + 0.5);
    ctx.moveTo(0, timeTop + 0.5);
    ctx.lineTo(KEYS_W + stageW, timeTop + 0.5);
    ctx.stroke();

    // --- ruler: measure lines + numbers + beat ticks (top) + time strip (bottom) ---
    drawRuler(ctx, song, i, t0, t1, top, KEYS_W, stageW, bodyTop, bodyBottom, timeTop, TIME_H, RULER_H, pxPerSec, theme);

    // --- connections (under notes) ---
    if (layers.connections || layers.chordStems || layers.rootProgression) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(KEYS_W, bodyTop, stageW, SYSTEM_BODY);
      ctx.clip();
      drawConnections(ctx, voices, i, t0, t1, tToX, mToY, layers, style);
      ctx.restore();
    }

    // --- notes ---
    if (layers.notes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(KEYS_W, bodyTop, stageW, SYSTEM_BODY);
      ctx.clip();
      drawNotes(ctx, voices, i, t0, t1, tToX, mToY, pxPerSec, style);
      ctx.restore();
    }

    // --- chord labels ---
    if (layers.chordLabels) {
      drawChordLabels(ctx, voices, i, t0, t1, tToX, mToY, theme);
    }
  }

  // ---- footer ----
  ctx.fillStyle = theme.textDim;
  ctx.font = "10px ui-sans-serif, sans-serif";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText("MIDI Visualizer · score export", 16, totalH - 6);
  ctx.textAlign = "right";
  ctx.fillText(new Date().toISOString().slice(0, 10), W - 16, totalH - 6);

  return { canvas, widthCss: W, heightCss: totalH };
}

// ---------- helpers ----------

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${String(s).padStart(2,"0")}`;
}

function drawRuler(ctx, song, i, t0, t1, top, KEYS_W, stageW, bodyTop, bodyBottom, timeTop, TIME_H, RULER_H, pxPerSec, theme) {
  const header = song.header;
  const tsList = song.timeSignatures.length
    ? song.timeSignatures
    : [{ time: 0, ticks: 0, numerator: 4, denominator: 4, measures: 0 }];
  const ppq = song.ppq;
  const totalDur = song.durationSec;
  const totalTicks = header.secondsToTicks(totalDur);

  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  // ---- top ruler: measure numbers + bar lines + beat ticks ----
  // Iterate every TS segment, drawing every measure & beat that falls in [t0,t1].
  for (let s = 0; s < tsList.length; s++) {
    const ts = tsList[s];
    const next = tsList[s + 1];
    const segStartTick = ts.ticks ?? 0;
    const segEndTick = next ? (next.ticks ?? 0) : totalTicks;
    const ticksPerBeat = ppq * (4 / ts.denominator);
    const ticksPerMeasure = ticksPerBeat * ts.numerator;
    const startMeasureNo = Math.round(ts.measures ?? 0); // 0-based at this ts
    // bar count strictly within this segment
    const measuresInSeg = Math.max(0, Math.round((segEndTick - segStartTick) / ticksPerMeasure));

    for (let mi = 0; mi < measuresInSeg; mi++) {
      const measureTick = segStartTick + mi * ticksPerMeasure;
      const measureSec = header.ticksToSeconds(measureTick);
      // Bar line + label
      if (measureSec >= t0 - 0.0005 && measureSec <= t1 + 0.0005) {
        const x = KEYS_W + (measureSec - t0) * pxPerSec;
        ctx.strokeStyle = theme.measureLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, top + 2);
        ctx.lineTo(x + 0.5, bodyBottom);
        ctx.stroke();
        ctx.fillStyle = theme.text;
        ctx.fillText(String(startMeasureNo + mi + 1), x + 4, top + 2);
      }
      // Beat ticks within this measure (skip beat 0 = the bar line itself)
      for (let b = 1; b < ts.numerator; b++) {
        const beatSec = header.ticksToSeconds(measureTick + b * ticksPerBeat);
        if (beatSec < t0 - 0.0005 || beatSec > t1 + 0.0005) continue;
        const bx = KEYS_W + (beatSec - t0) * pxPerSec;
        // short tick on top ruler
        ctx.strokeStyle = theme.beatLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx + 0.5, top + RULER_H - 6);
        ctx.lineTo(bx + 0.5, top + RULER_H);
        ctx.stroke();
        // faint full-height beat line in body
        ctx.strokeStyle = theme.beatLine;
        ctx.beginPath();
        ctx.moveTo(bx + 0.5, bodyTop);
        ctx.lineTo(bx + 0.5, bodyBottom);
        ctx.stroke();
        // beat number small label
        ctx.fillStyle = theme.textDim;
        ctx.fillText(String(b + 1), bx + 2, top + RULER_H - 14);
      }
    }
  }

  // ---- bottom strip: time in seconds (ticks every 1s, labels auto-thinned) ----
  // Need ~28 px between labels to stay readable.
  const labelEvery = Math.max(1, Math.ceil(28 / pxPerSec));
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const s0 = Math.ceil(t0 - 1e-6);
  const s1 = Math.floor(t1 + 1e-6);
  for (let s = s0; s <= s1; s++) {
    const x = KEYS_W + (s - t0) * pxPerSec;
    const labeled = s % labelEvery === 0;
    // tick mark: long if labeled, short otherwise
    ctx.strokeStyle = labeled ? theme.measureLine : theme.beatLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, timeTop);
    ctx.lineTo(x + 0.5, timeTop + (labeled ? 5 : 3));
    ctx.stroke();
    if (labeled) {
      ctx.fillStyle = theme.textDim;
      ctx.fillText(`${s}s`, x + 3, timeTop + TIME_H / 2 + 1);
    }
  }

  // start-of-system time stamp on left of bottom strip
  ctx.textAlign = "right";
  ctx.fillStyle = theme.text;
  ctx.fillText(fmtTime(t0), KEYS_W - 4, timeTop + TIME_H / 2 + 1);

  // System index on top-left of ruler
  ctx.textAlign = "right";
  ctx.fillStyle = theme.textDim;
  ctx.textBaseline = "top";
  ctx.fillText(`#${i + 1}`, KEYS_W - 4, top + 2);
}

function drawConnections(ctx, voices, i, t0, t1, tToX, mToY, layers, style) {
  const lw = style?.lineWidth ?? 1.4;
  const la = style?.lineAlpha ?? 0.65;
  const csa = style?.chordStemAlpha ?? 0.55;
  for (const v of voices) {
    if (v.muted) continue;
    if (v.kind === "piano-chords") {
      // chord stems: vertical line root→top
      if (layers.chordStems) {
        ctx.strokeStyle = hexA(v.color, csa);
        ctx.lineWidth = lw;
        for (const ev of v.events) {
          if (!ev.isChord) continue;
          if (ev.time < t0 || ev.time > t1) continue;
          const x = tToX(i, ev.time);
          ctx.beginPath();
          ctx.moveTo(x, mToY(i, ev.root.midi));
          ctx.lineTo(x, mToY(i, ev.top.midi));
          ctx.stroke();
        }
      }
      if (layers.rootProgression) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = hexA(v.color, la * 0.7);
        ctx.lineWidth = lw;
        polyline(ctx, v.events, ev => ev.root.midi, i, t0, t1, tToX, mToY);
        ctx.setLineDash([]);
      }
    } else if (layers.connections) {
      ctx.strokeStyle = hexA(v.color, la);
      ctx.lineWidth = lw;
      polyline(ctx, v.events, ev => (ev.isChord ? ev.root.midi : ev.members[0].midi), i, t0, t1, tToX, mToY);
    }
  }
}

function polyline(ctx, events, midiOf, i, t0, t1, tToX, mToY) {
  ctx.beginPath();
  let started = false;
  let prev = null;
  for (const ev of events) {
    const t = ev.time;
    if (t < t0) { prev = ev; continue; }
    if (t > t1) {
      // close with interpolation to the system edge
      if (started && prev) {
        const x0 = tToX(i, prev.time);
        const y0 = mToY(i, midiOf(prev));
        const x1 = tToX(i, t);
        const y1 = mToY(i, midiOf(ev));
        const f = (t1 - prev.time) / Math.max(1e-6, t - prev.time);
        ctx.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
      }
      break;
    }
    const x = tToX(i, t);
    const y = mToY(i, midiOf(ev));
    if (!started) {
      // interpolate from the previous (off-system) event to system start
      if (prev) {
        const x0 = tToX(i, prev.time); // negative, but ok
        const y0 = mToY(i, midiOf(prev));
        ctx.moveTo(Math.max(x0, tToX(i, t0)), y0); // approximate
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(x, y);
      }
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
    prev = ev;
  }
  ctx.stroke();
}

function drawNotes(ctx, voices, i, t0, t1, tToX, mToY, pxPerSec, style) {
  const dotScale = style?.dotScale ?? 1.0;
  for (const v of voices) {
    if (v.muted) continue;
    for (const n of v.notes) {
      const tEnd = n.time + n.duration;
      if (tEnd < t0 || n.time > t1) continue;
      const x = tToX(i, Math.max(n.time, t0));
      const y = mToY(i, n.midi);
      const xEnd = tToX(i, Math.min(tEnd, t1));
      const wRect = Math.max(2, xEnd - x);
      // duration bar
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = v.color;
      ctx.fillRect(x, y - 2, wRect, 4);
      ctx.globalAlpha = 1;
      if (n.time >= t0 && n.time <= t1) {
        const r = (2.8 + (n.velocity || 0.7) * 4) * dotScale;
        const cx = tToX(i, n.time);
        ctx.beginPath();
        ctx.arc(cx, y, r, 0, Math.PI * 2);
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = v.color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.strokeStyle = v.color;
        ctx.stroke();
      }
    }
  }
}

function drawChordLabels(ctx, voices, i, t0, t1, tToX, mToY, theme) {
  ctx.font = "11px ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const v of voices) {
    if (v.muted || v.kind !== "piano-chords") continue;
    for (const ev of v.events) {
      if (!ev.isChord || !ev.chordName) continue;
      if (ev.time < t0 || ev.time > t1) continue;
      const x = tToX(i, ev.time);
      const y = mToY(i, ev.top.midi) - 10;
      const text = ev.chordName;
      const w = ctx.measureText(text).width + 8;
      const h = 14;
      ctx.fillStyle = theme.chordBg;
      ctx.fillRect(x - w/2, y - h/2, w, h);
      ctx.strokeStyle = hexA(v.color, 0.85);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - w/2 + 0.5, y - h/2 + 0.5, w - 1, h - 1);
      ctx.fillStyle = theme.text;
      ctx.fillText(text, x, y);
    }
  }
}

function hexA(hex, a) {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0,2), 16);
  const g = parseInt(m.slice(2,4), 16);
  const b = parseInt(m.slice(4,6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function drawLegend(ctx, voices, x, y, w, h, theme) {
  ctx.save();
  ctx.font = "11px ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const gap = 14;
  const swatchR = 5;
  let cx = x;
  const cy = y + h / 2;
  for (const v of voices) {
    if (v.muted) continue;
    const label = v.label || v.name || v.kind || "voice";
    const tw = ctx.measureText(label).width;
    const block = swatchR * 2 + 6 + tw + gap;
    if (cx + block > x + w) break;
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.arc(cx + swatchR, cy, swatchR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexA(v.color, 0.9);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = theme.text || theme.title;
    ctx.fillText(label, cx + swatchR * 2 + 6, cy);
    cx += block;
  }
  ctx.restore();
}
