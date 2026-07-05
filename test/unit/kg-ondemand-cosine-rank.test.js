// test/unit/kg-ondemand-cosine-rank.test.js
//
// Unit tests for rankTutorialsByQueryVector (SQLite path).
// Three cases:
//   1. Top-K by MAX cosine, ACTIVE-gated (DRAFT excluded).
//   2. Returns empty array when TutorialEmbedding is empty.
//   3. Respects the limit argument.
//
// Issue: #948

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { rankTutorialsByQueryVector } from '../../srv/lib/kg/on-demand-cosine-rank.js';

const NS = 'com.sap.developers.ims';
const DIMS = 1536;

function unitVec(i) {
  const v = new Float32Array(DIMS);
  v[i % DIMS] = 1.0;
  return v;
}

function bufFromVec(v) {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}

describe('rankTutorialsByQueryVector (#948)', () => {
  let db;

  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { Tutorials, TutorialEmbedding } = cds.entities(NS);
    await DELETE.from(TutorialEmbedding);
    await DELETE.from(Tutorials);
  });

  it('returns top-K by MAX cosine, ACTIVE-gated', async () => {
    const { Tutorials, TutorialEmbedding } = cds.entities(NS);
    const t1 = 'tttttttt-1111-1111-1111-111111111111';
    const t2 = 'tttttttt-2222-2222-2222-222222222222';
    const tDraft = 'tttttttt-3333-3333-3333-333333333333';

    await INSERT.into(Tutorials).entries([
      { ID: t1, slug: 't1', title: 'T1', status: 'ACTIVE' },
      { ID: t2, slug: 't2', title: 'T2', status: 'ACTIVE' },
      { ID: tDraft, slug: 'tdraft', title: 'Draft', status: 'DRAFT' },
    ]);

    // t1 has a step aligned with unit vector 0 → cosine 1.0 with query
    await INSERT.into(TutorialEmbedding).entries([
      { tutorial_ID: t1, stepNumber: 1, embedding: bufFromVec(unitVec(0)) },
      { tutorial_ID: t1, stepNumber: 2, embedding: bufFromVec(unitVec(500)) },
      { tutorial_ID: t2, stepNumber: 1, embedding: bufFromVec(unitVec(500)) },
      { tutorial_ID: tDraft, stepNumber: 1, embedding: bufFromVec(unitVec(0)) },
    ]);

    const results = await rankTutorialsByQueryVector({
      db, queryVector: unitVec(0), limit: 5,
    });

    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('t1');
    expect(slugs).not.toContain('tdraft');   // ACTIVE-gate
    expect(results[0].slug).toBe('t1');       // Best cosine
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  it('returns empty array on empty TutorialEmbedding', async () => {
    const results = await rankTutorialsByQueryVector({
      db, queryVector: unitVec(0), limit: 5,
    });
    expect(results).toEqual([]);
  });

  it('respects the limit argument', async () => {
    const { Tutorials, TutorialEmbedding } = cds.entities(NS);
    for (let i = 0; i < 10; i++) {
      const id = `tttttttt-${String(i).padStart(4, '0')}-0000-0000-000000000000`;
      await INSERT.into(Tutorials).entries({ ID: id, slug: `t${i}`, title: `T${i}`, status: 'ACTIVE' });
      await INSERT.into(TutorialEmbedding).entries({ tutorial_ID: id, stepNumber: 1, embedding: bufFromVec(unitVec(i)) });
    }
    const results = await rankTutorialsByQueryVector({
      db, queryVector: unitVec(3), limit: 3,
    });
    expect(results).toHaveLength(3);
  });
});
