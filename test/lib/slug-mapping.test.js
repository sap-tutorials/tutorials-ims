import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('slug-mapping', () => {

  describe('buildSlugMapping', () => {

    beforeAll(async () => {
      const { Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Tutorials).entries([
        { ID: 'slug-t1', legacyId: 5001, slug: 'setup-btp-account', title: 'Set Up Your BTP Account', status: 'ACTIVE' },
        { ID: 'slug-t2', legacyId: 5002, slug: null, title: 'No Slug Tutorial', status: 'ACTIVE' },
      ]);

      await INSERT.into(Missions).entries([
        { ID: 'slug-m1', legacyId: 24609, slug: 'developer-advocate-mission', title: 'Developer Advocate Mission' },
        { ID: 'slug-m2', legacyId: 24610, slug: null, title: 'No Slug Mission' },
      ]);

      await INSERT.into(CompletionPaths).entries([
        { ID: 'slug-p1', legacyId: 1001, slug: 'track-1-basics', name: 'Track 1: Basics', mission_ID: 'slug-m1' },
      ]);
    });

    it('returns flat array with only populated slug rows', async () => {
      const { buildSlugMapping } = await import('../../srv/lib/slug-mapping.js');
      const result = await buildSlugMapping();

      expect(result.flat).toHaveLength(3);
      expect(result.flat).toContainEqual({
        legacyId: 5001, slug: 'setup-btp-account', entityType: 'TUTORIAL', title: 'Set Up Your BTP Account'
      });
      expect(result.flat).toContainEqual({
        legacyId: 24609, slug: 'developer-advocate-mission', entityType: 'MISSION', title: 'Developer Advocate Mission'
      });
      expect(result.flat).toContainEqual({
        legacyId: 1001, slug: 'track-1-basics', entityType: 'PATH', title: 'Track 1: Basics'
      });
    });

    it('returns grouped format by entity type', async () => {
      const { buildSlugMapping } = await import('../../srv/lib/slug-mapping.js');
      const result = await buildSlugMapping();

      expect(result.grouped.tutorials).toHaveLength(1);
      expect(result.grouped.tutorials[0].slug).toBe('setup-btp-account');
      expect(result.grouped.missions).toHaveLength(1);
      expect(result.grouped.missions[0].slug).toBe('developer-advocate-mission');
      expect(result.grouped.paths).toHaveLength(1);
      expect(result.grouped.paths[0].slug).toBe('track-1-basics');
    });

    it('returns keyed format with composite keys', async () => {
      const { buildSlugMapping } = await import('../../srv/lib/slug-mapping.js');
      const result = await buildSlugMapping();

      expect(result.keyed).toContainEqual({
        compositeKey: 'TUTORIAL:5001', slug: 'setup-btp-account', title: 'Set Up Your BTP Account'
      });
      expect(result.keyed).toContainEqual({
        compositeKey: 'MISSION:24609', slug: 'developer-advocate-mission', title: 'Developer Advocate Mission'
      });
      expect(result.keyed).toContainEqual({
        compositeKey: 'PATH:1001', slug: 'track-1-basics', title: 'Track 1: Basics'
      });
    });

    it('excludes rows where legacyId is null', async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Tutorials).entries({
        ID: 'slug-t3', legacyId: null, slug: 'has-slug-no-legacy', title: 'No Legacy ID', status: 'ACTIVE'
      });

      const { buildSlugMapping } = await import('../../srv/lib/slug-mapping.js');
      const result = await buildSlugMapping();

      expect(result.flat).toHaveLength(3);
      expect(result.flat.find(r => r.slug === 'has-slug-no-legacy')).toBeUndefined();
    });
  });

  describe('findMissingSlugs', () => {

    beforeAll(async () => {
      const { CompletionPathItems } = cds.entities('com.sap.developers.ims');

      await INSERT.into(CompletionPathItems).entries([
        { ID: 'slug-cpi1', path_ID: 'slug-p1', taskLegacyId: 5001, taskType: 'TUTORIAL', itemOrder: 1 },
        { ID: 'slug-cpi2', path_ID: 'slug-p1', taskLegacyId: 5002, taskType: 'TUTORIAL', itemOrder: 2 },
        { ID: 'slug-cpi3', path_ID: 'slug-p1', taskLegacyId: 9999, taskType: 'CHECKPOINT', itemOrder: 3 },
      ]);
    });

    it('returns items whose referenced tutorial has no slug', async () => {
      const { findMissingSlugs } = await import('../../srv/lib/slug-mapping.js');
      const result = await findMissingSlugs();

      expect(result).toHaveLength(1);
      expect(result[0].taskLegacyId).toBe(5002);
      expect(result[0].taskType).toBe('TUTORIAL');
      expect(result[0].pathName).toBe('Track 1: Basics');
      expect(result[0].missionTitle).toBe('Developer Advocate Mission');
    });

    it('does not include non-TUTORIAL items', async () => {
      const { findMissingSlugs } = await import('../../srv/lib/slug-mapping.js');
      const result = await findMissingSlugs();

      expect(result.find(r => r.taskLegacyId === 9999)).toBeUndefined();
    });
  });
});
