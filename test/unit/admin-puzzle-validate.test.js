// test/unit/admin-puzzle-validate.test.js
// Issue #644 Task 9 — AdminService.Puzzles write-time validation via validatePuzzle.
// Pattern: admin.tx({ user: ADMIN_USER }, ...) matching admin-legacy-redirects-validation.test.js.
// Draft semantics: direct service.create() bypasses the Fiori Draft flow and fires
// the before('CREATE') handler directly — suitable for testing the validation hook.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

describe('AdminService.Puzzles write-time validation (#644 Task 9)', () => {
  let admin;
  beforeAll(async () => { admin = await cds.connect.to('AdminService'); });

  it('rejects a puzzle whose white cell lacks an answer', async () => {
    // layout: 1x2, both white; solution: only covers col 0 — col 1 missing
    const bad = {
      title: 'Bad Puzzle',
      slug: 'bad-puzzle',
      layout: JSON.stringify({
        rows: 1, cols: 2,
        grid: [[{ black: false }, { black: false }]],
        clues: { '0-0-across': 'a clue' }
      }),
      solution: JSON.stringify({ '0,0': 'A' })  // missing '0,1'
    };
    await expect(
      admin.tx({ user: ADMIN_USER }, (tx) =>
        tx.create('Puzzles').entries(bad)
      )
    ).rejects.toBeTruthy();
  });

  it('accepts a well-formed puzzle and lowercases the slug', async () => {
    // layout: 1x2, both white; solution covers both cells; clue provided
    const good = {
      title: 'Good Puzzle',
      slug: 'GOOD-PUZZLE',  // uppercase — before-handler must lowercase it
      layout: JSON.stringify({
        rows: 1, cols: 2,
        grid: [[{ black: false }, { black: false }]],
        clues: { '0-0-across': 'a clue' }
      }),
      solution: JSON.stringify({ '0,0': 'A', '0,1': 'B' })
    };
    // draft-enabled entity: service-level CREATE returns { affected:1 }, not the row.
    // The slug is mutated by the before-handler before INSERT, so read back by slug.
    await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.create('Puzzles').entries(good)
    );
    const rows = await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.read('Puzzles').where({ slug: 'good-puzzle' })
    );
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('good-puzzle');
  });
});
