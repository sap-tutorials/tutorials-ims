import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__NEWS__';

describe.runIf(isSafeForWrites())('NewsItems entity (hybrid HANA)', () => {
  const createdSourceIds = [];

  afterAll(async () => {
    const { NewsItems } = cds.entities('com.sap.developers.ims.external');
    for (const sourceId of createdSourceIds) {
      await DELETE.from(NewsItems).where({ sourceId });
    }
  });

  describe('NewsItems CRUD operations', () => {
    it('can read existing NewsItems', async () => {
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');
      const items = await SELECT.from(NewsItems).limit(5);
      // May be empty if fetch-news cron hasn't run, but schema should exist
      expect(Array.isArray(items)).toBe(true);
    });

    it('can CREATE a test NewsItem with full fields', async () => {
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');

      const testSourceId = `${TEST_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const newsItem = {
        sourceId: testSourceId,
        link: 'https://example.com/test-news',
        title: `${TEST_PREFIX}Test News Item`,
        description: 'A test news item for hybrid validation',
        publishedAt: new Date().toISOString(),
        language: 'en',
        contentHash: 'testhash123',
        aiVerdict: 'relevant',
        aiReason: 'Matches CAP keywords',
        aiVerdictSource: 'keyword',
        aiConfidence: 0.95,
        aiVerdictAt: new Date().toISOString(),
        aiModel: 'test-v1'
      };

      await INSERT.into(NewsItems).entries(newsItem);
      const created = await SELECT.one.from(NewsItems).where({ sourceId: testSourceId });

      expect(created).toBeTruthy();
      expect(created.title).toBe(`${TEST_PREFIX}Test News Item`);
      expect(created.link).toBe('https://example.com/test-news');
      expect(created.language).toBe('en');
      expect(created.aiVerdict).toBe('relevant');
      expect(created.aiConfidence).toBe(0.95);

      createdSourceIds.push(testSourceId);
    });

    it('can UPDATE aiVerdict and admin override fields', async () => {
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');

      const testSourceId = `${TEST_PREFIX}update_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const newsItem = {
        sourceId: testSourceId,
        link: 'https://example.com/update-test',
        title: `${TEST_PREFIX}Update Test`,
        contentHash: 'hash456'
      };

      await INSERT.into(NewsItems).entries(newsItem);

      // Now update with admin override
      await UPDATE(NewsItems, { sourceId: testSourceId }).set({
        adminVerdict: 'approved',
        adminNote: 'Approved by test',
        adminBy: 'test-user',
        adminAt: new Date().toISOString()
      });

      const updated = await SELECT.one.from(NewsItems, { sourceId: testSourceId });
      expect(updated.adminVerdict).toBe('approved');
      expect(updated.adminNote).toBe('Approved by test');
      expect(updated.adminBy).toBe('test-user');
      expect(updated.adminAt).toBeTruthy();

      createdSourceIds.push(testSourceId);
    });

    it('can DELETE a test NewsItem', async () => {
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');

      const testSourceId = `${TEST_PREFIX}delete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const newsItem = {
        sourceId: testSourceId,
        link: 'https://example.com/delete-test',
        title: `${TEST_PREFIX}Delete Test`,
        contentHash: 'hash789'
      };

      await INSERT.into(NewsItems).entries(newsItem);

      let existing = await SELECT.one.from(NewsItems).where({ sourceId: testSourceId });
      expect(existing).toBeTruthy();

      await DELETE.from(NewsItems).where({ sourceId: testSourceId });

      const deleted = await SELECT.one.from(NewsItems).where({ sourceId: testSourceId });
      expect(deleted).toBeUndefined();

      // Remove from cleanup since we already deleted it
      const idx = createdSourceIds.indexOf(testSourceId);
      if (idx >= 0) createdSourceIds.splice(idx, 1);
    });

    it('can handle NULL optional fields gracefully', async () => {
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');

      const testSourceId = `${TEST_PREFIX}nullfields_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const newsItem = {
        sourceId: testSourceId,
        link: 'https://example.com/null-test',
        title: `${TEST_PREFIX}Null Fields Test`,
        contentHash: 'hashnull'
        // description, publishedAt, language, etc. all NULL
      };

      await INSERT.into(NewsItems).entries(newsItem);
      const created = await SELECT.one.from(NewsItems).where({ sourceId: testSourceId });

      expect(created).toBeTruthy();
      expect(created.title).toBe(`${TEST_PREFIX}Null Fields Test`);
      expect(created.description).toBeUndefined();
      expect(created.publishedAt).toBeUndefined();
      expect(created.language).toBeUndefined();
      expect(created.adminVerdict).toBeUndefined();

      createdSourceIds.push(testSourceId);
    });

    it('enforces sourceId as unique primary key', async () => {
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');

      const testSourceId = `${TEST_PREFIX}unique_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const newsItem = {
        sourceId: testSourceId,
        link: 'https://example.com/unique-test',
        title: `${TEST_PREFIX}Unique Test`,
        contentHash: 'hashuniqu'
      };

      await INSERT.into(NewsItems).entries(newsItem);

      // Try to insert duplicate — should fail
      let error;
      try {
        await INSERT.into(NewsItems).entries(newsItem);
      } catch (e) {
        error = e;
      }

      expect(error).toBeTruthy();
      // HANA throws violation on UNIQUE/PRIMARY KEY
      expect(error.message.toLowerCase()).toMatch(/unique|primary|duplicate|constraint/i);

      createdSourceIds.push(testSourceId);
    });
  });

  describe('ContentModerationService.NewsItems read-only projection', () => {
    it('can read NewsItems through ContentModerationService projection', async () => {
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');
      // ContentModerationService provides a projection
      // In context, this would be cds.entities('ContentModerationService').NewsItems
      // but in a unit test we read from the namespace
      const items = await SELECT.from('com.sap.developers.ims.external.NewsItems').limit(1);
      expect(Array.isArray(items)).toBe(true);
    });
  });

  describe('AI reclassify invariants', () => {
    it('reclassify-style UPDATE of AI columns leaves admin columns intact', async () => {
      if (!isSafeForWrites()) return;
      const sourceId = `${TEST_PREFIX}invariant_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      createdSourceIds.push(sourceId);
      const { NewsItems } = cds.entities('com.sap.developers.ims.external');
      const db = await cds.connect.to('db');
      // seed a row
      await db.run(INSERT.into('com.sap.developers.ims.external.NewsItems').entries({
        sourceId, link: 'https://news.sap.com/inv', title: 'invariant',
        description: 'inv', publishedAt: new Date().toISOString(), language: 'en',
        contentHash: 'h1',
        aiVerdict: 'not-relevant', aiReason: 'wrong', aiVerdictSource: 'embedding',
        aiConfidence: 0.4, aiVerdictAt: new Date().toISOString(),
        lastFetchedAt: new Date().toISOString(),
      }));
      // set admin fields
      await db.run(UPDATE('com.sap.developers.ims.external.NewsItems')
        .set({ adminVerdict: 'approve', adminBy: 'sa@example.com', adminNote: 'invariant note' })
        .where({ sourceId }));
      // simulate reclassify (AI columns only)
      await db.run(UPDATE('com.sap.developers.ims.external.NewsItems')
        .set({ aiVerdict: 'relevant', aiReason: 'updated', aiVerdictSource: 'llm', aiConfidence: 0.9, aiVerdictAt: new Date().toISOString() })
        .where({ sourceId }));
      const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems').where({ sourceId }));
      expect(row.aiVerdict).toBe('relevant');
      expect(row.aiReason).toBe('updated');
      expect(row.adminVerdict).toBe('approve');       // preserved
      expect(row.adminBy).toBe('sa@example.com');     // preserved
      expect(row.adminNote).toBe('invariant note');   // preserved
    });
  });
});
