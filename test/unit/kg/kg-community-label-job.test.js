// test/unit/kg/kg-community-label-job.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted so the variable is available before vi.mock factory runs
// (vitest hoists vi.mock to the top of the file, above let/const).
const { labelCommunityViaLlm } = vi.hoisted(() => {
  const labelCommunityViaLlm = vi.fn();
  return { labelCommunityViaLlm };
});
vi.mock('../../../srv/lib/kg/community-label-llm.js', () => ({ labelCommunityViaLlm }));

import { runKgCommunityLabels, _computeForTest } from '../../../srv/jobs/kg-community-label-job.js';

describe('runKgCommunityLabels (pure planner)', () => {
  beforeEach(() => labelCommunityViaLlm.mockReset());

  it('skips communities whose memberSlugsHash is unchanged', () => {
    const plan = _computeForTest({
      summaries: [{ communityFingerprint: 'fp1', tutorialCount: 3 }],
      membersByFp: { fp1: ['a', 'b', 'c'] },
      existingLabels: { fp1: { memberSlugsHash: hashOf(['a', 'b', 'c']) } },
    });
    expect(plan.toLabel).toHaveLength(0);
    expect(plan.skipped).toBe(1);
  });

  it('labels new/changed communities', () => {
    const plan = _computeForTest({
      summaries: [{ communityFingerprint: 'fp1', tutorialCount: 2 }],
      membersByFp: { fp1: ['a', 'b'] },
      existingLabels: {},
    });
    expect(plan.toLabel.map((c) => c.communityFingerprint)).toEqual(['fp1']);
  });

  it('ignores communities with fewer than 2 tutorials', () => {
    const plan = _computeForTest({
      summaries: [{ communityFingerprint: 'fp1', tutorialCount: 1 }],
      membersByFp: { fp1: ['a'] },
      existingLabels: {},
    });
    expect(plan.toLabel).toHaveLength(0);
  });
});

// Local mirror of computeMemberSlugsHash for the assertion.
import { computeMemberSlugsHash as hashOf } from '../../../srv/lib/kg/community-member-hash.js';
