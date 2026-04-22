// Tiny pitch-class chord namer. Detects common triads & 7ths.
// Returns e.g. "Am", "G7", "F#dim", or null.

const PCS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// quality patterns by interval set (relative to root, normalized & sorted)
const PATTERNS = [
  { name: "",      ivals: [0,4,7] },     // major
  { name: "m",     ivals: [0,3,7] },     // minor
  { name: "dim",   ivals: [0,3,6] },
  { name: "aug",   ivals: [0,4,8] },
  { name: "sus4",  ivals: [0,5,7] },
  { name: "sus2",  ivals: [0,2,7] },
  { name: "7",     ivals: [0,4,7,10] },
  { name: "maj7",  ivals: [0,4,7,11] },
  { name: "m7",    ivals: [0,3,7,10] },
  { name: "mMaj7", ivals: [0,3,7,11] },
  { name: "dim7",  ivals: [0,3,6,9] },
  { name: "m7b5",  ivals: [0,3,6,10] },
  { name: "6",     ivals: [0,4,7,9] },
  { name: "m6",    ivals: [0,3,7,9] },
  { name: "add9",  ivals: [0,2,4,7] },
  { name: "5",     ivals: [0,7] },       // power chord / open fifth
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
