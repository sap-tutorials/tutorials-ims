import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const superAdminAuth = { auth: { username: 'superadmin', password: 'superadmin' } };
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Published Flag', () => {
  const missionId = '11111111-0000-0000-0000-000000000001';
  const unpublishedMissionId = '11111111-0000-0000-0000-000000000002';
  const missionForAdminTest = '11111111-0000-0000-0000-000000000003';
  const missionForFieldTest = '11111111-0000-0000-0000-000000000004';
  const groupId = '22222222-0000-0000-0000-000000000001';
  const unpublishedGroupId = '22222222-0000-0000-0000-000000000002';
  const groupForAdminTest = '22222222-0000-0000-0000-000000000003';

  beforeAll(async () => {
    const { Missions, Groups } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Missions).entries([
      { ID: missionId, legacyId: 90001, title: '__TEST__ Published Mission', slug: 'test-published', published: true },
      { ID: unpublishedMissionId, legacyId: 90002, title: '__TEST__ Unpublished Mission', slug: 'test-unpublished', published: false },
      { ID: missionForAdminTest, legacyId: 90003, title: '__TEST__ Admin Guard Mission', slug: 'test-admin-guard', published: true },
      { ID: missionForFieldTest, legacyId: 90004, title: '__TEST__ Field Control Mission', slug: 'test-field-control', published: true }
    ]);
    await INSERT.into(Groups).entries([
      { ID: groupId, legacyId: 90010, title: '__TEST__ Published Group', published: true },
      { ID: unpublishedGroupId, legacyId: 90011, title: '__TEST__ Unpublished Group', published: false },
      { ID: groupForAdminTest, legacyId: 90012, title: '__TEST__ Admin Guard Group', published: true }
    ]);
  });

  describe('Default Value', () => {
    it('missions default to published=true', async () => {
      const { Missions } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Missions).entries({
        ID: '11111111-0000-0000-0000-000000000099',
        legacyId: 90099, title: '__TEST__ Default Mission', slug: 'test-default'
      });
      const result = await SELECT.one.from(Missions).where({ ID: '11111111-0000-0000-0000-000000000099' });
      expect(result.published).toBe(true);
    });

    it('groups default to published=true', async () => {
      const { Groups } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Groups).entries({
        ID: '22222222-0000-0000-0000-000000000099',
        legacyId: 90098, title: '__TEST__ Default Group'
      });
      const result = await SELECT.one.from(Groups).where({ ID: '22222222-0000-0000-0000-000000000099' });
      expect(result.published).toBe(true);
    });
  });

  describe('Build Catalog Filtering', () => {
    it('excludes unpublished missions from /build/catalog', async () => {
      const { status, data } = await project.get('/build/catalog');
      expect(status).toBe(200);
      const slugs = data.missions.map(m => m.slug);
      expect(slugs).toContain('test-published');
      expect(slugs).not.toContain('test-unpublished');
    });
  });

  describe('SearchableItems View Filtering', () => {
    it('excludes unpublished missions and groups from SearchableItems', async () => {
      const { SearchableItems } = cds.entities('com.sap.developers.ims');
      const items = await SELECT.from(SearchableItems).where({ legacyId: { in: [90001, 90002, 90010, 90011] } });
      const legacyIds = items.map(i => i.legacyId);
      expect(legacyIds).toContain(90001);
      expect(legacyIds).not.toContain(90002);
      expect(legacyIds).toContain(90010);
      expect(legacyIds).not.toContain(90011);
    });
  });

  describe('Authorization Guard', () => {
    it('SuperAdmin can set published=false via draft', async () => {
      await project.post(
        `/admin/Missions(ID=${missionId},IsActiveEntity=true)/AdminService.draftEdit`,
        { PreserveChanges: true },
        superAdminAuth
      );
      const { status } = await project.patch(
        `/admin/Missions(ID=${missionId},IsActiveEntity=false)`,
        { published: false },
        superAdminAuth
      );
      expect(status).toBe(200);
      await project.post(
        `/admin/Missions(ID=${missionId},IsActiveEntity=false)/AdminService.draftActivate`,
        {}, superAdminAuth
      );
    });

    it('regular Admin is rejected when setting published=false via draft', async () => {
      await project.post(
        `/admin/Missions(ID=${missionForAdminTest},IsActiveEntity=true)/AdminService.draftEdit`,
        { PreserveChanges: true },
        adminAuth
      );
      const { status } = await project.patch(
        `/admin/Missions(ID=${missionForAdminTest},IsActiveEntity=false)`,
        { published: false },
        { ...adminAuth, validateStatus: () => true }
      );
      expect(status).toBe(403);
      await project.delete(
        `/admin/Missions(ID=${missionForAdminTest},IsActiveEntity=false)`,
        adminAuth
      ).catch(() => {});
    });

    it('regular Admin can patch other fields on a draft without triggering guard', async () => {
      await project.post(
        `/admin/Missions(ID=${missionForFieldTest},IsActiveEntity=true)/AdminService.draftEdit`,
        { PreserveChanges: true },
        adminAuth
      );
      const { status } = await project.patch(
        `/admin/Missions(ID=${missionForFieldTest},IsActiveEntity=false)`,
        { title: '__TEST__ Updated Title' },
        adminAuth
      );
      expect(status).toBe(200);
      await project.delete(
        `/admin/Missions(ID=${missionForFieldTest},IsActiveEntity=false)`,
        adminAuth
      ).catch(() => {});
    });

    it('regular Admin can activate a new draft (published stays default true)', async () => {
      const { data: draft } = await project.post('/admin/Missions', {
        title: '__TEST__ Admin Activate', slug: 'test-admin-activate'
      }, adminAuth);
      const { status } = await project.post(
        `/admin/Missions(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`,
        {},
        adminAuth
      );
      expect(status).toBe(201);
      await project.delete(`/admin/Missions(ID=${draft.ID},IsActiveEntity=true)`, adminAuth).catch(() => {});
    });

    it('SuperAdmin can set published=false on a group via draft', async () => {
      await project.post(
        `/admin/Groups(ID=${groupId},IsActiveEntity=true)/AdminService.draftEdit`,
        { PreserveChanges: true },
        superAdminAuth
      );
      const { status } = await project.patch(
        `/admin/Groups(ID=${groupId},IsActiveEntity=false)`,
        { published: false },
        superAdminAuth
      );
      expect(status).toBe(200);
      await project.post(
        `/admin/Groups(ID=${groupId},IsActiveEntity=false)/AdminService.draftActivate`,
        {}, superAdminAuth
      );
    });

    it('regular Admin is rejected when setting published on a group', async () => {
      await project.post(
        `/admin/Groups(ID=${groupForAdminTest},IsActiveEntity=true)/AdminService.draftEdit`,
        { PreserveChanges: true },
        adminAuth
      );
      const { status } = await project.patch(
        `/admin/Groups(ID=${groupForAdminTest},IsActiveEntity=false)`,
        { published: false },
        { ...adminAuth, validateStatus: () => true }
      );
      expect(status).toBe(403);
      await project.delete(
        `/admin/Groups(ID=${groupForAdminTest},IsActiveEntity=false)`,
        adminAuth
      ).catch(() => {});
    });
  });

  describe('Field Control', () => {
    it('returns publishedFieldControl=7 for SuperAdmin', async () => {
      const { data } = await project.get(
        `/admin/Missions(ID=${missionForFieldTest},IsActiveEntity=true)`,
        superAdminAuth
      );
      expect(data.publishedFieldControl).toBe(7);
    });

    it('returns publishedFieldControl=1 for regular Admin', async () => {
      const { data } = await project.get(
        `/admin/Missions(ID=${missionForFieldTest},IsActiveEntity=true)`,
        adminAuth
      );
      expect(data.publishedFieldControl).toBe(1);
    });

    it('returns publishedFieldControl on list queries', async () => {
      const { data } = await project.get('/admin/Missions?$filter=legacyId eq 90004', superAdminAuth);
      expect(data.value[0].publishedFieldControl).toBe(7);
    });
  });
});
