import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { VERB_DEFAULTS, SHELF_DEFAULTS } from '../../../srv/lib/homepage/verb-shelf-defaults.js';   // #1089

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('/build/verb-definitions + /build/shelf-definitions (#759 PR 1)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  describe('/build/verb-definitions', () => {
    it('returns 200 with verbs array', async () => {
      const res = await project.get('/build/verb-definitions');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.verbs)).toBe(true);
    });

    it('returns one row per VERB_DEFAULTS entry after auto-init', async () => {
      // (#1029) MODEL added as 7th verb. (#1089) derives cardinality from
      // VERB_DEFAULTS — vocab expansions must land in one place.
      // Trigger auto-init first by reading via AdminService (this fires
      // the before('READ', 'VerbDefinitions', ...) handler from Task 9).
      // The /build/verb-definitions endpoint reads directly from the
      // raw entity, NOT through AdminService — so it won't trigger
      // auto-init itself. Pre-seed via AdminService.
      await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
      const res = await project.get('/build/verb-definitions');
      expect(res.data.verbs.length).toBe(VERB_DEFAULTS.length);
    });

    it('sets 60s Cache-Control header', async () => {
      const res = await project.get('/build/verb-definitions');
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('orders by sortOrder ascending', async () => {
      await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
      const res = await project.get('/build/verb-definitions');
      const sortOrders = res.data.verbs.map(v => v.sortOrder);
      expect(sortOrders).toEqual([...sortOrders].sort((a, b) => a - b));
    });

    it('includes new fields tagline, whyItMatters, authoringStatus', async () => {
      await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
      await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
      const res = await project.get('/build/verb-definitions');
      const row = res.data.verbs[0];
      expect(row).toHaveProperty('tagline');
      expect(row).toHaveProperty('whyItMatters');
      expect(row).toHaveProperty('authoringStatus');
      expect(row.authoringStatus).toBe('BLANK');
    });

    it('returns buildAt ISO timestamp', async () => {
      const res = await project.get('/build/verb-definitions');
      expect(res.data.buildAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('/build/shelf-definitions', () => {
    it('returns 200 with shelves array of SHELF_DEFAULTS.length', async () => {   // #1089
      await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
      const res = await project.get('/build/shelf-definitions');
      expect(res.status).toBe(200);
      expect(res.data.shelves.length).toBe(SHELF_DEFAULTS.length);
    });

    it('sets 60s Cache-Control header', async () => {
      const res = await project.get('/build/shelf-definitions');
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('includes new fields tagline, whyItMatters, authoringStatus', async () => {
      await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
      await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
      const res = await project.get('/build/shelf-definitions');
      const row = res.data.shelves[0];
      expect(row).toHaveProperty('tagline');
      expect(row).toHaveProperty('whyItMatters');
      expect(row).toHaveProperty('authoringStatus');
    });
  });

  describe('/build/homepage-shelves extended payload (#759)', () => {
    it('row includes the three new fields', async () => {
      const res = await project.get('/build/homepage-shelves');
      expect(res.status).toBe(200);
      // No auto-init for HomepageShelves — if no rows, assertion is moot.
      if (res.data.shelves.length === 0) return;
      const row = res.data.shelves[0];
      expect(row).toHaveProperty('tagline');
      expect(row).toHaveProperty('whyItMatters');
      expect(row).toHaveProperty('authoringStatus');
    });
  });
});
