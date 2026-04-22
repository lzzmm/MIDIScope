// Data export — turns a parsed song + voices into tabular rows for CSV / XLSX.
//
// Exports:
//   buildRows(song, voices, opts) → { headers, rows }
//   toCSV({ headers, rows }) → string
//   toXLSX({ headers, rows }, sheetName) → Promise<Blob>
//
// opts:
//   grouping:   "note" | "beat" | "halfbeat" | "quarterbeat" | "bar" | "chord"
//   columns:    string[]  (subset of the union of all known column keys)
//   timeFormat: "sec" | "mmss"
//   decimals:   number    (decimals for time_sec / duration_sec)

import { nameChord } from "./chordName.js";

const PCS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const PER_NOTE_COLS = new Set([
  "voice", "pitch", "midi", "duration", "velocity",
  "chord_name", "chord_root", "chord_quality", "chord_bass",
  "track",
]);
const VOICE_COLS = new Set(["Melody", "Harmony", "Bass", "Flute"]);

// ----- public -----

export function buildRows(song, voices, opts = {}) {
  const grouping  = opts.grouping  ?? "note";
  const columns   = opts.columns   ?? ["time", "bar", "beat", "voice", "pitch", "midi", "duration", "velocity"];
  const timeFmt   = opts.timeFormat ?? "sec";
  const decimals  = opts.decimals  ?? 3;

  const liveVoices = voices.filter(v => !v.muted);

  if (grouping === "note") {
    return buildNoteRows(song, liveVoices, columns, timeFmt, decimals);
  }
  if (grouping === "chord") {
    return buildChordRows(song, liveVoices, columns, timeFmt, decimals);
  }
  // grid groupings
  const subdiv =
    grouping === "halfbeat"    ? 2 :
    grouping === "quarterbeat" ? 4 :
    grouping === "bar"         ? "bar" : 1;
  return buildGridRows(song, liveVoices, columns, timeFmt, decimals, subdiv);
}

export function toCSV(table) {
  const { headers, rows } = table;
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

let _xlsxPromise = null;
function loadSheetJS() {
  if (typeof window !== "undefined" && window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error("SheetJS failed to load"));
    s.onerror = () => reject(new Error("SheetJS failed to load"));
    document.head.appendChild(s);
  });
  return _xlsxPromise;
}

export async function toXLSX(table, sheetName = "data") {
  const XLSX = await loadSheetJS();
  // Quote any string starting with =/+/-/@ to block formula injection.
  const safeRows = table.rows.map(r => r.map(cell => {
    if (typeof cell === "string" && /^[=+\-@]/.test(cell)) return "'" + cell;
    return cell;
  }));
  const aoa = [table.headers, ...safeRows];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ----- builders -----

function buildNoteRows(song, voices, columns, timeFmt, decimals) {
  const cols = filterCols(columns, /*pivot=*/false);
  const headers = cols.map(headerLabel);
  const rows = [];
  for (const v of voices) {
    for (const ev of v.events) {
      // emit one row per onset event member (each note in the chord gets a row)
      const chordName = ev.isChord ? nameChord(ev.members.map(n => n.midi)) : null;
      const chordParts = chordName ? splitChord(chordName) : null;
      for (const n of ev.members) {
        const bb = barBeat(song, n.time);
        const row = cols.map(c => valueForNote(c, n, v, ev, song, bb, chordName, chordParts, timeFmt, decimals));
        rows.push(row);
      }
    }
  }
  rows.sort((a, b) => {
    // sort by first time column if present, else stable by insertion
    const i = cols.indexOf("time");
    if (i < 0) return 0;
    return cmp(a[i], b[i]);
  });
  return { headers, rows };
}

function buildChordRows(song, voices, columns, timeFmt, decimals) {
  const cols = filterCols(columns, /*pivot=*/false);
  const headers = cols.map(headerLabel);
  const rows = [];
  // Find the chord-bearing voice (kind === "piano-chords") if any; else any voice with events.
  const chordVoices = voices.filter(v => v.kind === "piano-chords");
  const sources = chordVoices.length ? chordVoices : voices;
  const events = [];
  for (const v of sources) {
    for (const ev of v.events) {
      if (!ev.isChord) continue;
      events.push({ ev, voice: v });
    }
  }
  events.sort((a, b) => a.ev.time - b.ev.time);
  for (let i = 0; i < events.length; i++) {
    const { ev, voice } = events[i];
    const next = events[i + 1];
    const dur = next ? next.ev.time - ev.time : Math.max(...ev.members.map(m => m.duration));
    const chordName = nameChord(ev.members.map(n => n.midi));
    const chordParts = chordName ? splitChord(chordName) : null;
    const bb = barBeat(song, ev.time);
    const synthN = { time: ev.time, midi: ev.root.midi, duration: dur, velocity: ev.root.velocity };
    const row = cols.map(c => valueForNote(c, synthN, voice, ev, song, bb, chordName, chordParts, timeFmt, decimals));
    rows.push(row);
  }
  return { headers, rows };
}

function buildGridRows(song, voices, columns, timeFmt, decimals, subdiv) {
  const cols = filterCols(columns, /*pivot=*/true);
  const headers = cols.map(headerLabel);
  const rows = [];
  const grid = buildGrid(song, subdiv);

  // Per-voice index: which voice supplies each pivot column.
  const voiceForCol = (label) => {
    if (label === "Melody")  return voices.find(v => v.kind === "piano-melody")
                                   ?? voices.find(v => /melody/i.test(v.label || ""));
    if (label === "Bass")    return voices.find(v => v.kind === "piano-bass")
                                   ?? voices.find(v => /bass/i.test(v.label || ""));
    if (label === "Flute")   return voices.find(v => v.kind === "flute");
    if (label === "Harmony") return voices.find(v => v.kind === "piano-chords");
    return null;
  };

  for (const g of grid) {
    const row = cols.map(c => {
      switch (c) {
        case "time":           return formatTime(g.time, timeFmt, decimals);
        case "bar":            return g.bar;
        case "beat":           return g.beat;
        case "tempo_bpm":      return roundTo(tempoAt(song, g.time), 2);
        case "time_signature": return tsAt(song, g.time);
        case "Melody": case "Bass": case "Flute": {
          const v = voiceForCol(c);
          if (!v) return "";
          return notesAt(v, g.time, g.window).map(n => PCS[n.midi % 12] + Math.floor(n.midi / 12 - 1)).join("+");
        }
        case "Harmony": {
          const v = voiceForCol("Harmony");
          if (!v) {
            // fallback: name from any chord event near this time across all voices
            const best = nearestChordEventAcrossVoices(voices, g.time);
            if (!best) return "";
            return nameChord(best.members.map(n => n.midi)) || "";
          }
          const ev = nearestChordEvent(v, g.time);
          if (!ev) return "";
          return nameChord(ev.members.map(n => n.midi)) || "";
        }
        default: return "";
      }
    });
    rows.push(row);
  }
  return { headers, rows };
}

// ----- helpers: time + grid -----

function buildGrid(song, subdiv) {
  // subdiv: 1 (per beat), 2 (per ½), 4 (per ¼), or "bar" (per bar)
  const out = [];
  const header = song.header;
  const ppq = song.ppq;
  const totalDur = song.durationSec;
  const tsList = song.timeSignatures.length
    ? song.timeSignatures
    : [{ time: 0, ticks: 0, numerator: 4, denominator: 4, measures: 0 }];

  for (let si = 0; si < tsList.length; si++) {
    const ts = tsList[si];
    const next = tsList[si + 1];
    const segStartTick = ts.ticks ?? 0;
    const segEndTick = next ? (next.ticks ?? 0) : header.secondsToTicks(totalDur);
    const ticksPerBeat = ppq * (4 / ts.denominator);
    const ticksPerMeasure = ticksPerBeat * ts.numerator;
    const startMeasureNo = Math.round(ts.measures ?? 0);
    const measuresInSeg = Math.max(1, Math.ceil((segEndTick - segStartTick) / ticksPerMeasure));

    for (let mi = 0; mi < measuresInSeg; mi++) {
      const measureTick = segStartTick + mi * ticksPerMeasure;
      if (measureTick >= segEndTick) break;
      const barNo = startMeasureNo + mi + 1;

      if (subdiv === "bar") {
        const t = header.ticksToSeconds(measureTick);
        if (t > totalDur + 0.001) break;
        const tNext = header.ticksToSeconds(measureTick + ticksPerMeasure);
        out.push({ time: t, bar: barNo, beat: 1, window: Math.max(0.05, tNext - t) });
        continue;
      }

      const stepsPerMeasure = ts.numerator * subdiv;
      for (let s = 0; s < stepsPerMeasure; s++) {
        const tickAt = measureTick + s * (ticksPerBeat / subdiv);
        if (tickAt > segEndTick + 1) break;
        const t = header.ticksToSeconds(tickAt);
        if (t > totalDur + 0.001) break;
        const beatNo = (s / subdiv) + 1; // 1, 1.5, 2, … (or 1, 1.25, …)
        const tNext = header.ticksToSeconds(tickAt + ticksPerBeat / subdiv);
        out.push({ time: t, bar: barNo, beat: beatNo, window: Math.max(0.05, tNext - t) });
      }
    }
  }
  return out;
}

function barBeat(song, sec) {
  const header = song.header;
  const ppq = song.ppq;
  const tick = header.secondsToTicks(sec);
  const tsList = song.timeSignatures.length
    ? song.timeSignatures
    : [{ ticks: 0, numerator: 4, denominator: 4, measures: 0 }];
  let active = tsList[0];
  for (const ts of tsList) {
    if ((ts.ticks ?? 0) <= tick) active = ts;
    else break;
  }
  const ticksPerBeat = ppq * (4 / active.denominator);
  const ticksPerMeasure = ticksPerBeat * active.numerator;
  const segTick = (active.ticks ?? 0);
  const dt = tick - segTick;
  const measureIdx = Math.floor(dt / ticksPerMeasure);
  const inMeasure = dt - measureIdx * ticksPerMeasure;
  const beat = inMeasure / ticksPerBeat + 1; // 1-based, fractional
  const bar = Math.round(active.measures ?? 0) + measureIdx + 1;
  return { bar, beat: roundTo(beat, 4) };
}

function tempoAt(song, sec) {
  const tempos = song.tempos || [];
  if (!tempos.length) return 120;
  let active = tempos[0];
  for (const t of tempos) { if (t.time <= sec) active = t; else break; }
  return active.bpm;
}

function tsAt(song, sec) {
  const list = song.timeSignatures || [];
  if (!list.length) return "4/4";
  let active = list[0];
  for (const ts of list) { if ((ts.time ?? 0) <= sec) active = ts; else break; }
  return `${active.numerator}/${active.denominator}`;
}

// ----- helpers: voices / events at time -----

function notesAt(voice, t, window) {
  // Notes whose onset is within [t - 0.005, t + window) AND notes still sounding at t.
  const out = [];
  for (const n of voice.notes) {
    const start = n.time;
    const end = n.time + n.duration;
    if (start >= t - 0.005 && start < t + window) out.push(n);
    else if (start < t && end > t + 0.005 && out.indexOf(n) < 0) out.push(n);
  }
  // Dedupe + sort low→high
  return [...new Set(out)].sort((a, b) => a.midi - b.midi);
}

function nearestChordEvent(voice, t) {
  // Last chord event with onset ≤ t whose duration covers t (or any chord-like ≤ t).
  let best = null;
  for (const ev of voice.events) {
    if (!ev.isChord) continue;
    if (ev.time <= t + 0.005) best = ev;
    else break;
  }
  return best;
}

function nearestChordEventAcrossVoices(voices, t) {
  let best = null;
  for (const v of voices) {
    const ev = nearestChordEvent(v, t);
    if (ev && (!best || ev.time > best.time)) best = ev;
  }
  return best;
}

// ----- value formatting -----

function valueForNote(c, n, v, ev, song, bb, chordName, chordParts, timeFmt, decimals) {
  switch (c) {
    case "time":          return formatTime(n.time, timeFmt, decimals);
    case "bar":           return bb.bar;
    case "beat":          return bb.beat;
    case "voice":         return v.label || v.id || "";
    case "pitch":         return PCS[n.midi % 12] + Math.floor(n.midi / 12 - 1);
    case "midi":          return n.midi;
    case "duration":      return roundTo(n.duration, decimals);
    case "velocity":      return roundTo(n.velocity ?? 0.7, 3);
    case "chord_name":    return chordName || "";
    case "chord_root":    return chordParts?.root || "";
    case "chord_quality": return chordParts?.quality || "";
    case "chord_bass":    return chordParts?.bass || "";
    case "track":         return v.kind || "";
    case "tempo_bpm":     return roundTo(tempoAt(song, n.time), 2);
    case "time_signature":return tsAt(song, n.time);
    default: return "";
  }
}

function formatTime(sec, mode, decimals) {
  if (mode === "mmss") {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, "0")}`;
  }
  return roundTo(sec, decimals);
}

function roundTo(x, n) {
  const p = Math.pow(10, n);
  return Math.round(x * p) / p;
}

function splitChord(name) {
  // Split "Em7/G" into root="E", quality="m7", bass="G".
  const m = /^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/.exec(name);
  if (!m) return { root: name, quality: "", bass: "" };
  return { root: m[1], quality: m[2] || "", bass: m[3] || "" };
}

// ----- column filtering -----

function filterCols(columns, pivot) {
  // Keep only valid columns for this mode.
  return columns.filter(c => {
    if (c === "time" || c === "bar" || c === "beat") return true;
    if (c === "tempo_bpm" || c === "time_signature") return true;
    if (pivot) return VOICE_COLS.has(c);
    return PER_NOTE_COLS.has(c) || VOICE_COLS.has(c) === false;
  });
}

function headerLabel(c) {
  switch (c) {
    case "time":           return "time";
    case "bar":            return "bar";
    case "beat":           return "beat";
    case "duration":       return "duration_sec";
    case "tempo_bpm":      return "tempo_bpm";
    case "time_signature": return "time_signature";
    default: return c;
  }
}

// ----- CSV serialization (RFC 4180 + formula-injection guard) -----

function csvCell(v) {
  if (v == null) return "";
  let s = String(v);
  // Block formula injection in spreadsheet apps.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function cmp(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}
