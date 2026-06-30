/**
 * Tests for the --purge-orphans flag's mutex with the other publish modes
 * (--force / --heal / --verify-only).
 *
 * The CI-only `GITHUB_ACTIONS` guard is NOT covered here — it lives inside
 * main() and would require spawning the script, which is better served by
 * smoke (test/smoke/auth-enforcement.test.js asserts the deployed
 * /content/orphan-purge endpoint rejects unauthenticated calls) and hybrid
 * (test/hybrid/orphan-purge.test.js asserts end-to-end behavior with a
 * real CONTENT_API_KEY). If the guard regresses, those layers catch it.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode-execution-flow
 */
import { describe, it, expect } from 'vitest';
import { validateFlagCombo } from '../../scripts/publish-content.ts';

describe('validateFlagCombo with --purge-orphans', () => {
  it('purgeOrphans alone is valid', () => {
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: false, purgeOrphans: true })).not.toThrow();
  });
  it('purgeOrphans + force throws', () => {
    expect(() => validateFlagCombo({ force: true, heal: false, verifyOnly: false, purgeOrphans: true }))
      .toThrow(/mutually exclusive/);
  });
  it('purgeOrphans + heal throws', () => {
    expect(() => validateFlagCombo({ force: false, heal: true, verifyOnly: false, purgeOrphans: true }))
      .toThrow(/mutually exclusive/);
  });
  it('purgeOrphans + verifyOnly throws', () => {
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: true, purgeOrphans: true }))
      .toThrow(/mutually exclusive/);
  });
});
