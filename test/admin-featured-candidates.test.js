// test/admin-featured-candidates.test.js
// Task 4: FeaturedTaskCandidates union value-help view.
//
// Uses a single shared cds.test() at module top-level so that Task 5 (and
// later tasks) can add their own describe blocks to this same file without
// each one spinning up a competing CAP server. Per-describe beforeAll would
// race / conflict on the same port; top-level cds.test() is the project's
// established pattern for multi-describe test files (mirrors admin-service.test.js,
// admin-drafts.test.js).
//
// HTTP calls with adminAuth mirror the rest of the admin unit tests — AdminService
// has @requires so direct cds.connect.to('AdminService').run() returns 401;
// the mocked auth layer honours the basic-auth pairs in .cdsrc.json.
//
// No Tutorials/Missions/Groups seed CSVs exist in db/data/, so this describe
// inserts its own rows in beforeAll and reads them back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

// Stable legacy IDs chosen to be far from real data.
const TUTORIAL_LEGACY_ID = 990001;
const GROUP_LEGACY_ID    = 990002;
const MISSION_LEGACY_ID  = 990003;

describe('FeaturedTaskCandidates', () => {
  beforeAll(async () => {
    const { Tutorials, Groups, Missions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({
      legacyId: TUTORIAL_LEGACY_ID,
      title: '__TEST__ Candidate Tutorial',
      slug: 'test-candidate-tutorial',
      status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      legacyId: GROUP_LEGACY_ID,
      title: '__TEST__ Candidate Group',
      slug: 'test-candidate-group',
      published: true,
    });
    await INSERT.into(Missions).entries({
      legacyId: MISSION_LEGACY_ID,
      title: '__TEST__ Candidate Mission',
      slug: 'test-candidate-mission',
      published: true,
    });
  });

  afterAll(async () => {
    const { Tutorials, Groups, Missions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Tutorials).where({ legacyId: TUTORIAL_LEGACY_ID });
    await DELETE.from(Groups).where({ legacyId: GROUP_LEGACY_ID });
    await DELETE.from(Missions).where({ legacyId: MISSION_LEGACY_ID });
  });

  it('returns an array with the candidate shape for all three content types', async () => {
    const { status, data } = await project.get('/admin/FeaturedTaskCandidates', adminAuth);
    expect(status).toBe(200);
    const rows = data.value ?? [];
    expect(Array.isArray(rows)).toBe(true);
    // Shape check
    for (const r of rows) {
      expect(r).toHaveProperty('taskLegacyId');
      expect(r).toHaveProperty('taskType');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('slug');
    }
    // Our seeded rows must be present
    const legacyIds = rows.map(r => r.taskLegacyId);
    expect(legacyIds).toContain(TUTORIAL_LEGACY_ID);
    expect(legacyIds).toContain(GROUP_LEGACY_ID);
    expect(legacyIds).toContain(MISSION_LEGACY_ID);
    // All three task types represented
    const types = new Set(rows.map(r => r.taskType));
    expect(types.has('TUTORIAL')).toBe(true);
    expect(types.has('GROUP')).toBe(true);
    expect(types.has('MISSION')).toBe(true);
  });

  it('returns at least one row with each expected field non-null', async () => {
    const { data } = await project.get('/admin/FeaturedTaskCandidates', adminAuth);
    const rows = (data.value ?? []).filter(r =>
      [TUTORIAL_LEGACY_ID, GROUP_LEGACY_ID, MISSION_LEGACY_ID].includes(r.taskLegacyId)
    );
    for (const r of rows) {
      expect(r.taskLegacyId).toBeTruthy();
      expect(r.taskType).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.slug).toBeTruthy();
    }
  });

  it('honors a $filter on title', async () => {
    const term = '__TEST__';
    const { status, data } = await project.get(
      `/admin/FeaturedTaskCandidates?$filter=contains(title,'${encodeURIComponent(term)}')`,
      adminAuth
    );
    expect(status).toBe(200);
    const rows = data.value ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(3); // tutorial + group + mission
    for (const r of rows) {
      expect(r.title).toContain(term);
    }
  });
});
