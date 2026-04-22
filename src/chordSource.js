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
 * @param {number} onsetWindow                 — clustering tolerance (sec).
 * @param {object} [opts]
 * @param {"interval"|"degree"} [opts.method]  — consonance algorithm.
 * @param {Array}  [opts.keyTimeline]          — segments from keyDetect; only
 *                                                used when method === "degree".
 * @returns {Array<{time, members, isChord, root, top, meanPitch,
 *                  chordName, consonance, rootPc, rootDegree, keyTonicPc, keyMode}>}
 */
export function buildChordEvents(voices, sourceIds, onsetWindow = 0.045, opts = {}) {
  if (!voices?.length || !sourceIds || !sourceIds.size) return [];
  const method      = opts.method === "interval" ? "interval" : "degree";
  const keyTimeline = Array.isArray(opts.keyTimeline) ? opts.keyTimeline : null;
  const useSustain  = !!opts.sustainOverlap;
  const pool = [];
  for (const v of voices) {
    if (!sourceIds.has(v.id)) continue;
    for (const n of v.notes) pool.push(n);
  }
  if (!pool.length) return [];
  const events = useSustain
    ? clusterBySustainOverlap(pool)
    : detectEvents(pool, onsetWindow);
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
export function defaultChordSources(voices) {
  const ids = new Set();
  if (!voices?.length) return ids;
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
