/**
 * Tests for #1668 — publish-content auto-verify must distinguish slugs that
 * differ because the #672 no-revert guard deliberately kept prior content
 * (expected, benign) from slugs that genuinely failed to store (a real
 * "Verify FAILED"). `partitionVerifyMismatches` is the pure split the CLI
 * auto-verify step uses so an operator isn't alarmed by the guard doing its
 * job.
 *
 * Issue: #1668 ("Verify FAILED" is misleading when reverts are rejected).
 */
import { describe, it, expect } from 'vitest';
import { partitionVerifyMismatches } from '../../scripts/publish-content.ts';

describe('partitionVerifyMismatches (#1668)', () => {
  it('classifies a diffed slug as an expected revert when it was rejected by the guard', () => {
    const { genuine, expectedReverts } = partitionVerifyMismatches({
      verifyDiff: ['cap-operator-05-deploy-app'],
      rejectedReverts: ['cap-operator-05-deploy-app'],
    });
    expect(genuine).toEqual([]);
    expect(expectedReverts).toEqual(['cap-operator-05-deploy-app']);
  });

  it('classifies a diffed slug as genuine when it was NOT rejected as a revert', () => {
    const { genuine, expectedReverts } = partitionVerifyMismatches({
      verifyDiff: ['some-tutorial'],
      rejectedReverts: [],
    });
    expect(genuine).toEqual(['some-tutorial']);
    expect(expectedReverts).toEqual([]);
  });

  it('splits a mixed diff into genuine mismatches and expected rejected reverts', () => {
    const { genuine, expectedReverts } = partitionVerifyMismatches({
      verifyDiff: ['genuine-a', 'rejected-b', 'genuine-c', 'rejected-d'],
      rejectedReverts: ['rejected-b', 'rejected-d'],
    });
    expect(genuine).toEqual(['genuine-a', 'genuine-c']);
    expect(expectedReverts).toEqual(['rejected-b', 'rejected-d']);
  });

  it('ignores rejected reverts that do not appear in the verify diff', () => {
    // A rejected revert whose bytes happened to already match the server
    // won't show up in verifyDiff — it must not be invented into either list.
    const { genuine, expectedReverts } = partitionVerifyMismatches({
      verifyDiff: ['genuine-a'],
      rejectedReverts: ['rejected-not-in-diff'],
    });
    expect(genuine).toEqual(['genuine-a']);
    expect(expectedReverts).toEqual([]);
  });

  it('treats an undefined rejectedReverts list as no reverts (all diffs genuine)', () => {
    const { genuine, expectedReverts } = partitionVerifyMismatches({
      verifyDiff: ['genuine-a', 'genuine-b'],
      rejectedReverts: undefined,
    });
    expect(genuine).toEqual(['genuine-a', 'genuine-b']);
    expect(expectedReverts).toEqual([]);
  });
});
