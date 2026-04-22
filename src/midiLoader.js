// Loads & normalizes MIDI files using @tonejs/midi.
import { Midi } from "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm";

const PIANO_KEYWORDS = ["piano", "klavier", "keyboard", "rhodes"];
const FLUTE_KEYWORDS = ["flute", "flöte", "flauto", "piccolo"];

function classifyInstrument(track) {
  const name = (track.name || "").toLowerCase();
  const fam = (track.instrument && track.instrument.family || "").toLowerCase();
  const inst = (track.instrument && track.instrument.name || "").toLowerCase();
  const blob = `${name} ${fam} ${inst}`;
  if (FLUTE_KEYWORDS.some(k => blob.includes(k))) return "flute";
  if (PIANO_KEYWORDS.some(k => blob.includes(k))) return "piano";
  if (fam === "piano") return "piano";
  if (fam === "pipe") return "flute";
  return "other";
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
        kind: classifyInstrument(t),
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
