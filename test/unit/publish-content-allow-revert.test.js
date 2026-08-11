/**
 * Tests for the #672 operator override CLI derivation: publish-content.ts
 * --allow-revert. The override is intentionally per-slug only — it must be
 * paired with --slug so an operator can only override the ONE slug they named,
 * never blanket-override every revert in a full-catalog publish.
 *
 * Issue: #672 (no-revert guard) operator override.
 */
import { describe, it, expect } from 'vitest';
import { resolveAllowRevertSlugs } from '../../scripts/publish-content.ts';

describe('resolveAllowRevertSlugs (#672 operator override)', () => {
  it('returns [] when --allow-revert is not set (default: guard fully active)', () => {
    expect(resolveAllowRevertSlugs({ allowRevert: false, slug: '' })).toEqual([]);
    expect(resolveAllowRevertSlugs({ allowRevert: false, slug: 'cap-operator-05-deploy-app' })).toEqual([]);
  });

  it('returns exactly the named slug when --allow-revert is paired with --slug', () => {
    expect(resolveAllowRevertSlugs({ allowRevert: true, slug: 'cap-operator-05-deploy-app' }))
      .toEqual(['cap-operator-05-deploy-app']);
  });

  it('throws when --allow-revert is used without --slug (refuses a blanket override)', () => {
    expect(() => resolveAllowRevertSlugs({ allowRevert: true, slug: '' })).toThrow(/requires --slug/);
    expect(() => resolveAllowRevertSlugs({ allowRevert: true, slug: '   ' })).toThrow(/requires --slug/);
  });
});
