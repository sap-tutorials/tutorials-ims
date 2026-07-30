// test/hybrid/puzzle-nclob.test.js
// NCLOB round-trip: insert a Puzzles row with layout+solution, read them back
// in their OWN column-only query (avoids LOB-locator expiry that occurs when
// NCLOB/BLOB columns are mixed with non-LOB metadata in a single SELECT on
// HANA — see Global Constraints in CLAUDE.md).
// Run: npx vitest --project hybrid run test/hybrid/puzzle-nclob.test.js
// Requires: cds bind + cf login (self-guards via isSafeForWrites).
import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

// Unique slug per run so parallel executions don't collide.
const SLUG = 'hybrid-nclob-' + Date.now();

describe.runIf(isSafeForWrites())('Puzzle NCLOB round-trip (hybrid HANA)', () => {
  afterAll(async () => {
    // Clean up regardless of test outcome.
    const { Puzzles } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Puzzles).where({ slug: SLUG });
  });

  it('layout/solution NCLOB columns round-trip on HANA', async () => {
    const { Puzzles } = cds.entities('com.sap.developers.ims');

    const layout = JSON.stringify({
      rows: 1,
      cols: 3,
      grid: [[{ black: false }, { black: false }, { black: false }]],
      clues: { '0-0-across': 'x' },
    });
    const solution = JSON.stringify({ '0,0': 'A', '0,1': 'B', '0,2': 'C' });

    await INSERT.into(Puzzles).entries({
      ID:       cds.utils.uuid(),
      title:    'NCLOB Hybrid Test',
      slug:     SLUG,
      layout,
      solution,
    });

    // Read layout/solution in their OWN query — never mix NCLOB columns with
    // metadata columns in a single CDS QL query on HANA (LOB locator expiry).
    const row = await SELECT.one
      .from(Puzzles)
      .columns('layout', 'solution')
      .where({ slug: SLUG });

    expect(row, 'inserted row not found').toBeTruthy();
    expect(JSON.parse(row.layout).cols).toBe(3);
    expect(JSON.parse(row.solution)['0,2']).toBe('C');
  });
});
