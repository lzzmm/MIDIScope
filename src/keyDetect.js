// Key (tonality) detection from a MIDI pitch-class histogram, using the
// classic Krumhansl–Schmuckler key-profile correlation. We weight each
// note by its actual sounding duration so a held whole-note tonic counts
// for more than a passing eighth.
//
// Two entry points:
//   detectKey(hist)             — single best (tonic, mode) for one window
//   detectKeyTimeline(song, voices, segmentBars)
//                                — segment the song by bar groups and run
//                                  detection per segment, then merge runs
//                                  of identical results so a key change is
//                                  represented exactly once.

import { tonicPc } from "./consonance.js";

// Krumhansl–Kessler experimental key profiles.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TONIC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

function rotated(profile, k) {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) out[i] = profile[(i - k + 12) % 12];
  return out;
}

function pearson(a, b) {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb;
    da  += xa * xa;
    db  += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/**
 * Build a duration-weighted pitch-class histogram (length 12) from notes
 * whose onset falls in [t0, t1).
 */
export function pitchHistogram(voices, t0, t1) {
  const h = new Array(12).fill(0);
  for (const v of voices || []) {
    if (v.muted) continue;
    if (v.kind === "drums" || v.kind === "perc" || v.kind === "fx") continue;
    for (const n of (v.notes || [])) {
      if (n.time < t0 || n.time >= t1) continue;
      const pc = ((n.midi % 12) + 12) % 12;
      h[pc] += Math.max(0.05, Math.min(n.duration || 0.25, 4));
    }
  }
  return h;
}

/**
 * Run KK correlation against all 24 keys; return the best plus a sorted
 * candidate list with confidences (Pearson r, 0..1).
 *
 * @param {number[]} hist length-12 histogram
 * @returns {{tonic, mode, tonicPc, r, ranked}}
 */
export function detectKey(hist) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { tonic: "C", mode: "major", tonicPc: 0, r: 0, ranked: [] };
  }
  const ranked = [];
  for (let k = 0; k < 12; k++) {
    ranked.push({ tonic: TONIC_NAMES[k], mode: "major", tonicPc: k, r: pearson(hist, rotated(KK_MAJOR, k)) });
    ranked.push({ tonic: TONIC_NAMES[k], mode: "minor", tonicPc: k, r: pearson(hist, rotated(KK_MINOR, k)) });
  }
  ranked.sort((a, b) => b.r - a.r);
  const best = ranked[0];
  return { ...best, ranked };
}

/**
 * Bar-segmented key detection. `segmentBars` controls how many bars of
 * audio go into each detection window (4–8 is usually right for tonal
 * music; smaller windows over-react to passing chords).
 *
 * Returns an array of {bar, time, tonic, mode, tonicPc, r}, with
 * consecutive segments that resolved to the same key collapsed into one
 * entry. The first entry always starts at bar 1 / time 0.
 */
export function detectKeyTimeline(song, voices, segmentBars = 4) {
  if (!song) return [];
  const bars = computeBarStarts(song);
  if (bars.length < 2) {
    const all = pitchHistogram(voices, 0, song.durationSec || 0);
    const k = detectKey(all);
    return [{ bar: 1, time: 0, tonic: k.tonic, mode: k.mode, tonicPc: k.tonicPc, r: k.r }];
  }
  const seg = Math.max(1, segmentBars | 0);
  const segments = [];
  for (let i = 0; i < bars.length - 1; i += seg) {
    const t0 = bars[i];
    const t1 = bars[Math.min(i + seg, bars.length - 1)];
    const hist = pitchHistogram(voices, t0, t1);
    const k = detectKey(hist);
    segments.push({ bar: i + 1, time: t0, tonic: k.tonic, mode: k.mode, tonicPc: k.tonicPc, r: k.r });
  }
  // Collapse consecutive identical keys.
  const merged = [];
  for (const s of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.tonic === s.tonic && prev.mode === s.mode) continue;
    merged.push(s);
  }
  // First segment must start at bar 1 / time 0.
  if (merged[0]) { merged[0].bar = 1; merged[0].time = 0; }
  return merged;
}

/**
 * Returns the timeline entry active at time `t` (last entry with
 * `time <= t`), or null when the timeline is empty.
 */
export function keyAt(timeline, t) {
  if (!timeline?.length) return null;
  let best = timeline[0];
  for (const e of timeline) { if (e.time <= t + 1e-6) best = e; else break; }
  return best;
}

// ---------- bar timing ----------
//
// Walk the time-signature list and accumulate seconds-per-bar at each
// tempo. `song.timeSignatures[i].time` is in seconds; `tempos[i].time`
// likewise. We sample bar onsets up to song.durationSec.
function computeBarStarts(song) {
  const dur = song.durationSec || 0;
  if (dur <= 0) return [];
  const ts = (song.timeSignatures && song.timeSignatures.length)
    ? [...song.timeSignatures].sort((a, b) => a.time - b.time)
    : [{ time: 0, numerator: 4, denominator: 4 }];
  const tempos = (song.tempos && song.tempos.length)
    ? [...song.tempos].sort((a, b) => a.time - b.time)
    : [{ time: 0, bpm: 120 }];
  const bpmAt = (t) => {
    let active = tempos[0];
    for (const x of tempos) { if (x.time <= t) active = x; else break; }
    return active.bpm || 120;
  };
  const starts = [0];
  let t = 0;
  // Walk one bar at a time. Use the time-signature active at `t`.
  let safety = 0;
  while (t < dur && safety++ < 100000) {
    let activeTs = ts[0];
    for (const x of ts) { if (x.time <= t + 1e-6) activeTs = x; else break; }
    const num = activeTs.numerator || 4;
    const den = activeTs.denominator || 4;
    const bpm = bpmAt(t);
    const beatSec = 60 / bpm;
    // A "beat" in MIDI tempo is a quarter-note; scale by denominator.
    const barSec = num * beatSec * (4 / den);
    t += barSec;
    if (!isFinite(barSec) || barSec <= 0) break;
    starts.push(t);
  }
  return starts;
}

export { TONIC_NAMES, tonicPc };

/**
 * Auto-detect modulations across a song without the caller having to
 * pick a fixed segmentation interval. The algorithm:
 *
 *   1. Run detectKey on a small sliding window (default 2 bars) at
 *      every bar onset to get a per-bar best-key sequence.
 *   2. Smooth the sequence with a majority filter over `smoothBars` bars
 *      so single-bar fluctuations from passing chords don't trigger a
 *      modulation.
 *   3. Collapse runs of identical keys.
 *   4. Discard runs shorter than `minRunBars` (folded into the longer
 *      neighbour) so transient tonicizations don't pollute the timeline.
 *
 * Returns the same shape as detectKeyTimeline: an array of
 *   { bar, time, tonic, mode, tonicPc, r }.
 */
export function autoDetectKeyChanges(song, voices, opts = {}) {
  const winBars     = Math.max(1, opts.windowBars  ?? 2);
  const smoothBars  = Math.max(1, opts.smoothBars  ?? 3);
  const minRunBars  = Math.max(1, opts.minRunBars  ?? 4);
  if (!song) return [];
  const bars = computeBarStarts(song);
  if (bars.length < 2) {
    const all = pitchHistogram(voices, 0, song.durationSec || 0);
    const k = detectKey(all);
    return [{ bar: 1, time: 0, tonic: k.tonic, mode: k.mode, tonicPc: k.tonicPc, r: k.r }];
  }
  // Step 1: per-bar best key (window centred on each bar).
  const perBar = [];
  for (let i = 0; i < bars.length - 1; i++) {
    const t0 = bars[i];
    const t1 = bars[Math.min(i + winBars, bars.length - 1)];
    const hist = pitchHistogram(voices, t0, t1);
    const k = detectKey(hist);
    perBar.push({ bar: i + 1, time: t0, tonic: k.tonic, mode: k.mode, tonicPc: k.tonicPc, r: k.r });
  }
  // Step 2: majority-vote smoothing.
  const smoothed = perBar.map((_, i) => {
    const a = Math.max(0, i - Math.floor(smoothBars / 2));
    const b = Math.min(perBar.length, a + smoothBars);
    const tally = new Map();
    let bestKey = null, bestCount = -1;
    for (let j = a; j < b; j++) {
      const key = perBar[j].tonic + ":" + perBar[j].mode;
      const c = (tally.get(key) || 0) + 1;
      tally.set(key, c);
      if (c > bestCount) { bestCount = c; bestKey = perBar[j]; }
    }
    return { ...perBar[i], tonic: bestKey.tonic, mode: bestKey.mode, tonicPc: bestKey.tonicPc };
  });
  // Step 3: collapse runs.
  const runs = [];
  for (const s of smoothed) {
    const prev = runs[runs.length - 1];
    if (prev && prev.tonic === s.tonic && prev.mode === s.mode) {
      prev.endBar = s.bar;
    } else {
      runs.push({ ...s, endBar: s.bar });
    }
  }
  // Step 4: drop short runs (< minRunBars) by absorbing into the
  // previous run; if the very first run is short, absorb the next into
  // it instead so the timeline still starts at bar 1.
  const filtered = [];
  for (const r of runs) {
    const len = r.endBar - r.bar + 1;
    if (len < minRunBars && filtered.length) {
      filtered[filtered.length - 1].endBar = r.endBar;
    } else {
      filtered.push(r);
    }
  }
  // Re-collapse after absorption (neighbours might now match).
  const merged = [];
  for (const r of filtered) {
    const prev = merged[merged.length - 1];
    if (prev && prev.tonic === r.tonic && prev.mode === r.mode) {
      prev.endBar = r.endBar;
    } else {
      merged.push(r);
    }
  }
  // Drop the internal endBar field; clients only care about start.
  const out = merged.map(r => ({ bar: r.bar, time: r.time, tonic: r.tonic, mode: r.mode, tonicPc: r.tonicPc, r: r.r }));
  if (out[0]) { out[0].bar = 1; out[0].time = 0; }
  return out;
}
