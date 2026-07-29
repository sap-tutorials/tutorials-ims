// srv/lib/kg/joule-tool-puzzle-hint.js
// Joule tool: puzzleHint. Returns ONLY safe hint material for a clue —
// clue text, answer length/enumeration, the solver's already-correct crossing
// letters, and the author's wordplay type. The target answer NEVER enters the
// return value or Joule's context. Fail-open: errors return a reason, no throw.

import cds from '@sap/cds';
import { parseLayout, buildSlots } from '../puzzle-grading.js';

const LOG = cds.log('puzzle-hint');
const NS = 'com.sap.developers.ims';
const SLUG_RE = /^[a-z0-9-]{1,120}$/;

export const PUZZLE_HINT_TOOL = {
  type: 'function',
  function: {
    name: 'puzzleHint',
    description: [
      'Give a hint for a specific cryptic-crossword clue WITHOUT revealing the answer.',
      'Returns the clue text, answer length/enumeration, the wordplay type, and any',
      'crossing letters the solver has already filled correctly. Use to coach cryptic',
      'technique (spotting anagrams, hidden words, homophones) — never state the solution.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Puzzle slug (lowercase, hyphens).' },
        slotId: { type: 'string', description: 'Clue slot id, format `${row}-${col}-${dir}` e.g. "0-0-across".' },
        filledGrid: {
          type: 'object',
          description: "Optional map \"r,c\"->letter of the solver's current entries, for crossing-letter hints.",
        },
      },
      required: ['slug', 'slotId'],
    },
  },
};

/**
 * @param {object} opts
 * @param {object} opts.db   - CDS db handle
 * @param {object} opts.args - { slug, slotId, filledGrid? } from the LLM tool call
 * @returns {Promise<{clue?:string, length?:number, enumeration?:string, crossingLetters?:Array, wordplay?:string, reason?:string}>}
 */
export async function puzzleHintHandler({ db, args }) {
  const slug = typeof args?.slug === 'string' ? args.slug.trim().toLowerCase() : '';
  const slotId = String(args?.slotId || '');
  if (!SLUG_RE.test(slug)) return { reason: 'bad-slug' };

  const dbHandle = db || cds.db;
  const { Puzzles } = cds.entities(NS);

  try {
    const p = await dbHandle.run(
      SELECT.one.from(Puzzles).columns('layout').where({ slug })
    );
    if (!p?.layout) return { reason: 'not-found' };

    // parseLayout reads clues/wordLengths/hints — never solution.
    const raw = typeof p.layout === 'string' ? JSON.parse(p.layout) : p.layout;
    const L = parseLayout(p.layout);
    // hints is not part of parseLayout's return; read directly from raw object.
    const hints = raw.hints || {};

    const clue = L.clues[slotId];
    if (!clue) return { reason: 'no-clue' };

    const slot = buildSlots(L.grid).find(s => s.id === slotId);

    // Crossing letters: only the solver's OWN filled letters at this slot's
    // cells (their guesses, not the answer). Never read `solution`.
    const filled = args?.filledGrid && typeof args.filledGrid === 'object' ? args.filledGrid : {};
    const crossingLetters = slot
      ? slot.cells
          .map(({ r, c }, i) => ({ index: i, letter: filled[`${r},${c}`] || null }))
          .filter(x => x.letter)
      : [];

    return {
      clue,
      length: slot?.len ?? null,
      enumeration: L.wordLengths?.[slotId] || null,
      wordplay: hints[slotId] || null,
      crossingLetters,
    };
  } catch (err) {
    LOG.warn('puzzleHint failed:', err.message);
    return { reason: 'error' };
  }
}

export default { PUZZLE_HINT_TOOL, puzzleHintHandler };
