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

describe('build-time validation errors', () => {
  it('rejects unbalanced [BRANCH_BEGIN]', () => {
    const body = '### Step 1\n\n[BRANCH_BEGIN group="g" key="a" label="A"]\n### sub\n';
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/unbalanced/);
  });

  it('rejects stray [BRANCH_END]', () => {
    const body = '### Step 1\n\n[BRANCH_END]\n';
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/without matching/);
  });

  it('rejects nested [BRANCH_BEGIN]', () => {
    const body = [
      '### Step 1',
      '[BRANCH_BEGIN group="g" key="a" label="A"]',
      '### sub-a',
      '[BRANCH_BEGIN group="g" key="b" label="B"]',
      '### sub-b',
      '[BRANCH_END]',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/nested/);
  });

  it('rejects mismatched group= within sibling block', () => {
    const body = [
      '### Step 1',
      '[BRANCH_BEGIN group="deployment" key="a" label="A"]',
      '### sub-a',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="deploy" key="b" label="B"]',
      '### sub-b',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/sibling has group=/);
  });

  it('rejects duplicate key within a group', () => {
    const body = [
      '### Step 1',
      '[BRANCH_BEGIN group="g" key="a" label="A"]',
      '### sub-a-1',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="g" key="a" label="A again"]',
      '### sub-a-2',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/duplicate key/);
  });

  it('rejects empty branch (no H3 sub-steps)', () => {
    const body = [
      '### Step 1',
      '[BRANCH_BEGIN group="g" key="a" label="A"]',
      '',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/no H3 sub-steps/);
  });

  it('rejects unparseable condition', () => {
    const body = [
      '### Step 1',
      '[BRANCH_BEGIN group="g" key="a" label="A" condition="profile.deployment == cloud"]',
      '### sub',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/condition.*does not parse/);
  });

  it('rejects [BRANCH_BEGIN] missing required attribute', () => {
    const body = [
      '### Step 1',
      '[BRANCH_BEGIN group="g" key="a"]',
      '### sub',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchGroups(body, 'slug')).toThrow(/missing label/);
  });
});
