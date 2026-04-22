// Splits a song into voices.
//
// Non-piano tracks → one voice per track.
// Piano tracks → cluster onsets across the WHOLE track into "events"
// (a chord = simultaneous >=2 notes), then classify each event as
//   BASS    : single note, pitch < bassThreshold
//   CHORD   : >=2 notes struck together
//   MELODY  : single note, pitch >= bassThreshold
// Produce up to 3 piano voices (Bass / Chords / Melody) based on what's present.
// Only fall back to pitch-threshold hand-split if the track really has no chord
// structure at all (all events are singletons).

// Hue-spaced palette: keep neighbors at least ~80° apart so adjacent voices
// in pitch never collide visually. Two parallel tables: dark-canvas vs
// light-canvas (same hue, darker + slightly desaturated for contrast).
const COLORS = {
  flute:   "#39bdf8",   // sky-blue (high register)
  melody:  "#f59e0b",   // amber  (RH melody)
  chord:   "#a855f7",   // violet (mid chords)
  bass:    "#ef4444",   // crimson (low bass)
  other:   "#10b981",   // emerald
  rh:      "#f59e0b",
  lh:      "#ef4444",
};
const COLORS_LIGHT = {
  flute:   "#0284c7",
  melody:  "#b45309",
  chord:   "#7c3aed",
  bass:    "#b91c1c",
  other:   "#047857",
  rh:      "#b45309",
  lh:      "#b91c1c",
};
// Distinct extras for additional non-piano tracks. Spaced ~60° apart and avoid
// collisions with the primary 5 above.
const FALLBACK_COLORS = [
  "#14b8a6", // teal
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#6366f1", // indigo
  "#eab308", // yellow
];
const FALLBACK_COLORS_LIGHT = [
  "#0d9488",
  "#be185d",
  "#4d7c0f",
  "#c2410c",
  "#4338ca",
  "#a16207",
];

/**
 * @param {object} song
 * @param {number} bassThreshold  MIDI #; single-note events below go to Bass,
 *                                at-or-above go to Melody.
 * @param {{groupChords?: boolean, onsetWindow?: number}} [opts]
 *        groupChords (default true) — when true, piano tracks are split into
 *        Bass / Chords / Melody voices based on simultaneous-onset clustering.
 *        When false, every track stays as a single voice (chord events are
 *        still detected for labeling, just not split out into a separate voice).
 *        onsetWindow (default 0.045 s) — tolerance window used to cluster
 *        simultaneous onsets into chord events.
 */
export function buildVoices(song, bassThreshold = 60, opts = {}) {
  const groupChords = opts.groupChords !== false;
  const onsetWindow = typeof opts.onsetWindow === "number" ? opts.onsetWindow : 0.045;
  const voices = [];
  let colorIdx = 0;
  const fallback = () => {
    const i = colorIdx++ % FALLBACK_COLORS.length;
    return { color: FALLBACK_COLORS[i], colorLight: FALLBACK_COLORS_LIGHT[i] };
  };

  for (const track of song.tracks) {
    const pedal = track.pedal || null;
    if (track.kind === "piano") {
      if (groupChords) {
        const pianoVoices = splitPianoTrack(track, bassThreshold, onsetWindow);
        for (const v of pianoVoices) { if (pedal) v.pedal = pedal; voices.push(v); }
      } else {
        const v = makeVoice(track.name, COLORS.melody, COLORS_LIGHT.melody, track.notes, "piano", onsetWindow);
        if (pedal) v.pedal = pedal;
        voices.push(v);
      }
    } else if (track.kind === "flute") {
      const v = makeVoice(track.name, COLORS.flute, COLORS_LIGHT.flute, track.notes, "flute", onsetWindow);
      if (pedal) v.pedal = pedal;
      voices.push(v);
    } else {
      const fb = fallback();
      const v = makeVoice(track.name, fb.color, fb.colorLight, track.notes, track.kind || "other", onsetWindow);
      if (pedal) v.pedal = pedal;
      voices.push(v);
    }
  }
  return voices;
}

// ---------- chord / event detection ----------

/**
 * Cluster onsets into events. An event = set of notes that start within the
 * same small window, i.e. struck together. Size >=2 members ⇒ a chord.
 *
 * Exported so other modules (chordSource.js) can re-cluster pooled notes
 * from multiple voices using the exact same algorithm + tolerance.
 */
export function detectEvents(notes, win = 0.045) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const events = [];
  let cur = null;
  for (const n of sorted) {
    if (!cur || n.time - cur.time > win) {
      cur = { time: n.time, members: [n] };
      events.push(cur);
    } else {
      cur.members.push(n);
    }
  }
  for (const ev of events) {
    ev.members.sort((a, b) => a.midi - b.midi);
    ev.root = ev.members[0];
    ev.top = ev.members[ev.members.length - 1];
    ev.isChord = ev.members.length > 1;
    ev.meanPitch = ev.members.reduce((s, n) => s + n.midi, 0) / ev.members.length;
  }
  return events;
}

function splitPianoTrack(track, bassThreshold, onsetWindow = 0.045) {
  const events = detectEvents(track.notes, onsetWindow);
  const hasAnyChord = events.some(ev => ev.isChord);

  if (!hasAnyChord) {
    // No real chord structure → pitch-threshold hand split as last resort.
    const rh = track.notes.filter(n => n.midi >= bassThreshold);
    const lh = track.notes.filter(n => n.midi < bassThreshold);
    const out = [];
    if (rh.length) out.push(makeVoice(`${track.name} (RH)`, COLORS.rh, COLORS_LIGHT.rh, rh, "piano-melody", onsetWindow));
    if (lh.length) out.push(makeVoice(`${track.name} (LH)`, COLORS.lh, COLORS_LIGHT.lh, lh, "piano-bass", onsetWindow));
    if (!out.length) out.push(makeVoice(track.name, COLORS.other, COLORS_LIGHT.other, track.notes, "piano-melody", onsetWindow));
    return out;
  }

  const bassEvents = [];
  const chordEvents = [];
  const melodyEvents = [];

  for (const ev of events) {
    if (ev.isChord) {
      chordEvents.push(ev);
    } else {
      const pitch = ev.members[0].midi;
      if (pitch < bassThreshold) bassEvents.push(ev);
      else melodyEvents.push(ev);
    }
  }

  const out = [];
  if (bassEvents.length) {
    out.push(makeVoiceFromEvents(`${track.name} · Bass`, COLORS.bass, COLORS_LIGHT.bass, bassEvents, "piano-bass"));
  }
  if (chordEvents.length) {
    out.push(makeVoiceFromEvents(`${track.name} · Chords`, COLORS.chord, COLORS_LIGHT.chord, chordEvents, "piano-chords"));
  }
  if (melodyEvents.length) {
    out.push(makeVoiceFromEvents(`${track.name} · Melody`, COLORS.melody, COLORS_LIGHT.melody, melodyEvents, "piano-melody"));
  }
  return out;
}

function makeVoiceFromEvents(label, color, colorLight, events, kind) {
  const notes = events.flatMap(ev => ev.members);
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return {
    id: label, label, color, colorLight, kind,
    notes,
    events, // preserved clustering for rendering
    muted: false, solo: false, gainDb: 0,
  };
}

function makeVoice(label, color, colorLight, notes, kind, onsetWindow = 0.045) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const events = detectEvents(sorted, onsetWindow);
  return {
    id: label, label, color, colorLight, kind,
    notes: sorted,
    events,
    muted: false, solo: false, gainDb: 0,
  };
}
