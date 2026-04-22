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

const samplerCache = new Map();

function getSampler(kind) {
  if (samplerCache.has(kind)) return samplerCache.get(kind);
  const cfg = kind === "flute"
    ? { urls: FLUTE_MAP, baseUrl: FLUTE_BASE, release: 0.8, attack: 0.02 }
    : { urls: PIANO_MAP, baseUrl: PIANO_BASE, release: 1.2 };
  const p = new Promise((resolve, reject) => {
    const s = new Tone.Sampler({
      ...cfg,
      onload: () => resolve(s),
      onerror: (err) => reject(err),
    });
  });
  samplerCache.set(kind, p);
  return p;
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
    voices.forEach((v, i) => {
      const events = v.notes.map(n => ({ time: n.time, midi: n.midi, dur: n.duration, vel: n.velocity || 0.7 }));
      const part = new Tone.Part((time, ev) => {
        if (v.muted) return;
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

    if (this.timbre === "realistic") {
      this._upgradeToSamplers(voices).catch((err) => {
        console.warn("sample load failed, staying on synth", err);
        this.setStatus("Samples unavailable — using synth fallback.");
      });
    }
  }

  async _upgradeToSamplers(voices) {
    this.setStatus("Loading instrument samples…");
    await Promise.all(voices.map(async (v, i) => {
      try {
        const kind = v.kind === "flute" ? "flute" : "piano";
        const sampler = await getSampler(kind);
        if (this.voices[i] !== v) return;
        // Disconnect sampler from previous routing, then connect to this voice's gain.
        try { sampler.disconnect(); } catch (_) {}
        sampler.connect(this.gains[i]);
        const old = this.synths[i];
        this.synths[i] = sampler;
        if (old && !(old instanceof Tone.Sampler)) {
          try { old.disconnect(); } catch (_) {}
          try { old.dispose(); } catch (_) {}
        }
      } catch (err) {
        console.warn(`sampler for ${v.label} failed`, err);
      }
    }));
    this.setStatus("Realistic samples loaded.");
  }

  applyVoiceState() {
    const anySolo = this.voices.some(v => v.solo);
    this.voices.forEach((v, i) => {
      const effectiveMute = v.muted || (anySolo && !v.solo);
      this.gains[i].gain.rampTo(effectiveMute ? 0 : Tone.dbToGain(v.gainDb || 0), 0.05);
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
      if (!(s instanceof Tone.Sampler)) { try { s.dispose(); } catch (_) {} }
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
  if (kind === "piano-bass" || kind === "piano-chords" || kind === "piano-melody" || kind === "piano") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fmsine", modulationType: "sine", modulationIndex: 2 },
      envelope: { attack: 0.005, decay: 0.6, sustain: 0.0, release: 0.8 },
    });
  }
  return new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 },
  });
}
