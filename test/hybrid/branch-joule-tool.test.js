// test/hybrid/branch-joule-tool.test.js
//
// Issue #172 PR 4 — round-trip getBranchRecommendationHandler against real
// HANA. Catches SQL drift in BranchSpecs JSON column reads + BranchDecisions
// writes that the in-memory SQLite path silently tolerates.
//
// Gated by ALLOW_HYBRID_WRITES=true per repo convention. Skips silently
// when the env var isn't set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { getBranchRecommendationHandler } from '../../srv/lib/branch/joule-tool.js';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `__test__joule_${RUN_ID}`;
const SLUG = `${PREFIX}-tut`.toLowerCase();

const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe('hybrid: getBranchRecommendationHandler on real HANA', () => {
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
    const { BranchSpecs, BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: SLUG });
    await DELETE.from(BranchSpecs).where({ slug: SLUG });
  });

  it.skipIf(!writesEnabled)(
    'returns branchPoints + skipPoints + writes telemetry on a real HANA round-trip',
    async () => {
      const result = await getBranchRecommendationHandler({
        args: { tutorialSlug: SLUG }, user: null
      });
      expect(result.error).toBeUndefined();
      expect(result.branchPoints).toHaveLength(1);
      expect(result.branchPoints[0].id).toBe('1-deployment');
      expect(result.branchPoints[0].picked).toBeTruthy();
      expect(result.skipPoints).toHaveLength(1);
      expect(result.skipPoints[0].stepNumber).toBe(4);

      const { BranchDecisions } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(BranchDecisions).where({ tutorialSlug: SLUG });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].source).toBe('jouleTool');
    }
  );
});
