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

// Triad / 7th templates the fuzzy matcher uses. Identical to PATTERNS
// but exposed as a flat list so the scoring loop can iterate directly.
// PATTERNS already covers everything; we simply iterate it.

/**
 * Name a chord from its pitch-class set.
 *
 * Strategy:
 *   1. Try EXACT pattern match first (every pc accounted for, no
 *      missing chord tones). This preserves the historical naming
 *      for "clean" chords like {C, E, G} → "C".
 *   2. Otherwise score every (root, pattern) pair:
 *        score = matched chord-tones
 *              − 0.35 * extra non-chord tones in the pcs
 *              − 0.40 * missing chord tones (pattern interval not in pcs)
 *      Plus small biases:
 *        − 0.05 if root != bass (prefer root position)
 *        − 0.001 * patternIndex (prefer simpler / earlier patterns
 *          when otherwise tied — triads beat 7ths, 7ths beat 9ths)
 *      A candidate is accepted only if matched-chord-tones is at least
 *      3 (or all of pat.ivals when the pattern has fewer than 3 tones).
 *      For triads we additionally require the 3rd or 5th to be present
 *      (otherwise "C with B added" might score as Cmaj7 with one
 *      missing tone — that's a partial reading we don't want).
 *
 * @param {number[]} midis  pitch numbers (any octave)
 * @returns {string|null}   e.g. "Am7" or "Am7/C"
 */
export function nameChord(midis) {
  if (!midis || midis.length < 2) return null;
  const pcs = [...new Set(midis.map(m => ((m % 12) + 12) % 12))].sort((a,b)=>a-b);
  const bass = ((Math.min(...midis) % 12) + 12) % 12;
  if (pcs.length < 2) return null;

  // (1) Exact match — historical fast-path.
  for (const root of pcs) {
    const ivals = pcs.map(p => ((p - root + 12) % 12)).sort((a,b)=>a-b);
    for (const pat of PATTERNS) {
      if (setEq(ivals, pat.ivals)) {
        return (root === bass) ? PCS[root] + pat.name
                               : `${PCS[root] + pat.name}/${PCS[bass]}`;
      }
    }
  }

  // (2) Fuzzy scored match.
  const pcsSet = new Set(pcs);
  let best = null;
  for (let pi = 0; pi < PATTERNS.length; pi++) {
    const pat = PATTERNS[pi];
    for (const root of pcs) {
      // Build the pattern's pcs at this root.
      const patPcs = pat.ivals.map(iv => (root + iv) % 12);
      let matched = 0;
      for (const p of patPcs) if (pcsSet.has(p)) matched++;
      const missing = patPcs.length - matched;
      const extra   = pcs.length    - matched;
      // Acceptance gates.
      const minMatch = Math.min(3, patPcs.length);
      if (matched < minMatch) continue;
      // For triads, require the 3rd or 5th present (not just root + a
      // random tone). This kills false "Cmaj7" readings of {C, B}.
      if (patPcs.length === 3) {
        const hasThird = pcsSet.has((root + pat.ivals[1]) % 12);
        const hasFifth = pcsSet.has((root + pat.ivals[2]) % 12);
        if (!hasThird && !hasFifth) continue;
      }
      const score = matched
                  - 0.35 * extra
                  - 0.40 * missing
                  - (root === bass ? 0 : 0.05)
                  - pi * 0.001;
      if (!best || score > best.score) {
        best = { score, root, pat };
      }
    }
  }
  if (!best) return null;
  const name = PCS[best.root] + best.pat.name;
  return (best.root === bass) ? name : `${name}/${PCS[bass]}`;
}
