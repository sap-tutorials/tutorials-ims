// test/unit/puzzle-service-check.test.js
//
// Unit tests for PuzzleService.check action (Task 5).
// Bootstrap: cds.test() pattern matching other unit tests in this project.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ANON = { id: 'anonymous', roles: {} };

describe('PuzzleService.check', () => {
  let svc;

  beforeAll(async () => {
    const { Puzzles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Puzzles).entries({
      ID: cds.utils.uuid(),
      title: 'Chk',
      slug: 'chk',
      status: 'ACTIVE',
      layout: JSON.stringify({
        rows: 1, cols: 3,
        grid: [[{ black: false }, { black: false }, { black: false }]],
        clues: { '0-0-across': 'x' }
      }),
      solution: JSON.stringify({ '0,0': 'C', '0,1': 'A', '0,2': 'T' })
    });
    svc = await cds.connect.to('PuzzleService');
  });

  it('grades a correct word and reports complete', async () => {
    const r = await svc.tx({ user: ANON }, tx =>
      tx.send('check', { slug: 'chk', entries: [{ slotId: '0-0-across', word: 'CAT' }] })
    );
    expect(r.results[0]).toEqual({ slotId: '0-0-across', correct: true });
    expect(r.complete).toBe(true);
  });

  it('grades a wrong word without leaking letters', async () => {
    const r = await svc.tx({ user: ANON }, tx =>
      tx.send('check', { slug: 'chk', entries: [{ slotId: '0-0-across', word: 'DOG' }] })
    );
    expect(r.results[0].correct).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/CAT/);
  });

  it('rejects with 404 on unknown slug', async () => {
    await expect(
      svc.tx({ user: ANON }, tx =>
        tx.send('check', { slug: 'nope', entries: [] })
      )
    ).rejects.toMatchObject({ code: 404 });
  });

  it('rejects 400 when entries exceed puzzle slot count', async () => {
    // The 'chk' puzzle has exactly 1 slot (0-0-across). Sending 2 entries must be rejected.
    const tooMany = [
      { slotId: '0-0-across', word: 'CAT' },
      { slotId: '0-0-across', word: 'DOG' },
    ];
    await expect(
      svc.tx({ user: ANON }, tx =>
        tx.send('check', { slug: 'chk', entries: tooMany })
      )
    ).rejects.toMatchObject({ code: 400 });
  });

  it('accepts entries exactly at the slot count (regression)', async () => {
    // Exactly 1 entry for the 1-slot puzzle — must not be rejected.
    const r = await svc.tx({ user: ANON }, tx =>
      tx.send('check', { slug: 'chk', entries: [{ slotId: '0-0-across', word: 'CAT' }] })
    );
    expect(r.complete).toBe(true);
  });

  it('returns per-cell correctness array with correct:false for a wrong word', async () => {
    const r = await svc.tx({ user: ANON }, tx =>
      tx.send('check', { slug: 'chk', entries: [{ slotId: '0-0-across', word: 'DOG' }] })
    );
    expect(Array.isArray(r.cells)).toBe(true);
    expect(r.cells.length).toBeGreaterThan(0);
    expect(r.cells.some(c => c.correct === false)).toBe(true);
    // Verify cell shape: each has r, c, correct
    expect(r.cells[0]).toMatchObject({ r: expect.any(Number), c: expect.any(Number), correct: expect.any(Boolean) });
  });
});
