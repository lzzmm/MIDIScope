// Tone.js based playback. Sampled realistic piano/flute with synth fallback.
import * as Tone from "https://cdn.jsdelivr.net/npm/tone@14.8.49/+esm";

const PIANO_BASE = "https://tonejs.github.io/audio/salamander/";
const PIANO_MAP = {
  "A0": "A0.mp3",
  "C1": "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3", "A1": "A1.mp3",
  "C2": "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3", "A2": "A2.mp3",
  "C3": "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3", "A3": "A3.mp3",
  "C4": "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3", "A4": "A4.mp3",
  "C5": "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3", "A5": "A5.mp3",
  "C6": "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3", "A6": "A6.mp3",
  "C7": "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3", "A7": "A7.mp3",
  "C8": "C8.mp3",
};
const FLUTE_BASE = "https://nbrosowsky.github.io/tonejs-instruments/samples/flute/";
const FLUTE_MAP = {
  "A4": "A4.mp3", "C4": "C4.mp3", "C5": "C5.mp3", "C6": "C6.mp3",
  "E4": "E4.mp3", "E5": "E5.mp3", "E6": "E6.mp3",
  "A5": "A5.mp3", "A6": "A6.mp3",
};
const NB_BASE = "https://nbrosowsky.github.io/tonejs-instruments/samples/";
const STRINGS_MAP = {
  "A3": "A3.mp3", "A4": "A4.mp3", "A5": "A5.mp3",
  "C4": "C4.mp3", "C5": "C5.mp3",
  "E3": "E3.mp3", "E4": "E4.mp3", "E5": "E5.mp3",
  "G3": "G3.mp3", "G4": "G4.mp3",
};
const EPIANO_MAP = {
  "A2": "A2.mp3", "A3": "A3.mp3", "A4": "A4.mp3", "A5": "A5.mp3",
  "C3": "C3.mp3", "C4": "C4.mp3", "C5": "C5.mp3",
};
const GUITAR_MAP = {
  "A2": "A2.mp3", "A3": "A3.mp3", "A4": "A4.mp3",
  "C3": "C3.mp3", "C4": "C4.mp3", "C5": "C5.mp3",
  "E2": "E2.mp3", "E3": "E3.mp3", "E4": "E4.mp3",
};
const BASS_MAP = {
  "A1": "A1.mp3", "A2": "A2.mp3", "A3": "A3.mp3",
  "C2": "C2.mp3", "C3": "C3.mp3",
  "E1": "E1.mp3", "E2": "E2.mp3",
};

const samplerCache = new Map();      // kind → Promise<Tone.Sampler> (template, only used for buffer warmup)
const bufferCache = new Map();       // kind → Promise<{noteName: ToneAudioBuffer}>
const loadProgress = { active: new Set(), done: new Set() };

// Map a voice kind to the underlying sampler bank kind, or null if the
// kind has no sampled instrument (the voice stays on its synth fallback).
function voiceKindToSampler(kind) {
  switch (kind) {
    case "flute":   return "flute";
    case "strings": return "strings";
    case "guitar":  return "guitar";
    case "bass":    return "bass";
    case "epiano":  return "epiano";
    case "piano":
    case "piano-bass":
    case "piano-chords":
    case "piano-melody":
      return "piano";
    // Everything else (brass, reed, organ, mallet, timpani, pad, lead,
    // perc, drums, ethnic, fx, other) has no sampled bank yet — keep
    // the voice on the dedicated synth instead of forcing a piano.
    default: return null;
  }
}

function samplerConfig(kind) {
  switch (kind) {
    case "flute":   return { urls: FLUTE_MAP, baseUrl: FLUTE_BASE, release: 0.8, attack: 0.02 };
    case "strings": return { urls: STRINGS_MAP, baseUrl: NB_BASE + "violin/", release: 1.4, attack: 0.06 };
    case "epiano":  return { urls: EPIANO_MAP, baseUrl: NB_BASE + "electric-piano/", release: 1.2 };
    case "guitar":  return { urls: GUITAR_MAP, baseUrl: NB_BASE + "guitar-acoustic/", release: 0.9 };
    case "bass":    return { urls: BASS_MAP, baseUrl: NB_BASE + "bass-electric/", release: 1.0 };
    case "piano":
    default:        return { urls: PIANO_MAP, baseUrl: PIANO_BASE, release: 1.2 };
  }
}

// Load and decode all sample buffers for `kind` exactly once. Returns a
// promise of `{noteName: ToneAudioBuffer}` ready to be passed to a fresh
// Tone.Sampler. We share buffers (not Sampler instances!) across voices
// so each voice gets its own routing node — fixing the mute/solo bug
// where N piano voices used to share one Sampler routed to one gain.
function loadBuffers(kind, onProgress) {
  if (bufferCache.has(kind)) return bufferCache.get(kind);
  const cfg = samplerConfig(kind);
  loadProgress.active.add(kind);
  if (onProgress) onProgress();
  const entries = Object.entries(cfg.urls);
  const out = {};
  let remaining = entries.length;
  let settled = false;
  const p = new Promise((resolve, reject) => {
    if (entries.length === 0) { resolve(out); return; }
    for (const [note, file] of entries) {
      const url = cfg.baseUrl + file;
      const buf = new Tone.ToneAudioBuffer(
        url,
        () => {
          if (settled) return;
          out[note] = buf;
          if (--remaining === 0) {
            settled = true;
            loadProgress.active.delete(kind);
            loadProgress.done.add(kind);
            if (onProgress) onProgress();
            resolve(out);
          }
        },
        (err) => {
          if (settled) return;
          settled = true;
          loadProgress.active.delete(kind);
          if (onProgress) onProgress();
          reject(err);
        }
      );
    }
  });
  bufferCache.set(kind, p);
  return p;
}

// Build a brand-new Sampler for one voice using the cached, shared buffers.
async function makeSamplerFor(kind, onProgress) {
  const buffers = await loadBuffers(kind, onProgress);
  const cfg = samplerConfig(kind);
  return new Tone.Sampler({
    urls: buffers,
    release: cfg.release,
    attack: cfg.attack || 0,
  });
}

export class Player {
  constructor() {
    this.voices = [];
    this.parts = [];
    this.synths = [];
    this.gains = [];
    this.master = new Tone.Gain(Tone.dbToGain(-6));
    this.reverb = new Tone.Reverb({ decay: 2.4, wet: 0.25, preDelay: 0.02 });
    this.reverb.generate();
    // master → reverb (with built-in wet/dry) → destination
    this.master.connect(this.reverb);
    this.reverb.toDestination();
    this.duration = 0;
    this._speed = 1;
    this.timbre = "realistic";
    this.onStatus = null;
  }

  async ensureStarted() {
    if (Tone.context.state !== "running") await Tone.start();
  }

  setMasterDb(db) { this.master.gain.rampTo(Tone.dbToGain(db), 0.05); }
  setSpeed(s) {
    this._speed = s;
    Tone.Transport.bpm.value = 120 * s;
  }
  setReverbWet(w) { this.reverb.wet.rampTo(Math.max(0, Math.min(1, w)), 0.1); }
  setTimbre(t) { this.timbre = t; }
  setStatus(msg) { if (this.onStatus) this.onStatus(msg); }

  async load(voices, durationSec) {
    this.dispose();
    this.voices = voices;
    this.duration = durationSec;
    Tone.Transport.bpm.value = 120 * this._speed;

    // Start with synth fallback nodes so playback is instant.
    voices.forEach((v) => {
      const gain = new Tone.Gain(Tone.dbToGain(v.gainDb || 0)).connect(this.master);
      const synth = makeSynth(v.kind);
      synth.connect(gain);
      this.gains.push(gain);
      this.synths.push(synth);
    });

    // Schedule parts; reference this.synths[i] lazily so upgrade swap works.
    // Note: mute/solo is enforced by the per-voice gain node (applyVoiceState),
    // NOT by skipping triggers here. That way the audio is gated cleanly and
    // un-muting mid-note doesn't drop the rest of the held note.
    voices.forEach((v, i) => {
      const events = v.notes.map(n => ({ time: n.time, midi: n.midi, dur: n.duration, vel: n.velocity || 0.7 }));
      const part = new Tone.Part((time, ev) => {
        const node = this.synths[i];
        if (!node) return;
        try {
          const freq = Tone.Frequency(ev.midi, "midi").toFrequency();
          node.triggerAttackRelease(freq, Math.max(0.05, ev.dur), time, ev.vel);
        } catch (_) { /* ignore overlaps */ }
      }, events);
      part.start(0);
      this.parts.push(part);
    });

    Tone.Transport.loop = false;
    Tone.Transport.seconds = 0;

    // Apply current mute/solo state to the freshly-built gain nodes.
    this.applyVoiceState();

    if (this.timbre === "realistic") {
      this._upgradeToSamplers(voices).catch((err) => {
        console.warn("sample load failed, staying on synth", err);
        this.setStatus("Samples unavailable — using synth fallback.");
      });
    }
  }

  async _upgradeToSamplers(voices) {
    const upgradeKinds = voices
      .map(v => voiceKindToSampler(v.kind))
      .filter(k => k !== null);
    if (upgradeKinds.length === 0) {
      this.setStatus("Synth voices ready (no sampled bank for these instruments).");
      return;
    }
    const updateBanner = () => {
      const active = [...loadProgress.active];
      if (active.length === 0) return;
      this.setStatus(`Loading instrument samples (${active.join(", ")})…`);
    };
    updateBanner();
    await Promise.all(voices.map(async (v, i) => {
      const kind = voiceKindToSampler(v.kind);
      if (!kind) return; // keep synth fallback for this voice
      try {
        // Each voice gets its OWN Sampler instance (built from shared
        // buffers). This is critical: with a single shared Sampler, all
        // voices of the same kind would route through one gain node,
        // making mute/solo affect every voice of that kind together.
        const sampler = await makeSamplerFor(kind, updateBanner);
        if (this.voices[i] !== v) {
          try { sampler.dispose(); } catch (_) {}
          return;
        }
        sampler.connect(this.gains[i]);
        const old = this.synths[i];
        this.synths[i] = sampler;
        if (old) {
          try { old.disconnect(); } catch (_) {}
          try { old.dispose(); } catch (_) {}
        }
      } catch (err) {
        console.warn(`sampler for ${v.label} failed`, err);
      }
    }));
    const uniq = [...new Set(upgradeKinds)];
    if (uniq.length === 1) {
      this.setStatus(`Realistic ${uniq[0]} samples loaded.`);
    } else {
      this.setStatus(`Realistic samples loaded (${uniq.join(", ")}).`);
    }
  }

  applyVoiceState() {
    const anySolo = this.voices.some(v => v.solo);
    this.voices.forEach((v, i) => {
      const g = this.gains[i];
      if (!g) return;
      const effectiveMute = v.muted || (anySolo && !v.solo);
      g.gain.rampTo(effectiveMute ? 0 : Tone.dbToGain(v.gainDb || 0), 0.05);
    });
  }

  async play() { await this.ensureStarted(); Tone.Transport.start(); }
  pause()      { Tone.Transport.pause(); }
  stop()       { Tone.Transport.stop(); Tone.Transport.seconds = 0; }
  seek(sec)    { Tone.Transport.seconds = Math.max(0, Math.min(this.duration, sec)); }
  getTime()    { return Tone.Transport.seconds; }
  isPlaying()  { return Tone.Transport.state === "started"; }

  dispose() {
    this.parts.forEach(p => { try { p.dispose(); } catch (_) {} });
    this.synths.forEach(s => {
      try { s.disconnect(); } catch (_) {}
      try { s.dispose(); } catch (_) {}
    });
    this.gains.forEach(g => { try { g.dispose(); } catch (_) {} });
    this.parts = []; this.synths = []; this.gains = [];
  }
}

function makeSynth(kind) {
  if (kind === "flute") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.06, decay: 0.1, sustain: 0.7, release: 0.25 },
    });
  }
  if (kind === "strings") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.25, decay: 0.2, sustain: 0.85, release: 0.6 },
    });
  }
  if (kind === "guitar") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.4, sustain: 0.0, release: 0.6 },
    });
  }
  if (kind === "bass") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fmsine", modulationType: "sine", modulationIndex: 1 },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.4 },
    });
  }
  if (kind === "epiano") {
    return new Tone.PolySynth(Tone.FMSynth, {
      modulationIndex: 6,
      envelope: { attack: 0.005, decay: 1.0, sustain: 0.0, release: 1.0 },
      modulationEnvelope: { attack: 0.005, decay: 0.6, sustain: 0.0, release: 0.5 },
    });
  }
  if (kind === "piano-bass" || kind === "piano-chords" || kind === "piano-melody" || kind === "piano") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fmsine", modulationType: "sine", modulationIndex: 2 },
      envelope: { attack: 0.005, decay: 0.6, sustain: 0.0, release: 0.8 },
    });
  }
  if (kind === "timpani") {
    // Big tuned drum: short pitched thump, long resonant tail.
    return new Tone.PolySynth(Tone.MembraneSynth, {
      pitchDecay: 0.12,
      octaves: 4,
      envelope: { attack: 0.001, decay: 0.6, sustain: 0.01, release: 1.6 },
    });
  }
  if (kind === "drums") {
    // Generic drum-kit fallback: punchy membrane voice. Pitched-percussion
    // events on GM channel 10 don't really map to musical pitch, but this
    // at least produces an audible hit per note.
    return new Tone.PolySynth(Tone.MembraneSynth, {
      pitchDecay: 0.04,
      octaves: 6,
      envelope: { attack: 0.001, decay: 0.25, sustain: 0.0, release: 0.3 },
    });
  }
  if (kind === "brass") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.08, decay: 0.15, sustain: 0.8, release: 0.3 },
    });
  }
  if (kind === "reed") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "square" },
      envelope: { attack: 0.05, decay: 0.1, sustain: 0.75, release: 0.3 },
    });
  }
  if (kind === "organ") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsine", count: 3, spread: 12 },
      envelope: { attack: 0.01, decay: 0.0, sustain: 1.0, release: 0.2 },
    });
  }
  if (kind === "mallet") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.4, sustain: 0.0, release: 0.4 },
    });
  }
  if (kind === "choir") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.4, decay: 0.2, sustain: 0.85, release: 0.8 },
    });
  }
  if (kind === "pad") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 3, spread: 18 },
      envelope: { attack: 0.6, decay: 0.4, sustain: 0.8, release: 1.2 },
    });
  }
  if (kind === "synth-lead") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.2 },
    });
  }
  if (kind === "perc") {
    return new Tone.PolySynth(Tone.MembraneSynth, {
      pitchDecay: 0.05,
      octaves: 5,
      envelope: { attack: 0.001, decay: 0.2, sustain: 0.0, release: 0.2 },
    });
  }
  if (kind === "ethnic" || kind === "fx") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.5 },
    });
  }
  return new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 },
  });
}
