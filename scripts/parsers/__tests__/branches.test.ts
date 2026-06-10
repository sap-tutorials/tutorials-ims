import { describe, it, expect } from 'vitest';
import { extractBranchGroups, BranchParseError } from '../branches.js';

describe('extractBranchGroups', () => {
  it('returns empty branchGroups for body with no markers', () => {
    const body = '### Step 1\n\nSome content.\n\n### Step 2\n\nMore content.';
    const result = extractBranchGroups(body, 'test-slug');
    expect(result.branchGroups).toEqual([]);
    expect(result.rewrittenBody).toBe(body);
  });

  it('exports BranchParseError as a real Error subclass', () => {
    expect(BranchParseError.prototype).toBeInstanceOf(Error);
  });
});

describe('single branch group', () => {
  it('extracts two sibling branches with H3 sub-steps and rewrites body', () => {
    const body = [
      '### Step 1 — Intro',
      '',
      'Pick deployment:',
      '',
      '[BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud" condition="profile.deployment == \'cloud\'"]',
      '',
      '### Step 1a — Configure HANA',
      '',
      'HANA content.',
      '',
      '### Step 1b — Verify HANA',
      '',
      'HANA verify.',
      '',
      '[BRANCH_END]',
      '',
      '[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]',
      '',
      '### Step 1a-prime — Configure PostgreSQL',
      '',
      'Postgres content.',
      '',
      '[BRANCH_END]',
      '',
      '### Step 2 — Continue',
      '',
      'Continue content.',
    ].join('\n');

    const { rewrittenBody, branchGroups } = extractBranchGroups(body, 'test-slug');

    expect(branchGroups).toHaveLength(1);
    const g = branchGroups[0];
    expect(g.groupKey).toBe('deployment');
    expect(g.parentStepNumber).toBe(1);
    expect(g.id).toBe('1-deployment');
    expect(g.branches).toHaveLength(2);

    expect(g.branches[0]).toMatchObject({
      key: 'hana',
      label: 'HANA Cloud',
      condition: "profile.deployment == 'cloud'",
      embeddingHint: 'Step 1a — Configure HANA',
    });
    expect(g.branches[0].steps).toHaveLength(2);
    expect(g.branches[0].steps[0].title).toBe('Step 1a — Configure HANA');
    expect(g.branches[0].steps[1].title).toBe('Step 1b — Verify HANA');

    expect(g.branches[1]).toMatchObject({
      key: 'postgres',
      label: 'PostgreSQL',
      condition: null,
    });

    expect(rewrittenBody).toContain('### Step 1 — Intro');
    expect(rewrittenBody).toContain('Pick deployment:');
    expect(rewrittenBody).toContain('### Step 2 — Continue');
    expect(rewrittenBody).not.toContain('[BRANCH_BEGIN');
    expect(rewrittenBody).not.toContain('[BRANCH_END');
    expect(rewrittenBody).not.toContain('Configure HANA');
    expect(rewrittenBody).not.toContain('Configure PostgreSQL');
  });
});
