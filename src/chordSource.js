// Build a single virtual "chord track" from the user's manually-selected
// chord-source voices. The notes from every selected voice are pooled and
// re-clustered using the same onset-window algorithm as voicing.js, so
// e.g. selecting both "Piano · Bass" and "Piano · Chords" lets the bass
// note participate in chord-naming and consonance analysis.
//
// Each event also carries `consonance` (0|1|2|null) computed from the
// pooled chord's pitch-class set.

import { detectEvents } from "./voicing.js";
import { nameChord } from "./chordName.js";
import { chordConsonance, chordConsonanceByDegree, noteNameToPc, rootDegreeNumber } from "./consonance.js";
import { keyAt } from "./keyDetect.js";

/**
 * @param {Array} voices                       — current voice list
 * @param {Set<string>|null} sourceIds         — voice.id of selected voices.
 *                                                When null/empty, returns [].
 * @param {number} onsetWindow                 — clustering tolerance (sec)
 *                                                for the "window" mode.
 * @param {object} [opts]
 * @param {"interval"|"degree"} [opts.method]  — consonance algorithm.
 * @param {Array}  [opts.keyTimeline]          — segments from keyDetect; only
 *                                                used when method === "degree".
 * @param {"window"|"beat"|"bar"|"sustain"} [opts.poolMode]
 *                                              — chord pooling strategy.
 *                                                "window"  : cluster by onset window
 *                                                "beat"    : one event per metric beat
 *                                                "bar"     : one event per bar
 *                                                "sustain" : merge by sustain overlap
 *                                                Defaults to "window".
 * @param {object} [opts.song]                  — required for "beat" / "bar".
 *                                                Used to read the metric grid.
 * @param {boolean} [opts.sustainOverlap]       — legacy boolean shortcut for
 *                                                poolMode === "sustain".
 * @returns {Array<{time, members, isChord, root, top, meanPitch,
 *                  chordName, consonance, rootPc, rootDegree, keyTonicPc, keyMode}>}
 */
export function buildChordEvents(voices, sourceIds, onsetWindow = 0.045, opts = {}) {
  if (!voices?.length || !sourceIds || !sourceIds.size) return [];
  const method      = opts.method === "interval" ? "interval" : "degree";
  const keyTimeline = Array.isArray(opts.keyTimeline) ? opts.keyTimeline : null;
  const poolMode    = opts.poolMode
                     || (opts.sustainOverlap ? "sustain" : "window");
  const pool = [];
  for (const v of voices) {
    if (!sourceIds.has(v.id)) continue;
    for (const n of v.notes) pool.push(n);
  }
  if (!pool.length) return [];
  let events;
  if (poolMode === "sustain") {
    events = clusterBySustainOverlap(pool);
  } else if ((poolMode === "beat" || poolMode === "bar") && opts.song) {
    events = clusterByMetric(pool, opts.song, poolMode);
  } else {
    events = detectEvents(pool, onsetWindow);
  }
  for (const ev of events) {
    if (!ev.isChord) {
      ev.chordName  = null;
      ev.consonance = null;
      ev.rootPc     = null;
      ev.rootDegree = null;
      ev.keyTonicPc = null;
      ev.keyMode    = null;
      continue;
    }
    ev.chordName = nameChord(ev.members.map(m => m.midi));
    // Root pc is parsed from the chord name (which respects inversions),
    // falling back to the lowest sounding pitch when naming fails.
    let rootPc = null;
    if (ev.chordName) {
      const m = /^([A-G](?:#|b)?)/.exec(ev.chordName);
      if (m) rootPc = noteNameToPc(m[1]);
    }
    if (rootPc == null && ev.root) rootPc = ((ev.root.midi % 12) + 12) % 12;
    ev.rootPc = rootPc;

    const key = keyTimeline ? keyAt(keyTimeline, ev.time) : null;
    ev.keyTonicPc = key ? key.tonicPc : null;
    ev.keyMode    = key ? key.mode    : null;
    ev.rootDegree = key ? rootDegreeNumber(rootPc, key.tonicPc, key.mode) : null;

    if (method === "degree" && key) {
      ev.consonance = chordConsonanceByDegree(rootPc, key.tonicPc, key.mode);
      // Fallback to interval if the degree method couldn't classify
      // (shouldn't happen — chromatic returns 2 — but be safe).
      if (ev.consonance == null) ev.consonance = chordConsonance(ev.members.map(m => m.midi));
    } else {
      ev.consonance = chordConsonance(ev.members.map(m => m.midi));
    }
  }
  return events;
}

/**
 * Compute the default chord-source selection for a freshly-loaded song:
 *   - if the song has BOTH a "piano-chords" and a "piano-bass" voice,
 *     pick both — that's the typical accompaniment + bassline split where
 *     the bass is a real chord tone (e.g. Satie's bass G turning a B-D-F#
 *     into a G-major7);
 *   - else if any voice has kind "piano-chords", pick exactly those;
 *   - else if any voice's kind starts with "piano", pick all of them;
 *   - else empty (user must opt in).
 *
 * Returns a Set<voice.id>.
 */
/**
 * Compute the default chord-source selection for a freshly-loaded song.
 *
 * Strategy (in order of signal strength):
 *   1. Per-voice ACCOMPANIMENT SCORE based on:
 *        - track / voice name regex (highest signal):
 *            +3 for /accomp|comp[\s:_-]|harmony|chord|backing|continuo|basso/i
 *            +2 for /\bbass\b|left[\s_-]?hand|\blh\b|\bl\.h\.|\bleft\b/i
 *            -3 for /melody|solo|lead|voc|vox|sing|aria/i
 *            -2 for /right[\s_-]?hand|\brh\b|\br\.h\.|\bright\b/i
 *        - polyphony: +1 if >40% events are chords, -1 if >85% mono
 *        - register : +1 if mean pitch <= 55 (bass), -1 if >= 78 (top)
 *      Voices with score >= 1 are picked.
 *   2. If no voice scores positive AND we have explicit piano kinds,
 *      fall back to the legacy piano-chords + piano-bass logic.
 *   3. Else fall back to "drop the highest-register monophonic line,
 *      keep the rest" (orchestral fallback).
 *   4. Always exclude drums / fx / perc; pitched percussion (timpani,
 *      mallet) is allowed because it carries real harmony.
 */
export function defaultChordSources(voices) {
  const ids = new Set();
  if (!voices?.length) return ids;

  // (1) Name-based + structural scoring across all pitched candidates.
  const candidates = voices.filter(isChordSourceCandidate);
  if (!candidates.length) return ids;

  const profiles = candidates.map(v => {
    const events = v.events || [];
    const totalEv = events.length || 1;
    const monoFrac = events.filter(e => !e.isChord).length / totalEv;
    const meanPitch = v.notes.length
      ? v.notes.reduce((s, n) => s + n.midi, 0) / v.notes.length
      : 0;
    const label = `${v.label || ""} ${v.id || ""}`;
    let score = 0;
    if (/accomp|comp[\s:_\-]|\bharmony\b|\bchord\b|backing|continuo|basso/i.test(label)) score += 3;
    if (/\bbass\b|left[\s_\-]?hand|\blh\b|\bl\.h\.|\bleft\b/i.test(label)) score += 2;
    if (/\btimp|kettle|cello|contrabass|double[\s_\-]?bass/i.test(label)) score += 2;
    if (/\bmelody\b|\bsolo\b|\blead\b|\bvoc\b|\bvox\b|\bsing\b|\baria\b|cantus|treble/i.test(label)) score -= 3;
    if (/right[\s_\-]?hand|\brh\b|\br\.h\.|\bright\b/i.test(label)) score -= 2;
    if (monoFrac < 0.40) score += 1;
    if (monoFrac > 0.85) score -= 1;
    if (meanPitch <= 55) score += 1;
    if (meanPitch <= 48) score += 1;          // very low → almost certainly bass
    if (meanPitch >= 78) score -= 1;
    // Voice-kind bias from voicing.js — these are already split out as
    // dedicated harmony / bass voices, so they're high-confidence picks.
    if (v.kind === "piano-chords") score += 5;
    if (v.kind === "piano-bass")   score += 4;
    if (v.kind === "piano-melody") score -= 2;
    if (v.kind === "timpani")      score += 1;
    return { v, score, monoFrac, meanPitch };
  });

  // Relative-register pass: in any multi-voice score the bottom voices
  // (by mean pitch) are almost always cellos/contrabass/LH playing the
  // harmonic foundation, even when their track names are uninformative
  // (Handel's "Arrival of the Queen of Sheba" labels its bass tracks
  // "by", "G. Pollen", "(2003)"). Boost the lowest ~third of voices.
  if (profiles.length >= 3) {
    const sortedByPitch = [...profiles].sort((a, b) => a.meanPitch - b.meanPitch);
    const bassCount = Math.max(1, Math.round(sortedByPitch.length / 3));
    for (let i = 0; i < bassCount; i++) {
      const p = sortedByPitch[i];
      // Only boost actual low-register voices (don't promote a lone
      // mid-register part just because it ranks bottom in a duo).
      if (p.meanPitch <= 60) p.score += 2;
    }
    // And lightly penalise the top third so we don't accidentally pick
    // every voice in a dense orchestral score.
    for (let i = sortedByPitch.length - bassCount; i < sortedByPitch.length; i++) {
      const p = sortedByPitch[i];
      if (p.meanPitch >= 70 && p.monoFrac >= 0.85) p.score -= 1;
    }
  }

  const positives = profiles.filter(p => p.score >= 1);
  if (positives.length) {
    for (const p of positives) ids.add(p.v.id);
    // If we ended up with EVERY pitched voice picked (rare), also drop
    // the highest-register monophonic line — that's almost certainly
    // the melody and including it just confuses the chord namer.
    if (positives.length === candidates.length && candidates.length > 1) {
      const monoTop = profiles
        .filter(p => p.monoFrac >= 0.8)
        .reduce((a, b) => (!a || b.meanPitch > a.meanPitch ? b : a), null);
      if (monoTop) ids.delete(monoTop.v.id);
    }
    return ids;
  }

  // (2) Legacy piano fallback.
  const chordVoices = voices.filter(v => v.kind === "piano-chords");
  const bassVoices  = voices.filter(v => v.kind === "piano-bass");
  if (chordVoices.length && bassVoices.length) {
    for (const v of chordVoices) ids.add(v.id);
    for (const v of bassVoices)  ids.add(v.id);
    return ids;
  }
  if (chordVoices.length) {
    for (const v of chordVoices) ids.add(v.id);
    return ids;
  }
  const pianoVoices = voices.filter(v => typeof v.kind === "string" && v.kind.startsWith("piano"));
  if (pianoVoices.length) {
    for (const v of pianoVoices) ids.add(v.id);
    return ids;
  }

  // (3) Orchestral fallback: drop the highest-register monophonic line.
  if (candidates.length === 1) { ids.add(candidates[0].id); return ids; }
  let melody = null;
  for (const p of profiles) {
    if (p.monoFrac >= 0.8 && (!melody || p.meanPitch > melody.meanPitch)) melody = p;
  }
  for (const p of profiles) {
    if (melody && p.v === melody.v && profiles.length > 1) continue;
    ids.add(p.v.id);
  }
  return ids;
}

// Voices whose kind has no real pitched content shouldn't be offered as
// chord-analysis sources (their "notes" are GM drum-map indices or noise).
export function isChordSourceCandidate(voice) {
  return voice && voice.kind !== "drums" && voice.kind !== "perc" && voice.kind !== "fx";
}

// Alternative pooling: merge any notes whose sustains overlap into one
// chord. We sweep the timeline by note onset; whenever a new onset
// appears while at least one previously-started note is still sounding,
// the new note joins the open cluster. The cluster closes at the moment
// no notes are sounding. This is independent of any onset window — it's
// the "what notes are physically being held together" view, perfect for
// arpeggios and pedal-sustained accompaniment patterns.
function clusterBySustainOverlap(notes) {
  if (!notes.length) return [];
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const events = [];
  let openMembers = [];
  let openStart = 0;
  let openEnd = -Infinity;     // max (time + duration) of all open members
  const flush = () => {
    if (!openMembers.length) return;
    const members = openMembers.slice();
    const root = members.reduce((a, b) => (a.midi <= b.midi ? a : b));
    const top  = members.reduce((a, b) => (a.midi >= b.midi ? a : b));
    const meanPitch = members.reduce((s, n) => s + n.midi, 0) / members.length;
    events.push({
      time: openStart,
      members,
      isChord: members.length >= 2,
      root, top, meanPitch,
    });
    openMembers = [];
    openEnd = -Infinity;
  };
  for (const n of sorted) {
    if (n.time > openEnd + 1e-6) {
      flush();
      openStart = n.time;
    }
    openMembers.push(n);
    const end = n.time + (n.duration || 0);
    if (end > openEnd) openEnd = end;
  }
  flush();
  return events;
}

// Metric pooling: walk the score's bar/beat grid and bucket every pool
// note that is SOUNDING during that slot — onset inside the slot AND
// sustained notes started earlier whose tail still covers the slot.
// This matches the user's mental model of "the harmony at this beat":
// if a bass note is held from beat 1 across beat 2, it must participate
// in beat 2's chord (Satie, hymns, accompaniment patterns, etc.).
//
// "beat" → one slot per beat in the prevailing time signature.
// "bar"  → one slot per measure.
function clusterByMetric(notes, song, mode) {
  if (!notes.length) return [];
  const grid = buildMetricGrid(song, mode);
  if (!grid.length) return [];
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  // Pre-compute end times for binary-search-style filtering.
  const events = [];
  for (const slot of grid) {
    const slotStart = slot.time;
    const slotEnd   = slot.end;
    const members = [];
    for (const n of sorted) {
      const start = n.time;
      if (start >= slotEnd) break;            // sorted by start → done
      const end = start + (n.duration || 0);
      // Note participates if any portion sounds inside [slotStart, slotEnd).
      // 5 ms slack on both edges to absorb human / quantization noise.
      if (end <= slotStart + 0.005) continue;
      if (start >= slotEnd - 0.005)  continue;
      members.push(n);
    }
    if (!members.length) continue;
    const root = members.reduce((a, c) => (a.midi <= c.midi ? a : c));
    const top  = members.reduce((a, c) => (a.midi >= c.midi ? a : c));
    const meanPitch = members.reduce((s, n) => s + n.midi, 0) / members.length;
    const pcs = new Set(members.map(n => ((n.midi % 12) + 12) % 12));
    events.push({
      time: slotStart,
      members,
      isChord: pcs.size >= 2,
      root, top, meanPitch,
    });
  }
  return events;
}

// Read song.timeSignatures + header to enumerate every beat (or bar)
// boundary as { time, end }. Mirrors dataExport.js's buildGrid but
// trimmed to just the boundaries we need.
function buildMetricGrid(song, mode) {
  if (!song?.header || !song?.ppq) return [];
  const out = [];
  const header = song.header;
  const ppq = song.ppq;
  const totalDur = song.durationSec;
  const tsList = song.timeSignatures?.length
    ? song.timeSignatures
    : [{ time: 0, ticks: 0, numerator: 4, denominator: 4, measures: 0 }];
  for (let si = 0; si < tsList.length; si++) {
    const ts = tsList[si];
    const next = tsList[si + 1];
    const segStartTick = ts.ticks ?? 0;
    const segEndTick = next ? (next.ticks ?? 0) : header.secondsToTicks(totalDur);
    const ticksPerBeat = ppq * (4 / ts.denominator);
    const ticksPerMeasure = ticksPerBeat * ts.numerator;
    const measuresInSeg = Math.max(1, Math.ceil((segEndTick - segStartTick) / ticksPerMeasure));
    for (let mi = 0; mi < measuresInSeg; mi++) {
      const measureTick = segStartTick + mi * ticksPerMeasure;
      if (measureTick >= segEndTick) break;
      if (mode === "bar") {
        const t = header.ticksToSeconds(measureTick);
        if (t > totalDur + 0.001) break;
        const end = header.ticksToSeconds(measureTick + ticksPerMeasure);
        out.push({ time: t, end });
      } else {
        for (let s = 0; s < ts.numerator; s++) {
          const tk = measureTick + s * ticksPerBeat;
          if (tk > segEndTick + 1) break;
          const t = header.ticksToSeconds(tk);
          if (t > totalDur + 0.001) break;
          const end = header.ticksToSeconds(tk + ticksPerBeat);
          out.push({ time: t, end });
        }
      }
    }
  }
  return out;
}
