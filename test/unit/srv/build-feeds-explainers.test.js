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

  // (#1726) Link-health override must be effective at BAKE time, not only after
  // the nightly link-health job runs. An admin who pins linkStatusOverride=OK on
  // a false-BROKEN entry triggers a catalog rebuild; the baked linkStatus the
  // Hugo verb-page + directory-footer filters read must already reflect the
  // override, or the entry stays hidden until the next nightly run + rebuild.
  describe('/build/homepage-shelves applies linkStatusOverride (#1726)', () => {
    it('bakes the override into linkStatus so a BROKEN+override=OK row is visible', async () => {
      const id = cds.utils.uuid();
      await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
        ID: id, verb: 'BUILD', shelf: 'TOOLS', sortOrder: 1726,
        title: 'Override BROKEN→OK', url: 'https://override-1726.example',
        isActive: true, linkStatus: 'BROKEN', linkStatusOverride: 'OK',
      }));
      const res = await project.get('/build/homepage-shelves');
      expect(res.status).toBe(200);
      const row = res.data.shelves.find(r => r.ID === id);
      expect(row).toBeTruthy();
      // Effective status = override, so the Hugo `linkStatus != BROKEN` filter passes.
      expect(row.linkStatus).toBe('OK');
    });

    it('leaves linkStatus untouched when no override is set', async () => {
      const id = cds.utils.uuid();
      await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
        ID: id, verb: 'BUILD', shelf: 'TOOLS', sortOrder: 1727,
        title: 'No override', url: 'https://no-override-1726.example',
        isActive: true, linkStatus: 'BROKEN',
      }));
      const res = await project.get('/build/homepage-shelves');
      const row = res.data.shelves.find(r => r.ID === id);
      expect(row.linkStatus).toBe('BROKEN');
    });
  });
});
