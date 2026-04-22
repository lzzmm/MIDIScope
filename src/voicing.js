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
// in pitch never collide visually.
const COLORS = {
  flute:   "#39bdf8",   // sky-blue (high register)
  melody:  "#f59e0b",   // amber  (RH melody)
  chord:   "#a855f7",   // violet (mid chords)
  bass:    "#ef4444",   // crimson (low bass)
  other:   "#10b981",   // emerald
  rh:      "#f59e0b",
  lh:      "#ef4444",
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

/**
 * @param {object} song
 * @param {number} bassThreshold  MIDI #; single-note events below go to Bass,
 *                                at-or-above go to Melody.
 */
export function buildVoices(song, bassThreshold = 60) {
  const voices = [];
  let colorIdx = 0;
  const fallback = () => FALLBACK_COLORS[colorIdx++ % FALLBACK_COLORS.length];

  for (const track of song.tracks) {
    if (track.kind === "piano") {
      const pianoVoices = splitPianoTrack(track, bassThreshold);
      for (const v of pianoVoices) voices.push(v);
    } else if (track.kind === "flute") {
      voices.push(makeVoice(track.name, COLORS.flute, track.notes, "flute"));
    } else {
      voices.push(makeVoice(track.name, fallback(), track.notes, "other"));
    }
  }
  return voices;
}

// ---------- chord / event detection ----------

/**
 * Cluster onsets into events. An event = set of notes that start within the
 * same small window, i.e. struck together. Size >=2 members ⇒ a chord.
 */
function detectEvents(notes) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const events = [];
  let cur = null;
  const win = 0.045; // 45 ms onset tolerance
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

function splitPianoTrack(track, bassThreshold) {
  const events = detectEvents(track.notes);
  const hasAnyChord = events.some(ev => ev.isChord);

  if (!hasAnyChord) {
    // No real chord structure → pitch-threshold hand split as last resort.
    const rh = track.notes.filter(n => n.midi >= bassThreshold);
    const lh = track.notes.filter(n => n.midi < bassThreshold);
    const out = [];
    if (rh.length) out.push(makeVoice(`${track.name} (RH)`, COLORS.rh, rh, "piano-melody"));
    if (lh.length) out.push(makeVoice(`${track.name} (LH)`, COLORS.lh, lh, "piano-bass"));
    if (!out.length) out.push(makeVoice(track.name, COLORS.other, track.notes, "piano-melody"));
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
    out.push(makeVoiceFromEvents(`${track.name} · Bass`, COLORS.bass, bassEvents, "piano-bass"));
  }
  if (chordEvents.length) {
    out.push(makeVoiceFromEvents(`${track.name} · Chords`, COLORS.chord, chordEvents, "piano-chords"));
  }
  if (melodyEvents.length) {
    out.push(makeVoiceFromEvents(`${track.name} · Melody`, COLORS.melody, melodyEvents, "piano-melody"));
  }
  return out;
}

function makeVoiceFromEvents(label, color, events, kind) {
  const notes = events.flatMap(ev => ev.members);
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return {
    id: label, label, color, kind,
    notes,
    events, // preserved clustering for rendering
    muted: false, solo: false, gainDb: 0,
  };
}

function makeVoice(label, color, notes, kind) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const events = detectEvents(sorted);
  return {
    id: label, label, color, kind,
    notes: sorted,
    events,
    muted: false, solo: false, gainDb: 0,
  };
}
