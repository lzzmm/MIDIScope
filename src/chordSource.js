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
import { chordConsonance } from "./consonance.js";

/**
 * @param {Array} voices                       — current voice list
 * @param {Set<string>|null} sourceIds         — voice.id of selected voices.
 *                                                When null/empty, returns [].
 * @param {number} onsetWindow                 — clustering tolerance (sec).
 * @returns {Array<{time, members, isChord, root, top, meanPitch,
 *                  chordName, consonance}>}
 */
export function buildChordEvents(voices, sourceIds, onsetWindow = 0.045) {
  if (!voices?.length || !sourceIds || !sourceIds.size) return [];
  const pool = [];
  for (const v of voices) {
    if (!sourceIds.has(v.id)) continue;
    for (const n of v.notes) pool.push(n);
  }
  if (!pool.length) return [];
  const events = detectEvents(pool, onsetWindow);
  for (const ev of events) {
    if (ev.isChord) {
      ev.chordName = nameChord(ev.members.map(m => m.midi));
      ev.consonance = chordConsonance(ev.members.map(m => m.midi));
    } else {
      ev.chordName = null;
      ev.consonance = null;
    }
  }
  return events;
}

/**
 * Compute the default chord-source selection for a freshly-loaded song:
 *   - if any voice has kind "piano-chords", pick exactly those;
 *   - else if any voice's kind starts with "piano", pick all of them;
 *   - else empty (user must opt in).
 *
 * Returns a Set<voice.id>.
 */
export function defaultChordSources(voices) {
  const ids = new Set();
  if (!voices?.length) return ids;
  const chordVoices = voices.filter(v => v.kind === "piano-chords");
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
