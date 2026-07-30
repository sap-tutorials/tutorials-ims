// test/unit/seed-poc-puzzle.test.js
// TDD for Task 15: seed the POC Devtoberfest Cryptic Crossword.
//
// Validates:
//   1. buildSeedRow() produces the correct slug + a puzzle row that passes validatePuzzle.
//   2. seedPocPuzzle() is idempotent: seeding twice leaves exactly one Puzzles row.

import { expect, test, describe, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { buildSeedRow } from '../../scripts/seed/transform-poc-puzzle.mjs';
import { validatePuzzle } from '../../srv/lib/puzzle-grading.js';

// Standard unit-tier in-memory bootstrap — same pattern as
// admin-feature-flags-read.test.js, admin-get-tutorial-source.test.js, etc.
// The serve runs once for the whole file; individual tests clean up their rows.
cds.test('serve', '--project', '.', '--in-memory');

// ---------------------------------------------------------------------------
// Pure transform tests (no DB needed)
// ---------------------------------------------------------------------------
describe('transform-poc-puzzle', () => {
  test('POC transform produces the correct slug', () => {
    const row = buildSeedRow();
    expect(row.slug).toBe('devtoberfest-cryptic-crossword');
  });

  test('POC transform produces a row that passes validatePuzzle', () => {
    const row = buildSeedRow();
    const v = validatePuzzle({ layout: row.layout, solution: row.solution });
    expect(v.ok).toBe(true);
  });

  test('row has expected metadata fields', () => {
    const row = buildSeedRow();
    expect(row.legacyId).toBe(9644);
    expect(row.status).toBe('ACTIVE');
    expect(row.title).toBeTruthy();
    expect(() => JSON.parse(row.layout)).not.toThrow();
    expect(() => JSON.parse(row.solution)).not.toThrow();
  });

  test('layout contains hints field (empty object)', () => {
    const row = buildSeedRow();
    const layout = JSON.parse(row.layout);
    expect(layout.hints).toBeDefined();
    expect(typeof layout.hints).toBe('object');
    expect(Array.isArray(layout.hints)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency test — uses in-memory db booted above
// ---------------------------------------------------------------------------
describe('seedPocPuzzle idempotency (in-memory db)', () => {
  beforeEach(async () => {
    // Clean slate: remove any Puzzles row with the seed slug so each test is independent.
    await cds.connect.to('db');
    const { Puzzles } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Puzzles).where({ slug: 'devtoberfest-cryptic-crossword' });
  });

  test('seeding twice inserts exactly one row', async () => {
    const { seedPocPuzzle } = await import('../../srv/lib/seed-poc-puzzle.js');
    const db = await cds.connect.to('db');
    const { Puzzles } = cds.entities('com.sap.developers.ims');

    const r1 = await seedPocPuzzle(db);
    expect(r1.seeded).toBe(true);

    const r2 = await seedPocPuzzle(db);
    expect(r2.seeded).toBe(false);

    const rows = await SELECT.from(Puzzles).where({ slug: 'devtoberfest-cryptic-crossword' });
    expect(rows.length).toBe(1);
  });
});
