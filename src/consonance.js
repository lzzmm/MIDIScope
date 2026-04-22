// Tonal consonance / dissonance classification for a chord.
//
// Returns 0 / 1 / 2:
//   0 = perfect consonance   — only unison/octave/P4/P5 between any pair
//                              of pitch classes (interval classes 0, 5).
//   1 = imperfect consonance — at least one m/M 3rd or 6th (IC 3 or 4),
//                              and NO dissonant interval present.
//   2 = dissonance           — at least one m2/M2/m7/M7 or tritone
//                              (IC 1, 2, or 6).
//
// Common-practice tonal theory (Aldwell/Schachter, Piston). The chord is
// reduced to its pitch-class set; we look at every pair's interval class
// (the smaller of the two distances mod 12, 0–6) and pick the worst.
// Single-note "events" return null.

export function intervalClass(pcA, pcB) {
  const d = ((pcA - pcB) % 12 + 12) % 12;
  return Math.min(d, 12 - d); // 0..6
}

const DISSONANT = new Set([1, 2, 6]); // m2/M7, M2/m7, tritone
const IMPERFECT = new Set([3, 4]);    // m3/M6, M3/m6

/**
 * @param {number[]} midis  MIDI pitches (any octave; duplicates ok).
 * @returns {0|1|2|null}
 */
export function chordConsonance(midis) {
  if (!midis || midis.length < 2) return null;
  const pcs = [...new Set(midis.map(m => ((m % 12) + 12) % 12))];
  if (pcs.length < 2) return 0; // unisons + octaves only → perfect
  let worst = 0;
  for (let i = 0; i < pcs.length; i++) {
    for (let j = i + 1; j < pcs.length; j++) {
      const ic = intervalClass(pcs[i], pcs[j]);
      if (DISSONANT.has(ic)) return 2; // can't get worse, bail early
      if (IMPERFECT.has(ic) && worst < 1) worst = 1;
    }
  }
  return worst;
}

export function consonanceLabel(rating) {
  if (rating === 0) return "perfect";
  if (rating === 1) return "imperfect";
  if (rating === 2) return "dissonant";
  return "";
}

// UI tint colors per rating, for both light- and dark-canvas themes.
// Used by both the live renderer and the PDF score export.
export const CONSONANCE_COLORS = {
  light: {
    0: { bg: "rgba(34,197,94,0.18)",  border: "#16a34a", fg: "#14532d" },
    1: { bg: "rgba(245,158,11,0.18)", border: "#d97706", fg: "#7c2d12" },
    2: { bg: "rgba(239,68,68,0.20)",  border: "#dc2626", fg: "#7f1d1d" },
  },
  dark: {
    0: { bg: "rgba(34,197,94,0.28)",  border: "#22c55e", fg: "#dcfce7" },
    1: { bg: "rgba(245,158,11,0.28)", border: "#f59e0b", fg: "#fef3c7" },
    2: { bg: "rgba(239,68,68,0.30)",  border: "#ef4444", fg: "#fee2e2" },
  },
};

// ---------- scale-degree spelling ----------
//
// `useScaleDegrees` in the CSV exporter calls these. Tonic = pitch-class of
// the song's key signature (0 = C). Mode is "major" or "minor" but for
// degree spelling we anchor to the SAME tonic in both modes — minor keys
// just naturally produce b3/b6/b7. Degrees are absolute scale degrees with
// chromatic alterations spelled as flats (e.g. b2, b3, #4, b6, b7).
const DEGREE_NAMES = ["1", "b2", "2", "b3", "3", "4", "#4", "5", "b6", "6", "b7", "7"];

export function tonicPc(keyName, mode) {
  // keyName like "C", "F#", "Bb", "Eb"; mode "major"|"minor". We don't
  // shift for minor — the user wants natural-minor degree spelling, which
  // means A in A-minor stays as 1 and C is b3 etc.
  if (typeof keyName !== "string" || !keyName.length) return 0;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[keyName[0].toUpperCase()];
  if (base == null) return 0;
  let pc = base;
  for (const c of keyName.slice(1)) {
    if (c === "#") pc = (pc + 1) % 12;
    else if (c === "b") pc = (pc + 11) % 12;
  }
  return pc;
}

export function pcToDegree(pc, tonicPcVal) {
  const d = ((pc - tonicPcVal) % 12 + 12) % 12;
  return DEGREE_NAMES[d];
}

// Convert a note-name letter ("C", "F#", "Bb", "E") to a pitch class 0..11.
// Returns null on garbage input.
export function noteNameToPc(name) {
  if (typeof name !== "string" || !name) return null;
  const m = /^([A-Ga-g])([#b]?)/.exec(name);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  if (base == null) return null;
  if (m[2] === "#") return (base + 1) % 12;
  if (m[2] === "b") return (base + 11) % 12;
  return base;
}

// ---------- degree-based consonance ----------
//
// Alternative method: rate the chord by its ROOT's diatonic scale degree
// in the prevailing key, ignoring the chord's internal interval content.
//   Degrees I, IV, V          → 0 (consonant)
//   Degrees III, VI           → 1 (mid)
//   Degrees II, VII           → 2 (dissonant)
//   Any chromatic root        → 2 (dissonant — out-of-key root)
//
// In minor mode the tonic is unchanged; the natural-minor diatonic set
// {1, 2, b3, 4, 5, b6, b7} is mapped to the same degree numbers (b3 → 3,
// b6 → 6, b7 → 7) so a typical minor-key chord stays "in scale". Anything
// truly chromatic (b2, #4, raised 7 in minor, etc.) is dissonant.
//
// `rootPc`  — pitch-class of the chord root (0..11), e.g. parsed from the
//             chord name. Pass null/undefined for single-note events.
// `tonicPcVal` — pitch-class of the song key tonic.
// `mode`    — "major" | "minor" (only affects which chromatic notes are
//             considered diatonic).
const MAJOR_DEGREE = { 0: 1, 2: 2, 4: 3, 5: 4, 7: 5, 9: 6, 11: 7 };
const MINOR_DEGREE = { 0: 1, 2: 2, 3: 3, 5: 4, 7: 5, 8: 6, 10: 7 };

export function chordConsonanceByDegree(rootPc, tonicPcVal, mode = "major") {
  if (rootPc == null || tonicPcVal == null) return null;
  const offset = ((rootPc - tonicPcVal) % 12 + 12) % 12;
  const table = (mode === "minor") ? MINOR_DEGREE : MAJOR_DEGREE;
  const deg = table[offset];
  if (deg == null) return 2;          // chromatic root → dissonant
  if (deg === 1 || deg === 4 || deg === 5) return 0;
  if (deg === 3 || deg === 6) return 1;
  return 2;                            // ii, vii
}

// Diatonic scale-degree number 1..7 for the chord root, or null if the
// root is chromatic. Useful for CSV / labels.
export function rootDegreeNumber(rootPc, tonicPcVal, mode = "major") {
  if (rootPc == null || tonicPcVal == null) return null;
  const offset = ((rootPc - tonicPcVal) % 12 + 12) % 12;
  const table = (mode === "minor") ? MINOR_DEGREE : MAJOR_DEGREE;
  return table[offset] ?? null;
}
