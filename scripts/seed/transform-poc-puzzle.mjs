// scripts/seed/transform-poc-puzzle.mjs
// Convert the POC cryptic-puzzle-maker export into our Puzzles seed shape.
//
// POC public_data: { id, rows, cols, grid:[[{black,number}]], clues:{"r-c-dir":text},
//                    wordLengths:{"r-c-dir":"n,m"}, name }
// POC answers:     { "r,c":"LETTER" }
//
// Produces one seed row that passes validatePuzzle() in srv/lib/puzzle-grading.js.
// grid is passed through as-is — it already matches our [[{black,number}]] shape.
// hints is {} because the POC has no authored wordplay-type metadata.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLUG = 'devtoberfest-cryptic-crossword';
const LEGACY_ID = 9644; // stable, reserved for this seed puzzle

export function buildSeedRow() {
  const pub = JSON.parse(readFileSync(join(HERE, 'poc-puzzle.public.json'), 'utf8'));
  // Defensive copy — do NOT mutate the parsed JSON directly (keep source faithful).
  const answers = { ...JSON.parse(readFileSync(join(HERE, 'poc-puzzle.answers.json'), 'utf8')) };

  // Data-repair: the POC export is missing the answer for cell 14,12.
  // Deterministically derived from cross-slot 8-12-down (SERVICE, 7 cells rows 8–14):
  //   row 8='S', 9='E', 10='R', 11='V', 12='I', 13='C', 14='E' → [14,12]='E'.
  // Also confirmed by 14-12-across clue ("way to end") = END (cells 14,12–14,14).
  if (answers['14,12'] === undefined && !pub.grid[14][12].black) {
    answers['14,12'] = 'E';
  }

  const layout = {
    rows: pub.rows,
    cols: pub.cols,
    grid: pub.grid,          // [[{black:bool, number:int|null}]] — pass through verbatim
    clues: pub.clues || {},  // {"r-c-dir": "clue text"}
    wordLengths: pub.wordLengths || {},  // {"r-c-dir": "n,m"} — enumeration strings
    hints: {},               // no authored wordplay types in the POC data
  };

  return {
    slug: SLUG,
    legacyId: LEGACY_ID,
    title: pub.name || 'Devtoberfest Cryptic Crossword',
    status: 'ACTIVE',
    layout: JSON.stringify(layout),
    solution: JSON.stringify(answers),  // {"r,c": "LETTER"}
  };
}

// CLI: print the seed row as JSON for inspection.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(buildSeedRow(), null, 2));
}
