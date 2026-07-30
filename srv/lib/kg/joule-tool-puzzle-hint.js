// srv/lib/kg/joule-tool-puzzle-hint.js
// Joule tool: puzzleHint. Returns ONLY safe hint material for a clue —
// clue text, answer length/enumeration, the solver's already-correct crossing
// letters, and the author's wordplay type. The target answer NEVER enters the
// return value or Joule's context. Fail-open: errors return a reason, no throw.

import cds from '@sap/cds';
import { parseLayout, buildSlots } from '../puzzle-grading.js';

const LOG = cds.log('puzzle-hint');
const NS = 'com.sap.developers.ims';
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const PUZZLE_HINT_TOOL = {
  type: 'function',
  function: {
    name: 'puzzleHint',
    description: [
      'Give a hint for a specific cryptic-crossword clue WITHOUT revealing the answer.',
      'Returns the clue text, answer length/enumeration, the wordplay type, and any',
      'crossing letters the solver has already filled correctly. Use to coach cryptic',
      'technique (spotting anagrams, hidden words, homophones) — never state the solution.',
      'Identify the clue the NATURAL way the solver refers to it: pass clueNumber (e.g. 3)',
      'and direction ("across"/"down"). You normally do NOT know grid coordinates — prefer',
      'clueNumber+direction. slotId (`${row}-${col}-${dir}`) is an internal fallback only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Puzzle slug (lowercase, hyphens).' },
        clueNumber: { type: 'integer', description: 'The clue number as shown to the solver, e.g. 3 for "3 Across".' },
        direction: { type: 'string', enum: ['across', 'down'], description: 'Clue direction. Required when using clueNumber.' },
        slotId: { type: 'string', description: 'Internal fallback: clue slot id, format `${row}-${col}-${dir}` e.g. "0-0-across". Prefer clueNumber+direction.' },
        filledGrid: {
          type: 'object',
          description: "Optional map \"r,c\"->letter of the solver's current entries, for crossing-letter hints.",
        },
      },
      required: ['slug'],
    },
  },
};

/**
 * @param {object} opts
 * @param {object} opts.db   - CDS db handle
 * @param {object} opts.args - { slug, clueNumber?, direction?, slotId?, filledGrid? } from the LLM tool call
 * @returns {Promise<{clue?:string, length?:number, enumeration?:string, crossingLetters?:Array, wordplay?:string, slotId?:string, reason?:string}>}
 */
export async function puzzleHintHandler({ db, args }) {
  const slug = typeof args?.slug === 'string' ? args.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return { reason: 'bad-slug' };

  const dbHandle = db || cds.db;
  const { Puzzles } = cds.entities(NS);

  try {
    const p = await dbHandle.run(
      // slug-canonical: pre-canonicalized
      SELECT.one.from(Puzzles).columns('layout').where({ slug })
    );
    if (!p?.layout) return { reason: 'not-found' };

    // parseLayout reads clues/wordLengths/hints — never solution.
    const raw = typeof p.layout === 'string' ? JSON.parse(p.layout) : p.layout;
    const L = parseLayout(p.layout);
    // hints is not part of parseLayout's return; read directly from raw object.
    const hints = raw.hints || {};

    const slots = buildSlots(L.grid);

    // Resolve the slot. Prefer clueNumber+direction (how the solver refers to a
    // clue); fall back to a raw slotId. buildSlots populates each slot's `.number`
    // from the grid cell, so a human clue number maps deterministically to a slot.
    let slotId = typeof args?.slotId === 'string' ? args.slotId : '';
    let slot = null;
    const clueNumber = args?.clueNumber != null ? Number(args.clueNumber) : null;
    const direction = typeof args?.direction === 'string' ? args.direction.toLowerCase() : '';
    if (Number.isFinite(clueNumber) && (direction === 'across' || direction === 'down')) {
      slot = slots.find(s => s.number === clueNumber && s.dir === direction) || null;
      if (!slot) return { reason: 'no-clue' };
      slotId = slot.id;
    } else if (slotId) {
      slot = slots.find(s => s.id === slotId) || null;
    } else {
      // Neither a usable clueNumber+direction nor a slotId was supplied.
      return { reason: 'no-clue' };
    }

    const clue = L.clues[slotId];
    if (!clue) return { reason: 'no-clue' };

    // Crossing letters: only the solver's OWN filled letters at this slot's
    // cells (their guesses, not the answer). Never read `solution`.
    const filled = args?.filledGrid && typeof args.filledGrid === 'object' ? args.filledGrid : {};
    const crossingLetters = slot
      ? slot.cells
          .map(({ r, c }, i) => ({ index: i, letter: filled[`${r},${c}`] || null }))
          .filter(x => x.letter)
      : [];

    return {
      slotId,
      clueNumber: slot?.number ?? null,
      direction: slot?.dir ?? null,
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
