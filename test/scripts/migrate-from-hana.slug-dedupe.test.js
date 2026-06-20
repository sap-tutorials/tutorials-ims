/**
 * Unit tests for dedupeTutorialSlug() — the in-pass collision-avoidance helper
 * for Tutorials.SLUG in scripts/migrate-from-hana.js.
 *
 * Issue #473: Java IMS sometimes has multiple IMS_TASK rows pointing to the
 * same source markdown URL (most commonly an ACTIVE row + a DELETED archive
 * row). Without this helper, the second INSERT trips the
 * COM_SAP_DEVELOPERS_IMS_TUTORIALS_SLUG unique index and the row is silently
 * dropped, leaving dangling FKs in TaskRecords and Steps. The helper mirrors
 * the deriveCompletionPathSlug pattern shipped in PR #468.
 */
import { describe, it, expect } from 'vitest';
import { dedupeTutorialSlug } from '../../scripts/migrate-from-hana.js';

describe('dedupeTutorialSlug() — issue #473', () => {
  it('returns the raw slug on first call and records it in seen', () => {
    const seen = new Set();
    const out = dedupeTutorialSlug('cicd-start-fiori', 1234, seen);
    expect(out).toBe('cicd-start-fiori');
    expect(seen.has('cicd-start-fiori')).toBe(true);
  });

  it('suffixes a colliding slug with -${legacyId} on second call', () => {
    const seen = new Set();
    const first = dedupeTutorialSlug('cicd-start-fiori', 1234, seen);
    const second = dedupeTutorialSlug('cicd-start-fiori', 5678, seen);
    expect(first).toBe('cicd-start-fiori');
    expect(second).toBe('cicd-start-fiori-5678');
    expect(seen.has('cicd-start-fiori')).toBe(true);
    expect(seen.has('cicd-start-fiori-5678')).toBe(true);
  });

  it('falls through to a counter when the suffixed form ALSO collides', () => {
    const seen = new Set();
    // Pre-seed both the raw slug and its `-${legacyId}` suffixed form so the
    // helper has to fall through to the counter.
    seen.add('cicd-start-fiori');
    seen.add('cicd-start-fiori-5678');
    const out = dedupeTutorialSlug('cicd-start-fiori', 5678, seen);
    expect(out).toBe('cicd-start-fiori-5678-1');
    expect(seen.has('cicd-start-fiori-5678-1')).toBe(true);
  });

  it('emits tutorial-${legacyId} placeholder for empty/null rawSlug', () => {
    const seen = new Set();
    expect(dedupeTutorialSlug('', 99, seen)).toBe('tutorial-99');
    expect(dedupeTutorialSlug(null, 100, seen)).toBe('tutorial-100');
    expect(dedupeTutorialSlug(undefined, 101, seen)).toBe('tutorial-101');
    expect(seen.has('tutorial-99')).toBe(true);
    expect(seen.has('tutorial-100')).toBe(true);
    expect(seen.has('tutorial-101')).toBe(true);
  });

  it('suffixes the placeholder branch when tutorial-${legacyId} collides', () => {
    const seen = new Set();
    // Belt-and-braces: this only fires if a placeholder was already minted
    // for the same legacyId (extremely unlikely in practice).
    seen.add('tutorial-7');
    expect(dedupeTutorialSlug('', 7, seen)).toBe('tutorial-7-1');
    seen.add('tutorial-8');
    seen.add('tutorial-8-1');
    expect(dedupeTutorialSlug(null, 8, seen)).toBe('tutorial-8-2');
  });

  it('is deterministic across re-runs with same inputs in same order', () => {
    // The whole point of suffixing on legacyId (not on a counter) is so the
    // suffixed slug stays stable across migrator re-runs. Same inputs in the
    // same order MUST produce the same outputs.
    const inputs = [
      { rawSlug: 'foo', legacyId: 1 },
      { rawSlug: 'foo', legacyId: 2 },
      { rawSlug: 'bar', legacyId: 3 },
      { rawSlug: 'foo', legacyId: 4 },
    ];
    const run1 = [];
    const seen1 = new Set();
    for (const { rawSlug, legacyId } of inputs) {
      run1.push(dedupeTutorialSlug(rawSlug, legacyId, seen1));
    }
    const run2 = [];
    const seen2 = new Set();
    for (const { rawSlug, legacyId } of inputs) {
      run2.push(dedupeTutorialSlug(rawSlug, legacyId, seen2));
    }
    expect(run1).toEqual(run2);
    expect(run1).toEqual(['foo', 'foo-2', 'bar', 'foo-4']);
  });

  it('models the 5 specific 2026-06-20 DEV-migration collisions', () => {
    // The 5 slugs that broke the cutover. The test simulates the
    // ACTIVE-then-DELETED ordering the source query now enforces via
    // ORDER BY (CASE WHEN STATUS = 'DELETED' THEN 1 ELSE 0 END), UPDATED_AT DESC.
    const seen = new Set();
    const collisions = [
      'data-warehouse-cloud-intro2-login-profilesettings',
      'data-warehouse-cloud-graphical4-notifications',
      'cicd-start-fiori',
      'abap-environment-enhance-cds-view',
      'data-warehouse-cloud-bi3-connect-dic',
    ];
    for (const slug of collisions) {
      // ACTIVE row sees fresh slug
      expect(dedupeTutorialSlug(slug, 1000, seen)).toBe(slug);
      // DELETED row gets suffixed
      expect(dedupeTutorialSlug(slug, 2000, seen)).toBe(`${slug}-2000`);
    }
    // All 10 slugs (5 winners + 5 losers) are now in seen.
    expect(seen.size).toBe(10);
  });
});
