// Loads & normalizes MIDI files using @tonejs/midi.
import { Midi } from "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm";

const PIANO_KEYWORDS = ["piano", "klavier", "keyboard"];
const EPIANO_KEYWORDS = ["rhodes", "epiano", "electric piano", "wurlitzer"];
const FLUTE_KEYWORDS = ["flute", "flöte", "flauto", "piccolo"];
const GUITAR_KEYWORDS = ["guitar", "gtr", "git."];
const BASS_KEYWORDS = ["bass"];
const STRINGS_KEYWORDS = ["violin", "viola", "cello", "contrabass", "strings", "string ensemble"];

function classifyInstrument(track) {
  const name = (track.name || "").toLowerCase();
  const fam = (track.instrument && track.instrument.family || "").toLowerCase();
  const inst = (track.instrument && track.instrument.name || "").toLowerCase();
  const num = (track.instrument && typeof track.instrument.number === "number") ? track.instrument.number : -1;
  const blob = `${name} ${fam} ${inst}`;

  // Keyword sweeps first (most specific names win).
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

  // GM program number fallback (0-127).
  if (num >= 0) {
    if (num <= 5) return "piano";
    if (num <= 7) return "epiano";          // GM 6=Harpsichord, 7=Clav — closest to e-piano sample bank
    if (num >= 24 && num <= 31) return "guitar";
    if (num >= 32 && num <= 39) return "bass";
    if (num >= 40 && num <= 51) return "strings";
    if (num >= 73 && num <= 79) return "flute";
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
