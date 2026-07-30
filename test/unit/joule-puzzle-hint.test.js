// test/unit/joule-puzzle-hint.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { puzzleHintHandler } from '../../srv/lib/kg/joule-tool-puzzle-hint.js';

// Bootstrap: mirror puzzle-service-check.test.js pattern.
cds.test('serve', '--project', '.', '--in-memory');

beforeAll(async () => {
  const { Puzzles } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Puzzles).entries({
    ID: cds.utils.uuid(),
    title: 'Hint',
    slug: 'hint',
    layout: JSON.stringify({
      rows: 1, cols: 3,
      grid: [[{ black: false }, { black: false }, { black: false }]],
      clues: { '0-0-across': 'Feline (3)' },
      wordLengths: { '0-0-across': '3' },
      hints: { '0-0-across': 'anagram' },
    }),
    solution: JSON.stringify({ '0,0': 'C', '0,1': 'A', '0,2': 'T' }),
  });
});

test('hint returns clue + wordplay but never the answer', async () => {
  const db = cds.db;
  const r = await puzzleHintHandler({ db, args: { slug: 'hint', slotId: '0-0-across' } });
  expect(r.clue).toMatch(/Feline/);
  expect(r.wordplay).toBe('anagram');
  expect(JSON.stringify(r)).not.toMatch(/CAT/);
});

test('hint on unknown slug fails open', async () => {
  const db = cds.db;
  const r = await puzzleHintHandler({ db, args: { slug: 'nope', slotId: '0-0-across' } });
  expect(r.reason).toBeTruthy();
});
