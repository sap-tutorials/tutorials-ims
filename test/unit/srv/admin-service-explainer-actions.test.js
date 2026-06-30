import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cds from '@sap/cds';

const CDS = readFileSync(join(import.meta.dirname, '../../../srv/admin-service.cds'), 'utf8');

describe('srv/admin-service.cds — explainer-generation actions (issue #759 PR 3a)', () => {
  it('declares generateVerbExplainers with ids array + mode string', () => {
    expect(CDS).toMatch(/action\s+generateVerbExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('declares generateShelfExplainers with the same signature', () => {
    expect(CDS).toMatch(/action\s+generateShelfExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('declares generateShelfEntryExplainers with the same signature', () => {
    expect(CDS).toMatch(/action\s+generateShelfEntryExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('all three return { processed: Integer; skipped: Integer; cost: String }', () => {
    for (const action of ['generateVerbExplainers', 'generateShelfExplainers', 'generateShelfEntryExplainers']) {
      const re = new RegExp(`${action}[\\s\\S]{0,500}returns\\s+ExplainerActionResult`);
      expect(CDS, action).toMatch(re);
    }
    expect(CDS).toMatch(/type\s+ExplainerActionResult\s*:\s*\{[\s\S]{0,200}processed\s*:\s*Integer;[\s\S]{0,200}skipped\s*:\s*Integer;[\s\S]{0,200}cost\s*:\s*String;[\s\S]{0,50}\}/);
  });
});

// ---------------------------------------------------------------------------
// Handler-behavior tests — use the explainer-generator's test injection hook
// (globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__) to bypass real AI Core.
// Standard vi.mock approaches do not work here because cds.test('serve')'s
// loader pre-resolves admin-service.js (and its transitive imports) before
// vitest can install mock interceptors. See the explainer-generator.js
// comment block on the hook for the full rationale.
// ---------------------------------------------------------------------------

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService.generate*Explainers — action handlers (#759 PR 3a)', () => {
  const project = cds.test('serve', '--project', '.', '--in-memory');
  const testImpl = vi.fn();

  beforeAll(async () => {
    await project;
    globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__ = testImpl;
  });

  afterAll(() => {
    delete globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__;
  });

  beforeEach(async () => {
    testImpl.mockReset();
    testImpl.mockResolvedValue({
      tagline: 'Mocked tagline',
      whyItMatters: 'Mocked whyItMatters.',
      costCents: 15,
    });
    // Reset Verb / Shelf / Shelf-entry tables to a known state
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.HomepageShelves'));
    // Trigger auto-init by reading via AdminService projection.
    await project.get('/admin/VerbDefinitions',  ADMIN_AUTH);
    await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
  });

  describe('fill-blanks mode', () => {
    it('VerbDefinitions: processes all 6 BLANK rows, returns processed=6', async () => {
      const res = await project.post('/admin/generateVerbExplainers',
        { ids: [], mode: 'fill-blanks' }, ADMIN_AUTH);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(6);
      expect(res.data.skipped).toBe(0);
      expect(res.data.cost).toMatch(/^\$\d+\.\d{2}$/);
    });

    it('VerbDefinitions: skips AI_SEEDED and REVIEWED rows', async () => {
      const db = await cds.connect.to('db');
      await db.run(UPDATE('com.sap.developers.ims.VerbDefinitions')
        .set({ authoringStatus: 'AI_SEEDED' })
        .where({ verbKey: 'LEARN' }));
      await db.run(UPDATE('com.sap.developers.ims.VerbDefinitions')
        .set({ authoringStatus: 'REVIEWED' })
        .where({ verbKey: 'BUILD' }));
      const res = await project.post('/admin/generateVerbExplainers',
        { ids: [], mode: 'fill-blanks' }, ADMIN_AUTH);
      expect(res.data.processed).toBe(4); // LEARN + BUILD untouched; 4 BLANK rows processed
    });
  });

  describe('regenerate-selected mode', () => {
    it('ShelfDefinitions: processes only the specified ids', async () => {
      const db = await cds.connect.to('db');
      const rows = await db.run(SELECT.from('com.sap.developers.ims.ShelfDefinitions').columns('ID'));
      const twoIds = [rows[0].ID, rows[1].ID];
      const res = await project.post('/admin/generateShelfExplainers',
        { ids: twoIds, mode: 'regenerate-selected' }, ADMIN_AUTH);
      expect(res.data.processed).toBe(2);
    });

    it('ShelfDefinitions: overwrites REVIEWED status (admin explicit-intent)', async () => {
      const db = await cds.connect.to('db');
      const rows = await db.run(SELECT.from('com.sap.developers.ims.ShelfDefinitions').columns('ID', 'shelfKey'));
      const reviewed = rows[0];
      await db.run(UPDATE('com.sap.developers.ims.ShelfDefinitions')
        .set({ authoringStatus: 'REVIEWED' })
        .where({ ID: reviewed.ID }));
      const res = await project.post('/admin/generateShelfExplainers',
        { ids: [reviewed.ID], mode: 'regenerate-selected' }, ADMIN_AUTH);
      expect(res.data.processed).toBe(1);
      const after = await db.run(SELECT.one.from('com.sap.developers.ims.ShelfDefinitions')
        .where({ ID: reviewed.ID }));
      expect(after.authoringStatus).toBe('AI_SEEDED');
    });
  });

  describe('100-row cap', () => {
    it('returns HTTP 400 CAP_EXCEEDED when ids.length > 100', async () => {
      const tooManyIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);
      const res = await project.post('/admin/generateShelfEntryExplainers',
        { ids: tooManyIds, mode: 'regenerate-selected' }, ADMIN_AUTH)
        .catch(err => err.response); // CAP throws on non-2xx; capture response
      expect(res.status).toBe(400);
      expect(res.data.error?.message ?? res.data.message ?? '').toMatch(/CAP_EXCEEDED|exceeded/i);
    });
  });

  describe('kill-switch', () => {
    it('returns HTTP 503 when AICORE_EXPLAINER_GENERATOR_DISABLED=true', async () => {
      process.env.AICORE_EXPLAINER_GENERATOR_DISABLED = 'true';
      try {
        const res = await project.post('/admin/generateVerbExplainers',
          { ids: [], mode: 'fill-blanks' }, ADMIN_AUTH)
          .catch(err => err.response);
        expect(res.status).toBe(503);
      } finally {
        delete process.env.AICORE_EXPLAINER_GENERATOR_DISABLED;
      }
    });
  });
});

describe('AdminService — bulk Mark-reviewed actions (issue #790)', () => {
  const project = cds.test('serve', '--project', '.', '--in-memory');

  beforeAll(async () => { await project; });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    // Wipe before each test so our explicit fixture is the only state.
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.HomepageShelves'));
    // Seed three VerbDefinitions rows: one BLANK, one AI_SEEDED, one REVIEWED.
    await db.run(INSERT.into('com.sap.developers.ims.VerbDefinitions').entries([
      { ID: '11111111-1111-1111-1111-111111111111', verbKey: 'LEARN',     label: 'L', authoringStatus: 'BLANK'     },
      { ID: '22222222-2222-2222-2222-222222222222', verbKey: 'BUILD',     label: 'B', authoringStatus: 'AI_SEEDED' },
      { ID: '33333333-3333-3333-3333-333333333333', verbKey: 'INTEGRATE', label: 'I', authoringStatus: 'REVIEWED'  },
    ]));
  });

  it('flips only AI_SEEDED rows to REVIEWED, skipping BLANK and REVIEWED', async () => {
    const db = await cds.connect.to('db');
    const res = await project.post('/admin/bulkMarkVerbExplainerReviewed', {
      ids: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ],
    }, ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(res.data.processed).toBe(1);
    expect(res.data.skipped).toBe(2);
    expect(res.data.cost).toBe('$0.00');

    const rows = await db.run(SELECT.from('com.sap.developers.ims.VerbDefinitions').orderBy('verbKey'));
    const status = Object.fromEntries(rows.map(r => [r.verbKey, r.authoringStatus]));
    expect(status).toEqual({ BUILD: 'REVIEWED', INTEGRATE: 'REVIEWED', LEARN: 'BLANK' });
  });

  it('returns processed=0 when ids array is empty', async () => {
    const res = await project.post('/admin/bulkMarkVerbExplainerReviewed', { ids: [] }, ADMIN_AUTH);
    expect(res.data.processed).toBe(0);
    expect(res.data.skipped).toBe(0);
  });

  it('counts unknown UUIDs as skipped (rows not found in DB)', async () => {
    const res = await project.post('/admin/bulkMarkVerbExplainerReviewed', {
      ids: ['ffffffff-ffff-ffff-ffff-ffffffffffff'],
    }, ADMIN_AUTH);
    expect(res.data.processed).toBe(0);
    expect(res.data.skipped).toBe(1);
  });

  it('routes to ShelfDefinitions for bulkMarkShelfExplainerReviewed', async () => {
    const db = await cds.connect.to('db');
    await db.run(INSERT.into('com.sap.developers.ims.ShelfDefinitions').entries([
      { ID: '44444444-4444-4444-4444-444444444444', shelfKey: 'START_HERE', label: 'S', authoringStatus: 'AI_SEEDED' },
    ]));
    const res = await project.post('/admin/bulkMarkShelfExplainerReviewed', {
      ids: ['44444444-4444-4444-4444-444444444444'],
    }, ADMIN_AUTH);
    expect(res.data.processed).toBe(1);
  });

  it('routes to HomepageShelves for bulkMarkShelfEntryExplainerReviewed', async () => {
    const db = await cds.connect.to('db');
    const ID = '55555555-5555-5555-5555-555555555555';
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries([
      { ID, verb: 'LEARN', shelf: 'START_HERE',
        title: 'Bulk-790 unit', url: 'https://example.com/790-unit',
        sortOrder: 1, authoringStatus: 'AI_SEEDED' },
    ]));
    const res = await project.post('/admin/bulkMarkShelfEntryExplainerReviewed', { ids: [ID] }, ADMIN_AUTH);
    expect(res.data.processed).toBe(1);
  });
});
