// Tiny pitch-class chord namer. Detects common triads & 7ths.
// Returns e.g. "Am", "G7", "F#dim", or null.

const PCS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// quality patterns by interval set (relative to root, normalized & sorted)
const PATTERNS = [
  { name: "",       ivals: [0,4,7] },        // major triad
  { name: "m",      ivals: [0,3,7] },        // minor triad
  { name: "dim",    ivals: [0,3,6] },
  { name: "aug",    ivals: [0,4,8] },
  { name: "sus4",   ivals: [0,5,7] },
  { name: "sus2",   ivals: [0,2,7] },
  { name: "7",      ivals: [0,4,7,10] },
  { name: "maj7",   ivals: [0,4,7,11] },
  { name: "m7",     ivals: [0,3,7,10] },
  { name: "mMaj7",  ivals: [0,3,7,11] },
  { name: "dim7",   ivals: [0,3,6,9] },
  { name: "m7b5",   ivals: [0,3,6,10] },
  { name: "6",      ivals: [0,4,7,9] },
  { name: "m6",     ivals: [0,3,7,9] },
  { name: "add9",   ivals: [0,2,4,7] },
  { name: "madd9",  ivals: [0,2,3,7] },
  // 9th chords. We list these BEFORE the 7sus voicings because a chord
  // like {1, 2, 5, b7} is more idiomatically read as "9 (no 3)" than
  // "7sus2" in tonal contexts (Satie's Gymnopédie etc.). Both the
  // full 5-note voicing and the "no-5" / "no-3" 4-note voicings are
  // included — the 5th and 3rd are the tones most often dropped.
  { name: "9",      ivals: [0,2,4,7,10] },
  { name: "9",      ivals: [0,2,4,10] },     // no 5
  { name: "9",      ivals: [0,2,7,10] },     // no 3
  { name: "maj9",   ivals: [0,2,4,7,11] },
  { name: "maj9",   ivals: [0,2,4,11] },     // no 5
  { name: "maj9",   ivals: [0,2,7,11] },     // no 3
  { name: "m9",     ivals: [0,2,3,7,10] },
  { name: "m9",     ivals: [0,2,3,10] },     // no 5
  { name: "6/9",    ivals: [0,2,4,7,9] },
  // 7sus voicings (now reachable only for material that doesn't fit a
  // 9-chord reading, e.g. {1, 4, 5, b7} for sus4).
  { name: "7sus2",  ivals: [0,2,7,10] },
  { name: "7sus4",  ivals: [0,5,7,10] },
  // 11th chords (typically omit 3 — the natural 11 clashes with the
  // major 3rd; the m11 keeps both because b3 + 11 is a perfect 4th).
  { name: "11",     ivals: [0,2,5,7,10] },   // no 3
  { name: "m11",    ivals: [0,2,3,5,7,10] },
  { name: "maj11",  ivals: [0,2,4,5,7,11] }, // rare, for completeness
  { name: "5",      ivals: [0,7] },          // power chord / open fifth
];

function setEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {number[]} midis  pitch numbers (any octave)
 * @returns {string|null}   e.g. "Am7" or "Am7/C"
 */
export function nameChord(midis) {
  if (!midis || midis.length < 2) return null;
  const pcs = [...new Set(midis.map(m => ((m % 12) + 12) % 12))].sort((a,b)=>a-b);
  const bass = ((Math.min(...midis) % 12) + 12) % 12;

  // try each pc as root
  let best = null;
  for (const root of pcs) {
    const ivals = pcs.map(p => ((p - root + 12) % 12)).sort((a,b)=>a-b);
    for (const pat of PATTERNS) {
      if (setEq(ivals, pat.ivals)) {
        // prefer matches whose root is the bass (root position) over inversions
        const score = (root === bass ? 0 : 1) + (PATTERNS.indexOf(pat) * 0.001);
        if (!best || score < best.score) {
          best = { name: PCS[root] + pat.name, root, score };
        }
      }
    }
  }
  if (!best) return null;
  if (best.root !== bass) return `${best.name}/${PCS[bass]}`;
  return best.name;
}
