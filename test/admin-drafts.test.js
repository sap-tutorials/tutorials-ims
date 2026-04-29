// test/admin-drafts.test.js
import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Draft Enablement', () => {
  const cleanup = [];

  afterAll(async () => {
    for (const url of cleanup) {
      await project.delete(url, adminAuth).catch(() => {});
    }
  });

  it('Missions supports draft creation', async () => {
    const { status, data } = await project.post('/admin/Missions', {
      title: '__TEST__ Draft Mission',
      slug: 'test-draft-mission'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(status).toBe(201);
    expect(data.IsActiveEntity).toBe(false);
    cleanup.push(`/admin/Missions(ID=${data.ID},IsActiveEntity=false)`);
  });

  it('Events supports draft creation', async () => {
    const { status, data } = await project.post('/admin/Events', {
      name: '__TEST__ Draft Event'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(status).toBe(201);
    expect(data.IsActiveEntity).toBe(false);
    cleanup.push(`/admin/Events(ID=${data.ID},IsActiveEntity=false)`);
  });

  it('Groups supports draft creation', async () => {
    const { status, data } = await project.post('/admin/Groups', {
      title: '__TEST__ Draft Group'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(status).toBe(201);
    expect(data.IsActiveEntity).toBe(false);
    cleanup.push(`/admin/Groups(ID=${data.ID},IsActiveEntity=false)`);
  });

  it('Accomplishments supports draft creation', async () => {
    const { status, data } = await project.post('/admin/Accomplishments', {
      name: '__TEST__ Draft Accomplishment'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(status).toBe(201);
    expect(data.IsActiveEntity).toBe(false);
    cleanup.push(`/admin/Accomplishments(ID=${data.ID},IsActiveEntity=false)`);
  });

  it('Tutorials does NOT support drafts', async () => {
    const { data } = await project.get('/admin/$metadata', adminAuth);
    // Tutorials should not have DraftAdministrativeData navigation
    const tutorialsSection = data.split('EntityType Name="Tutorials"')[1]?.split('</EntityType>')[0] ?? '';
    expect(tutorialsSection).not.toContain('DraftAdministrativeData');
  });

  describe('Draft Composition CRUD', () => {
    it('creates a mission with a completion path via draft', async () => {
      // Create draft mission
      const { data: mission } = await project.post('/admin/Missions', {
        title: '__TEST__ Comp Mission', slug: 'test-comp'
      }, adminAuth);

      // Add completion path to draft
      const { status, data: path } = await project.post(
        `/admin/Missions(ID=${mission.ID},IsActiveEntity=false)/completionPaths`,
        { name: '__TEST__ Path', slug: 'test-path' },
        adminAuth
      );
      expect(status).toBe(201);
      expect(path.name).toBe('__TEST__ Path');

      // Add item to path
      const { status: itemStatus } = await project.post(
        `/admin/CompletionPaths(ID=${path.ID},IsActiveEntity=false)/items`,
        { taskLegacyId: 999, taskType: 'TUTORIAL', itemOrder: 10 },
        adminAuth
      );
      expect(itemStatus).toBe(201);

      // Activate draft
      const { status: activateStatus } = await project.post(
        `/admin/Missions(ID=${mission.ID},IsActiveEntity=false)/AdminService.draftActivate`,
        {},
        adminAuth
      );
      expect(activateStatus).toBe(201);

      // Cleanup
      await project.delete(`/admin/Missions(ID=${mission.ID},IsActiveEntity=true)`, adminAuth);
    });
  });
});
