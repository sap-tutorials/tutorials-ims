// test/hybrid/branches-decide.test.js
//
// Issue #172 PR 3 — round-trip /api/branches/decide against real HANA.
// Catches SQL drift the SQLite path silently tolerates (e.g. JSON column
// reads, BranchSpecs write/read through HDI).
//
// Gated by ALLOW_HYBRID_WRITES=true per the repo convention. Skips silently
// when the env var isn't set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `__test__br_${RUN_ID}`;
const SLUG = `${PREFIX}-tut`.toLowerCase();

const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe('hybrid: /api/branches/decide on real HANA', () => {
  beforeAll(async () => {
    if (!writesEnabled) return;
    if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');

    const { BranchSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(BranchSpecs).entries({
      slug: SLUG,
      branchPoints: JSON.stringify([{
        id: '1-deployment',
        parentStepNumber: 1,
        groupKey: 'deployment',
        branches: [
          { key: 'a', label: 'A', condition: null, embeddingHint: null },
          { key: 'b', label: 'B', condition: null, embeddingHint: null },
        ],
      }]),
      skipPoints: JSON.stringify([
        { stepNumber: 4, skipIf: `completed:${PREFIX}-prereq`, skipLabel: 'Skip', skipReason: 'You have it' },
      ]),
    });
  });

  afterAll(async () => {
    if (!writesEnabled) return;
    const { BranchSpecs } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchSpecs).where({ slug: SLUG });
  });

  it.skipIf(!writesEnabled)(
    'returns branch + skip recommendations on a real HANA round-trip',
    async () => {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

      try {
        const { status, data } = await project.get(`/api/branches/decide?slug=${SLUG}&nocache=1`);
        expect(status).toBe(200);
        expect(data.branchPoints).toHaveLength(1);
        expect(data.branchPoints[0].id).toBe('1-deployment');
        expect(data.branchPoints[0].recommendation).toBeDefined();
        expect(data.skipPoints).toHaveLength(1);
        expect(data.skipPoints[0].stepNumber).toBe(4);
      } finally {
        await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: false });
      }
    }
  );
});
