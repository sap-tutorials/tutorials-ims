// test/unit/srv/kg-path-v2-client.test.js
// Pure-JS unit tests for the KG_PATH_V2 wrapper. Uses vi.mock to stub
// cds.db.run — no DB required. Hybrid coverage lives in
// test/hybrid/kg-path-v2.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runMock = vi.fn();
vi.mock('@sap/cds', () => ({
  default: { db: { run: (...args) => runMock(...args) } },
}));

// Import AFTER vi.mock so the mock is in place.
const { kgPathV2 } = await import('../../../srv/lib/kg-path-v2-client.js');

beforeEach(() => { runMock.mockReset(); });

describe('kgPathV2 — input validation', () => {
  it('rejects http:// (must be https)', async () => {
    await expect(kgPathV2({
      fromIri: 'http://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    })).rejects.toMatchObject({ code: 10006 });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects uppercase in slug', async () => {
    await expect(kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/Foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    })).rejects.toMatchObject({ code: 10006 });
  });

  it('rejects slug longer than 80 chars', async () => {
    const long = 'a'.repeat(81);
    await expect(kgPathV2({
      fromIri: `https://developers.sap.com/kg/tutorial/${long}`,
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    })).rejects.toMatchObject({ code: 10006 });
  });

  it('rejects maxHops < 1', async () => {
    await expect(kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
      maxHops: 0,
    })).rejects.toMatchObject({ code: 10010 });
  });

  it('rejects maxHops > 20', async () => {
    await expect(kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
      maxHops: 21,
    })).rejects.toMatchObject({ code: 10010 });
  });
});

describe('kgPathV2 — row grouping', () => {
  it('groups flat rows by PATH_RANK, orders by SEQ_INDEX', async () => {
    // Two paths, each with 3 hops (4 vertices). Rows arrive out of order
    // to prove the grouper is robust to DB row ordering.
    runMock.mockResolvedValueOnce([
      { PATH_RANK: 2, HOP_COUNT: 1, VERTEX_SEQ: 'tutorial:x', SEQ_INDEX: 0 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'concept:c2', SEQ_INDEX: 2 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'tutorial:from', SEQ_INDEX: 0 },
      { PATH_RANK: 2, HOP_COUNT: 1, VERTEX_SEQ: 'tutorial:y', SEQ_INDEX: 1 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'concept:c1', SEQ_INDEX: 1 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'tutorial:to', SEQ_INDEX: 3 },
    ]);
    const out = await kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    });
    // path_rank 2 has only 2 vertices total — no interior at all — so the
    // < 3 total-vertices filter drops it. path_rank 1 has 4 vertices; its
    // interior is ['concept:c1','concept:c2'] — kept.
    expect(out).toEqual([
      {
        pathRank: 1,
        hopCount: 3,
        vertices: ['tutorial:from', 'concept:c1', 'concept:c2', 'tutorial:to'],
      },
    ]);
  });

  it('filters paths whose interior vertices are not concepts', async () => {
    // A path with a stray tutorial vertex in the middle — should be dropped
    // by the defense-in-depth filter.
    runMock.mockResolvedValueOnce([
      { PATH_RANK: 1, HOP_COUNT: 2, VERTEX_SEQ: 'tutorial:a', SEQ_INDEX: 0 },
      { PATH_RANK: 1, HOP_COUNT: 2, VERTEX_SEQ: 'tutorial:middle', SEQ_INDEX: 1 },
      { PATH_RANK: 1, HOP_COUNT: 2, VERTEX_SEQ: 'tutorial:b', SEQ_INDEX: 2 },
    ]);
    const out = await kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    });
    expect(out).toEqual([]);
  });

  it('returns empty on no rows', async () => {
    runMock.mockResolvedValueOnce([]);
    const out = await kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    });
    expect(out).toEqual([]);
  });
});
