// Loads & normalizes MIDI files using @tonejs/midi.
import { Midi } from "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm";

const PIANO_KEYWORDS = ["piano", "klavier", "keyboard"];
const EPIANO_KEYWORDS = ["rhodes", "epiano", "electric piano", "wurlitzer"];
const FLUTE_KEYWORDS = ["flute", "flöte", "flauto", "piccolo", "recorder"];
const GUITAR_KEYWORDS = ["guitar", "gtr", "git."];
const BASS_KEYWORDS = ["bass"];
const STRINGS_KEYWORDS = ["violin", "viola", "cello", "contrabass", "strings", "string ensemble"];
const TIMPANI_KEYWORDS = ["timpani", "timp", "tympani", "kettle"];
const DRUM_KEYWORDS = ["drum", "kit", "perc kit", "percussion kit"];
const BRASS_KEYWORDS = ["trumpet", "trombone", "tuba", "horn", "brass", "cornet", "flugel"];
const REED_KEYWORDS = ["sax", "saxophone", "oboe", "clarinet", "bassoon", "english horn", "cor anglais"];
const ORGAN_KEYWORDS = ["organ", "harmonium", "accordion", "harmonica"];
const MALLET_KEYWORDS = ["marimba", "xylophone", "vibraphone", "vibes", "glockenspiel", "celesta", "celeste", "tubular", "music box", "kalimba"];
const CHOIR_KEYWORDS = ["choir", "voice", "vocal", "aahs", "oohs"];
const HARP_KEYWORDS = ["harp"];

function classifyInstrument(track) {
  const name = (track.name || "").toLowerCase();
  const fam = (track.instrument && track.instrument.family || "").toLowerCase();
  const inst = (track.instrument && track.instrument.name || "").toLowerCase();
  const num = (track.instrument && typeof track.instrument.number === "number") ? track.instrument.number : -1;
  const ch = typeof track.channel === "number" ? track.channel : -1;
  const blob = `${name} ${fam} ${inst}`;

  // GM channel 10 (zero-indexed = 9) is the standard drum kit channel.
  if (ch === 9) return "drums";
  if (DRUM_KEYWORDS.some(k => blob.includes(k))) return "drums";

  // Specific instrument keywords (most specific names win).
  if (TIMPANI_KEYWORDS.some(k => blob.includes(k))) return "timpani";
  if (MALLET_KEYWORDS.some(k => blob.includes(k))) return "mallet";
  if (HARP_KEYWORDS.some(k => blob.includes(k))) return "strings";
  if (CHOIR_KEYWORDS.some(k => blob.includes(k))) return "choir";
  if (ORGAN_KEYWORDS.some(k => blob.includes(k))) return "organ";
  if (BRASS_KEYWORDS.some(k => blob.includes(k))) return "brass";
  if (REED_KEYWORDS.some(k => blob.includes(k))) return "reed";
  if (FLUTE_KEYWORDS.some(k => blob.includes(k))) return "flute";
  if (EPIANO_KEYWORDS.some(k => blob.includes(k))) return "epiano";
  if (BASS_KEYWORDS.some(k => blob.includes(k))) return "bass";
  if (GUITAR_KEYWORDS.some(k => blob.includes(k))) return "guitar";
  if (STRINGS_KEYWORDS.some(k => blob.includes(k))) return "strings";
  if (PIANO_KEYWORDS.some(k => blob.includes(k))) return "piano";

  // Family hints.
  if (fam === "pipe") return "flute";
  if (fam === "guitar") return "guitar";
  if (fam === "bass") return "bass";
  if (fam === "strings" || fam === "ensemble") return "strings";
  if (fam === "piano") return "piano";
  if (fam === "organ") return "organ";
  if (fam === "brass") return "brass";
  if (fam === "reed") return "reed";
  if (fam === "chromatic percussion") return "mallet";
  if (fam === "percussive" || fam === "drums") return "drums";
  if (fam === "synth lead") return "synth-lead";
  if (fam === "synth pad") return "pad";
  if (fam === "synth effects" || fam === "sound effects") return "fx";
  if (fam === "ethnic") return "ethnic";

  // GM program number fallback (0-127).
  if (num >= 0) {
    if (num <= 5)                  return "piano";       // 0-5 acoustic/electric grand etc.
    if (num <= 7)                  return "epiano";      // 6 harpsichord, 7 clav
    if (num >= 8 && num <= 15)     return "mallet";      // chromatic percussion
    if (num >= 16 && num <= 23)    return "organ";
    if (num >= 24 && num <= 31)    return "guitar";
    if (num >= 32 && num <= 39)    return "bass";
    if (num === 47)                return "timpani";     // GM 47 = Timpani
    if (num >= 40 && num <= 46)    return "strings";     // violin..harp
    if (num >= 48 && num <= 51)    return "strings";     // ensemble strings
    if (num >= 52 && num <= 54)    return "choir";       // choir aahs/oohs/synth voice
    if (num >= 56 && num <= 63)    return "brass";
    if (num >= 64 && num <= 71)    return "reed";
    if (num >= 72 && num <= 79)    return "flute";       // pipe family
    if (num >= 80 && num <= 87)    return "synth-lead";
    if (num >= 88 && num <= 95)    return "pad";
    if (num >= 96 && num <= 103)   return "fx";
    if (num >= 104 && num <= 111)  return "ethnic";
    if (num >= 112 && num <= 119)  return "perc";
    if (num >= 120 && num <= 127)  return "fx";
  }
  return "other";
}

// Extract sustain pedal (CC64) events for a track. Returns a sorted
// array of {time, value} or null when the controller is absent.
function extractPedal(track) {
  const cc = track.controlChanges;
  if (!cc) return null;
  const arr = cc["64"] || cc[64];
  if (!arr || !arr.length) return null;
  return arr
    .map(e => ({ time: e.time, value: typeof e.value === "number" && e.value <= 1 ? Math.round(e.value * 127) : (e.value ?? 0) }))
    .sort((a, b) => a.time - b.time);
}

export async function loadMidiFromArrayBuffer(buf) {
  const midi = new Midi(buf);
  const tracks = midi.tracks
    .filter(t => t.notes.length > 0)
    .map((t, i) => {
      const channels = new Set(t.notes.map(n => n.channel ?? 0));
      return {
        index: i,
        name: t.name || `Track ${i + 1}`,
        channel: t.channel,
        channels: [...channels],
        instrumentName: t.instrument?.name ?? "",
        instrumentFamily: t.instrument?.family ?? "",
        instrumentNumber: typeof t.instrument?.number === "number" ? t.instrument.number : -1,
        kind: classifyInstrument(t),
        pedal: extractPedal(t),
        notes: t.notes.map(n => ({
          midi: n.midi,
          time: n.time,
          duration: Math.max(0.02, n.duration),
          velocity: n.velocity,
          channel: n.channel ?? 0,
        })),
      };
    });

  return {
    name: midi.name || "untitled",
    ppq: midi.header.ppq,
    durationSec: midi.duration,
    tempos: midi.header.tempos.map(t => ({ time: t.time, bpm: t.bpm })),
    timeSignatures: midi.header.timeSignatures.map(ts => ({
      time: ts.ticks ? midi.header.ticksToSeconds(ts.ticks) : 0,
      ticks: ts.ticks,
      measures: ts.measures,
      numerator: ts.timeSignature[0],
      denominator: ts.timeSignature[1],
    })),
    header: midi.header, // keep for tick<->second conversions
    tracks,
  };
}

export async function loadMidiFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return loadMidiFromArrayBuffer(buf);
}

export async function loadMidiFromFile(file) {
  const buf = await file.arrayBuffer();
  return loadMidiFromArrayBuffer(buf);
}
