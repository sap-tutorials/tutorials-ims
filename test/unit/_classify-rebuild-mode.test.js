/**
 * Unit tests for the pure rebuild-mode classifier. No I/O, no CDS boot
 * for the classifier itself; the Steps→Tutorial slug resolver gets a
 * separate cds.test('serve') boot for its one SELECT path.
 *
 * Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md §2
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { classifyRebuildMode, resolveSlugForEntity } from '../../srv/lib/_classify-rebuild-mode.js';

// Boot CDS once at file top so the Steps→Tutorial resolver test can hit a
// real in-memory DB. The pure-path describes below don't depend on this,
// but vitest hooks register correctly regardless. Pattern matches
// test/notification-reset.test.js.
cds.test('serve', '--project', '.', '--in-memory');

describe('classifyRebuildMode', () => {
  it.each([
    // CRUD on nav-invalidating entities
    ['Missions',              'crud', 'catalog-only', false, false],
    ['Groups',                'crud', 'catalog-only', false, false],
    ['CompletionPaths',       'crud', 'catalog-only', false, false],
    ['CompletionPathItems',   'crud', 'catalog-only', false, false],
    ['GroupPathItems',        'crud', 'catalog-only', false, false],
    ['FeaturedTasks',         'crud', 'catalog-only', false, false],
    // Slug-targeted
    ['Tutorials',             'crud', 'slug-targeted', false, true],
    ['Steps',                 'crud', 'slug-targeted', false, true],
    // Full + force-cap-refetch
    ['Tags',                  'crud', 'full',         true,  false],
    // Safe default: anything else → full, no force
    ['Advocates',             'crud', 'full',         false, false],
    ['SomeFutureEntity',      'crud', 'full',         false, false],
    // Bound actions
    ['classifyCategories',    'action', 'catalog-only', false, false],
    ['setFeaturedOrder',      'action', 'catalog-only', false, false],
    ['commitTagImport',       'action', 'full',         true,  false],
    ['cleanupUnusedTags',     'action', 'full',         true,  false],
    // Unrecognized action → safe default
    ['rotateSecretValue',     'action', 'full',         false, false],
    ['uploadPhoto',           'action', 'full',         false, false],
  ])('classify(%s, %s) → mode=%s force=%s slug=%s', (name, kind, expectedMode, expectedForce, expectedSlug) => {
    const out = classifyRebuildMode(name, kind);
    expect(out.mode).toBe(expectedMode);
    expect(out.forceCapRefetch).toBe(expectedForce);
    expect(out.needsSlug).toBe(expectedSlug);
  });

  it('defaults kind to "crud" when omitted', () => {
    const out = classifyRebuildMode('Missions');
    expect(out.mode).toBe('catalog-only');
  });
});

describe('resolveSlugForEntity (pure paths)', () => {
  it('returns row.slug for Tutorials when present', async () => {
    expect(await resolveSlugForEntity('Tutorials', { slug: 'foo' })).toBe('foo');
  });

  it('returns null when Tutorials row has no slug', async () => {
    expect(await resolveSlugForEntity('Tutorials', {})).toBeNull();
  });

  it('returns null for null row', async () => {
    expect(await resolveSlugForEntity('Tutorials', null)).toBeNull();
  });

  it('returns null for Steps with no tutorial_ID', async () => {
    expect(await resolveSlugForEntity('Steps', {})).toBeNull();
  });

  it('returns null for unknown entity', async () => {
    expect(await resolveSlugForEntity('Advocates', { ID: 'x' })).toBeNull();
  });
});

// The Steps-with-tutorial_ID path needs a real CDS DB to exercise the SELECT.
// Pattern matches test/notification-reset.test.js (per memory feedback_default_off_flags_need_live_smoke).
// cds.test() was already called at the top of the file.

describe('resolveSlugForEntity — Steps→Tutorial via CDS', () => {
  beforeAll(async () => {
    const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({
      ID: 'aaaaaaaa-4290-0000-0000-000000000001',
      slug: 'pr429-tut-1',
      title: '#429 fixture tutorial',
      status: 'ACTIVE',
    });
    await INSERT.into(Steps).entries({
      ID: 'bbbbbbbb-4290-0000-0000-000000000001',
      tutorial_ID: 'aaaaaaaa-4290-0000-0000-000000000001',
      title: 'Step 1',
      stepOrder: 1,
    });
  });

  it('returns parent tutorial slug when row.tutorial_ID resolves', async () => {
    const slug = await resolveSlugForEntity('Steps', {
      tutorial_ID: 'aaaaaaaa-4290-0000-0000-000000000001',
    });
    expect(slug).toBe('pr429-tut-1');
  });

  it('returns null when row.tutorial_ID points at a non-existent tutorial (orphan FK)', async () => {
    const slug = await resolveSlugForEntity('Steps', {
      tutorial_ID: 'ffffffff-9999-9999-9999-999999999999',
    });
    expect(slug).toBeNull();
  });
});
