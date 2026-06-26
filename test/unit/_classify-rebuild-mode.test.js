/**
 * Unit tests for the pure rebuild-mode classifier. No I/O, no CDS boot
 * for the classifier itself; the Steps→Tutorial slug resolver gets a
 * separate cds.test('serve') boot for its one SELECT path.
 *
 * Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md §2
 * Extension (#541): tag-rename reverse-lookup adds `needsSlugsByTag` flag
 * + `resolveSlugsForTagRename` helper.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import {
  classifyRebuildMode,
  resolveSlugForEntity,
  resolveSlugsForTagRename,
  TAG_REVERSE_LOOKUP_CAP,
} from '../../srv/lib/_classify-rebuild-mode.js';

// Boot CDS once at file top so the Steps→Tutorial resolver test can hit a
// real in-memory DB. The pure-path describes below don't depend on this,
// but vitest hooks register correctly regardless. Pattern matches
// test/notification-reset.test.js.
cds.test('serve', '--project', '.', '--in-memory');

describe('classifyRebuildMode', () => {
  it.each([
    // CRUD on nav-invalidating entities
    ['Missions',              'crud', 'catalog-only',  false, false, false],
    ['Groups',                'crud', 'catalog-only',  false, false, false],
    ['CompletionPaths',       'crud', 'catalog-only',  false, false, false],
    ['CompletionPathItems',   'crud', 'catalog-only',  false, false, false],
    ['GroupPathItems',        'crud', 'catalog-only',  false, false, false],
    ['FeaturedTasks',         'crud', 'catalog-only',  false, false, false],
    // Slug-targeted
    ['Tutorials',             'crud', 'slug-targeted', false, true,  false],
    ['Steps',                 'crud', 'slug-targeted', false, true,  false],
    // #541: Tags now opt into tag-reverse-lookup; the hook decides between
    // slug-targeted (per-tutorial) and full+force-cap-refetch based on the
    // result of resolveSlugsForTagRename. The mode field here is the
    // classifier's *recommendation* — the hook overrides if lookup yields
    // 0 or >cap slugs.
    ['Tags',                  'crud', 'slug-targeted', true,  false, true],
    // Safe default: anything else → full, no force
    ['Advocates',             'crud', 'full',          false, false, false],
    ['SomeFutureEntity',      'crud', 'full',          false, false, false],
    // Bound actions
    ['classifyCategories',    'action', 'catalog-only', false, false, false],
    ['setFeaturedOrder',      'action', 'catalog-only', false, false, false],
    ['commitTagImport',       'action', 'full',         true,  false, false],
    ['cleanupUnusedTags',     'action', 'full',         true,  false, false],
    // Unrecognized action → safe default
    ['rotateSecretValue',     'action', 'full',         false, false, false],
    ['uploadPhoto',           'action', 'full',         false, false, false],
  ])('classify(%s, %s) → mode=%s force=%s slug=%s tagLookup=%s', (name, kind, expectedMode, expectedForce, expectedSlug, expectedTagLookup) => {
    const out = classifyRebuildMode(name, kind);
    expect(out.mode).toBe(expectedMode);
    expect(out.forceCapRefetch).toBe(expectedForce);
    expect(out.needsSlug).toBe(expectedSlug);
    expect(out.needsSlugsByTag).toBe(expectedTagLookup);
  });

  it('defaults kind to "crud" when omitted', () => {
    const out = classifyRebuildMode('Missions');
    expect(out.mode).toBe('catalog-only');
  });

  it('exports TAG_REVERSE_LOOKUP_CAP as 50', () => {
    expect(TAG_REVERSE_LOOKUP_CAP).toBe(50);
  });

  // #548: runtime-served entities short-circuit the rebuild dispatch entirely.
  // Alerts are served via /api/alerts* with a short cache TTL; admin CRUD must
  // NOT trigger a Hugo rebuild.
  it("returns mode='none' for entities in the NO_REBUILD set (Alerts)", () => {
    const result = classifyRebuildMode('Alerts', 'crud');
    expect(result.mode).toBe('none');
    expect(result.forceCapRefetch).toBe(false);
    expect(result.needsSlug).toBe(false);
    expect(result.needsSlugsByTag).toBe(false);
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

describe('resolveSlugsForTagRename (#541, pure paths)', () => {
  it('returns empty array when tagId is null/undefined', async () => {
    expect(await resolveSlugsForTagRename(null)).toEqual([]);
    expect(await resolveSlugsForTagRename(undefined)).toEqual([]);
    expect(await resolveSlugsForTagRename('')).toEqual([]);
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

// #541 — tag reverse-lookup. Needs CDS DB to seed Tags + TutorialTags rows.
describe('resolveSlugsForTagRename — Tag→Tutorials via CDS', () => {
  const TAG_NICHE   = 'cccccccc-5410-0000-0000-000000000001';
  const TAG_MID     = 'cccccccc-5410-0000-0000-000000000002';
  const TAG_EMPTY   = 'cccccccc-5410-0000-0000-000000000003';
  const TUT_BASE    = 'dddddddd-5410-0000-0000-00000000';

  beforeAll(async () => {
    const { Tags, Tutorials, TutorialTags } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries([
      { ID: TAG_NICHE, name: '#541-niche' },
      { ID: TAG_MID,   name: '#541-mid'   },
      { ID: TAG_EMPTY, name: '#541-empty' },
    ]);

    // 3 tutorials carry the niche tag; 7 carry the mid tag.
    const tutorialRows = [];
    const linkRows = [];
    for (let i = 1; i <= 10; i++) {
      const id = `${TUT_BASE}${String(i).padStart(4, '0')}`;
      tutorialRows.push({
        ID: id,
        slug: `pr541-tut-${i}`,
        title: `#541 fixture ${i}`,
        status: 'ACTIVE',
      });
      // i=1..3 → niche; i=4..10 → mid
      const tag = i <= 3 ? TAG_NICHE : TAG_MID;
      linkRows.push({ tutorial_ID: id, tag_ID: tag });
    }
    await INSERT.into(Tutorials).entries(tutorialRows);
    await INSERT.into(TutorialTags).entries(linkRows);
  });

  it('returns the slugs of every tutorial linked to the renamed tag (niche tag)', async () => {
    const slugs = await resolveSlugsForTagRename(TAG_NICHE);
    expect(slugs.sort()).toEqual(['pr541-tut-1', 'pr541-tut-2', 'pr541-tut-3']);
  });

  it('returns the slugs of every tutorial linked to the renamed tag (mid tag, 7 tutorials)', async () => {
    const slugs = await resolveSlugsForTagRename(TAG_MID);
    expect(slugs.length).toBe(7);
    expect(slugs).toContain('pr541-tut-4');
    expect(slugs).toContain('pr541-tut-10');
  });

  it('returns empty array when the tag has no tutorial links', async () => {
    expect(await resolveSlugsForTagRename(TAG_EMPTY)).toEqual([]);
  });

  it('returns empty array when the tag does not exist (orphan or wrong ID)', async () => {
    expect(await resolveSlugsForTagRename('ffffffff-9999-9999-9999-999999999999')).toEqual([]);
  });
});
