// test/admin-slug-derivation.test.js
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const TAG_ID = 'aaaaaaaa-2222-0000-0000-000000000001';

describe('AdminService: slug auto-derivation for Missions and Groups', () => {
  const cleanup = [];

  beforeAll(async () => {
    const { Tags } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 92001, name: '__TEST__ Slug Tag' });
  });

  afterAll(async () => {
    for (const url of cleanup) {
      await project.delete(url, adminAuth).catch(() => {});
    }
  });

  // Create draft, attach tag (required by SAVE validator), activate.
  const createAndActivate = async (entity, body) => {
    const fullBody = {
      description: 'auto',
      experienceTag: 'beginner',
      primaryTagRef_ID: TAG_ID,
      ...body,
    };
    const created = await project.post(`/admin/${entity}`, fullBody, {
      ...adminAuth,
      headers: { Prefer: 'handling=lenient' },
    });
    expect(created.status).toBe(201);
    const ID = created.data.ID;

    // Attach the seeded tag to satisfy the "at least one Tag" SAVE validator.
    await project.post(
      `/admin/${entity}(ID=${ID},IsActiveEntity=false)/tags`,
      { tag_ID: TAG_ID },
      adminAuth,
    );

    // Activate the draft.
    const activated = await project.post(
      `/admin/${entity}(ID=${ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {},
      adminAuth,
    );
    expect([200, 201]).toContain(activated.status);
    cleanup.push(`/admin/${entity}(ID=${ID},IsActiveEntity=true)`);
    return activated.data;
  };

  describe('Missions', () => {
    it('derives slug from title on create+activate', async () => {
      const m = await createAndActivate('Missions', { title: '__TEST__ Build a CAP App' });
      expect(m.slug).toBe('test-build-a-cap-app');
    });

    it('handles diacritics and the German eszett', async () => {
      const m = await createAndActivate('Missions', {
        title: '__TEST__ Schöne Beginnerstraße',
      });
      // ö → o (NFKD), ß → ss (transliteration)
      expect(m.slug).toBe('test-schone-beginnerstrasse');
    });

    it('appends -2 on slug collision against active rows', async () => {
      const a = await createAndActivate('Missions', { title: '__TEST__ Collide Mission' });
      const b = await createAndActivate('Missions', { title: '__TEST__ Collide Mission' });
      expect(a.slug).toBe('test-collide-mission');
      expect(b.slug).toBe('test-collide-mission-2');
    });
  });

  describe('Groups', () => {
    it('derives slug from title on create+activate', async () => {
      const g = await createAndActivate('Groups', { title: '__TEST__ Test Group Single' });
      expect(g.slug).toBe('test-test-group-single');
    });

    it('Groups slug namespace is independent from Missions', async () => {
      // Same title in both tables should not collide — namespaces differ in URL.
      const m = await createAndActivate('Missions', { title: '__TEST__ Shared Title' });
      const g = await createAndActivate('Groups',   { title: '__TEST__ Shared Title' });
      expect(m.slug).toBe('test-shared-title');
      expect(g.slug).toBe('test-shared-title');
    });
  });

  it('NEW (draft create) populates slug immediately so the admin sees it', async () => {
    // Without activating — confirms the visible draft has a slug already.
    const draft = await project.post(
      '/admin/Groups',
      { title: '__TEST__ Visible Draft Slug' },
      { ...adminAuth, headers: { Prefer: 'handling=lenient' } },
    );
    expect(draft.status).toBe(201);
    expect(draft.data.slug).toBe('test-visible-draft-slug');
    cleanup.push(`/admin/Groups(ID=${draft.data.ID},IsActiveEntity=false)`);
  });
});
