/**
 * Tests for the --purge-orphans flag's CI-only guard and mutex with
 * the other publish modes.
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
