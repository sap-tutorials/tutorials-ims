import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const devAuth = { auth: { username: 'developer', password: 'developer' } };

describe('AdminService', () => {

  describe('Authorization', () => {
    it('rejects non-admin users', async () => {
      const { status } = await project.get('/admin/Users', {
        ...devAuth, validateStatus: () => true
      });
      expect(status).toBe(403);
    });

    it('allows admin users', async () => {
      const { status } = await project.get('/admin/Users', adminAuth);
      expect(status).toBe(200);
    });
  });

  describe('CRUD Operations', () => {
    it('creates and reads an event', async () => {
      const event = {
        name: 'TechEd 2026',
        startDate: '2026-10-01T08:00:00Z',
        endDate: '2026-10-03T18:00:00Z',
        timeZone: '+02:00'
      };
      const { status, data } = await project.post('/admin/Events', event, adminAuth);
      expect(status).toBe(201);
      expect(data.name).toBe('TechEd 2026');
      expect(data.ID).toBeDefined();

      const { data: fetched } = await project.get(`/admin/Events(ID=${data.ID},IsActiveEntity=${data.IsActiveEntity})`, adminAuth);
      expect(fetched.name).toBe('TechEd 2026');
    });

    it('lists tutorials', async () => {
      const { status, data } = await project.get('/admin/Tutorials', adminAuth);
      expect(status).toBe(200);
      expect(data.value).toBeDefined();
    });

    it('reads the Tasks union view', async () => {
      const { status, data } = await project.get('/admin/Tasks', adminAuth);
      expect(status).toBe(200);
      expect(data.value).toBeDefined();
    });
  });

  describe('Event Statistics', () => {
    let eventLegacyId;

    beforeAll(async () => {
      const { Events, Users, TaskRecords } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Events).entries({
        ID: 'eeeeeeee-0000-0000-0000-000000000001',
        name: 'Stats Test Event',
        startDate: '2026-03-01T00:00:00Z',
        endDate: '2026-03-05T23:59:59Z',
        timeZone: '+00:00',
        legacyId: 9001
      });
      eventLegacyId = 9001;

      await INSERT.into(Users).entries([
        { ID: 'dddddddd-0000-0000-0000-000000000001', uuid: 'stats-u1', legacyId: 6001, displayName: 'Alice' },
        { ID: 'dddddddd-0000-0000-0000-000000000002', uuid: 'stats-u2', legacyId: 6002, displayName: 'Bob' },
      ]);

      await INSERT.into(TaskRecords).entries([
        { user_ID: 'dddddddd-0000-0000-0000-000000000001', taskLegacyId: 100, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'eeeeeeee-0000-0000-0000-000000000001', completionDate: '2026-03-01T10:00:00Z', completionTime: 600, titleSnapshot: 'Tutorial A', legacyId: 7001 },
        { user_ID: 'dddddddd-0000-0000-0000-000000000001', taskLegacyId: 200, taskType: 'MISSION', status: 'COMPLETED', event_ID: 'eeeeeeee-0000-0000-0000-000000000001', completionDate: '2026-03-02T14:00:00Z', completionTime: 1200, titleSnapshot: 'Mission A', legacyId: 7002 },
        { user_ID: 'dddddddd-0000-0000-0000-000000000002', taskLegacyId: 100, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'eeeeeeee-0000-0000-0000-000000000001', completionDate: '2026-03-01T15:00:00Z', completionTime: 900, titleSnapshot: 'Tutorial A', legacyId: 7003 },
      ]);
    });

    it('getEventStatistics returns counts', async () => {
      const { data } = await project.get(
        `/admin/getEventStatistics(eventLegacyId=${eventLegacyId})`, adminAuth
      );
      expect(data.tutorials).toBe(2);
      expect(data.missions).toBe(1);
      expect(data.uniqueUsers).toBe(2);
    });

    it('getEventBurnup returns daily burnup', async () => {
      const { data } = await project.get(
        `/admin/getEventBurnup(eventLegacyId=${eventLegacyId})`, adminAuth
      );
      expect(data.value.length).toBeGreaterThan(0);
      expect(data.value[0]).toHaveProperty('day');
      expect(data.value[0]).toHaveProperty('cumulative');
    });

    it('exportTaskRecords returns CSV', async () => {
      const { data } = await project.get(
        `/admin/exportTaskRecords(eventLegacyId=${eventLegacyId},format='csv')`, adminAuth
      );
      expect(data.value).toContain('DATE & TIME,TYPE,TITLE,TIME SPENT');
      expect(data.value).toContain('TUTORIAL');
    });
  });

  describe('GDPR Anonymization', () => {
    beforeAll(async () => {
      const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Users).entries({
        ID: 'ffffffff-0000-0000-0000-000000000001',
        uuid: 'gdpr-test-user',
        sapId: 'S9999999',
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        displayName: 'Jane Smith',
        legacyId: 8001
      });
      await INSERT.into(UserMetaData).entries([
        { user_ID: 'ffffffff-0000-0000-0000-000000000001', key: 'pref1', value: 'val1', legacyId: 8101 },
        { user_ID: 'ffffffff-0000-0000-0000-000000000001', key: 'pref2', value: 'val2', legacyId: 8102 },
      ]);
    });

    it('anonymizeUser blanks PII and deletes metadata', async () => {
      const { status } = await project.post('/admin/anonymizeUser',
        { sapId: 'S9999999' }, adminAuth);
      expect(status).toBe(204);

      const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
      const user = await SELECT.one.from(Users, 'ffffffff-0000-0000-0000-000000000001');
      expect(user.sapId).toBeNull();
      expect(user.firstName).toBe('ANONYMIZED');
      expect(user.email).toBeNull();

      const meta = await SELECT.from(UserMetaData).where({ user_ID: user.ID });
      expect(meta.length).toBe(0);
    });
  });

  describe('Cleanup Actions', () => {
    beforeAll(async () => {
      const { StepFailures } = cds.entities('com.sap.developers.ims');
      const old = new Date(Date.now() - 100 * 86400000).toISOString();
      const recent = new Date().toISOString();
      await INSERT.into(StepFailures).entries([
        { failureDate: old, stepNumber: 1, errorMessage: 'old failure', legacyId: 9901 },
        { failureDate: recent, stepNumber: 2, errorMessage: 'recent failure', legacyId: 9902 },
      ]);
    });

    it('cleanupStepFailures removes old records', async () => {
      const { status } = await project.post('/admin/cleanupStepFailures',
        { olderThanDays: 90 }, adminAuth);
      expect(status).toBe(204);

      const { StepFailures } = cds.entities('com.sap.developers.ims');
      const remaining = await SELECT.from(StepFailures);
      expect(remaining.length).toBe(1);
      expect(remaining[0].errorMessage).toBe('recent failure');
    });
  });

  describe('Featured Tasks', () => {
    it('setFeaturedOrder creates new featured entry', async () => {
      const { status } = await project.post('/admin/setFeaturedOrder',
        { taskLegacyId: 100, taskType: 'TUTORIAL', featuredOrder: 1 }, adminAuth);
      expect(status).toBe(204);

      const { FeaturedTasks } = cds.entities('com.sap.developers.ims');
      const feat = await SELECT.one.from(FeaturedTasks).where({ taskLegacyId: 100 });
      expect(feat.featuredOrder).toBe(1);
    });

    it('setFeaturedOrder updates existing entry', async () => {
      await project.post('/admin/setFeaturedOrder',
        { taskLegacyId: 100, taskType: 'TUTORIAL', featuredOrder: 5 }, adminAuth);

      const { FeaturedTasks } = cds.entities('com.sap.developers.ims');
      const feat = await SELECT.one.from(FeaturedTasks).where({ taskLegacyId: 100 });
      expect(feat.featuredOrder).toBe(5);
    });
  });

  describe('Integration Actions', () => {
    it('sendToNgds returns 404 for non-existent task record', async () => {
      const { status } = await project.post('/admin/sendToNgds',
        { taskRecordLegacyId: 1 },
        { ...adminAuth, validateStatus: () => true });
      expect(status).toBe(404);
    });
  });

  describe('exportMissionCompletions', () => {
    beforeAll(async () => {
      const { Users, TaskRecords, Missions } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Users).entries({
        ID: 'cccccccc-0000-0000-0000-000000000001', uuid: 'export-user',
        legacyId: 5001, displayName: 'Export User', email: 'export@test.com'
      });

      await INSERT.into(Missions).entries({
        ID: 'cccccccc-m001', legacyId: 55001, title: 'Export Mission'
      });

      await INSERT.into(TaskRecords).entries([
        {
          user_ID: 'cccccccc-0000-0000-0000-000000000001',
          taskLegacyId: 55001, taskType: 'MISSION', status: 'COMPLETED',
          completionDate: '2026-06-15T10:00:00Z',
          modifiedAt: '2026-07-01T10:00:00Z',
          legacyId: 5501
        },
        {
          user_ID: 'cccccccc-0000-0000-0000-000000000001',
          taskLegacyId: 55001, taskType: 'MISSION', status: 'COMPLETED',
          completionDate: '2026-08-01T10:00:00Z',
          modifiedAt: '2026-06-15T10:00:00Z',
          legacyId: 5502
        },
      ]);
    });

    it('filters by completionDate, not modifiedAt', async () => {
      const { data } = await project.get(
        `/admin/exportMissionCompletions(startDate=2026-06-01T00:00:00Z,endDate=2026-06-30T23:59:59Z)`,
        adminAuth
      );
      // Record 5501 has completionDate in June (included)
      // Record 5502 has modifiedAt in June but completionDate in August (excluded)
      const lines = data.value.split('\n').filter(l => l.length > 0);
      // Header + exactly 1 data row
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain('Export Mission');
    });
  });

  describe('findMissingSlugs', () => {
    beforeAll(async () => {
      const { Tutorials, Missions, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Missions).entries({
        ID: 'ms-m1', legacyId: 88001, slug: 'ms-mission', title: 'Missing Slugs Mission'
      });
      await INSERT.into(CompletionPaths).entries({
        ID: 'ms-p1', legacyId: 88101, slug: 'ms-path', name: 'MS Path', mission_ID: 'ms-m1'
      });
      await INSERT.into(Tutorials).entries([
        { ID: 'ms-t1', legacyId: 88201, slug: 'has-slug', title: 'Has Slug', status: 'ACTIVE' },
        { ID: 'ms-t2', legacyId: 88202, slug: null, title: 'Missing Slug', status: 'ACTIVE' },
      ]);
      await INSERT.into(CompletionPathItems).entries([
        { ID: 'ms-cpi1', path_ID: 'ms-p1', taskLegacyId: 88201, taskType: 'TUTORIAL', itemOrder: 1 },
        { ID: 'ms-cpi2', path_ID: 'ms-p1', taskLegacyId: 88202, taskType: 'TUTORIAL', itemOrder: 2 },
      ]);
    });

    it('requires admin auth', async () => {
      const { status } = await project.get(
        '/admin/findMissingSlugs()',
        { ...devAuth, validateStatus: () => true }
      );
      expect(status).toBe(403);
    });

    it('returns tutorials with missing slugs', async () => {
      const { data } = await project.get('/admin/findMissingSlugs()', adminAuth);
      // OData V4 wraps array returns in { value: [...] }
      const results = data.value || data;
      const missing = results.find(r => r.taskLegacyId === 88202);
      expect(missing).toBeDefined();
      expect(missing.taskType).toBe('TUTORIAL');
      expect(missing.pathName).toBe('MS Path');
      expect(missing.missionTitle).toBe('Missing Slugs Mission');
    });

    it('does not include tutorials that have slugs', async () => {
      const { data } = await project.get('/admin/findMissingSlugs()', adminAuth);
      const results = data.value || data;
      expect(results.find(r => r.taskLegacyId === 88201)).toBeUndefined();
    });
  });

  describe('Tutorials soft-delete and redirect', () => {
    let activeId, inactiveId;

    beforeAll(async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      activeId = cds.utils.uuid();
      inactiveId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries([
        { ID: activeId, slug: 'sd-active', title: 'SD Active', status: 'ACTIVE' },
        { ID: inactiveId, slug: 'sd-inactive', title: 'SD Inactive', status: 'INACTIVE' },
      ]);
    });

    // Draft workflow helper: edit-active → patch-draft → activate.
    // Returns the draftActivate response so callers can assert on rejection or success.
    async function patchViaDraft(id, body) {
      await project.post(
        `/admin/Tutorials(ID=${id},IsActiveEntity=true)/AdminService.draftEdit`,
        {},
        { ...adminAuth, validateStatus: () => true }
      );
      await project.patch(
        `/admin/Tutorials(ID=${id},IsActiveEntity=false)`,
        body,
        { ...adminAuth, validateStatus: () => true }
      );
      return project.post(
        `/admin/Tutorials(ID=${id},IsActiveEntity=false)/AdminService.draftActivate`,
        {},
        { ...adminAuth, validateStatus: () => true }
      );
    }

    it('DELETE on Tutorials flips status to INACTIVE instead of removing the row', async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const tmpId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries({
        ID: tmpId, slug: 'sd-target', title: 'SD Target', status: 'ACTIVE'
      });

      const { status } = await project.delete(
        `/admin/Tutorials(ID=${tmpId},IsActiveEntity=true)`,
        adminAuth
      );
      expect([204, 200]).toContain(status);

      const [row] = await SELECT.from(Tutorials).where({ ID: tmpId }).columns('ID', 'status');
      expect(row).toBeDefined();
      expect(row.status).toBe('INACTIVE');
    });

    it('rejects redirectTo on an ACTIVE tutorial', async () => {
      const { status, data } = await patchViaDraft(activeId, { redirectTo_ID: inactiveId });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(data)).toMatch(/INACTIVE/i);
    });

    it('rejects redirectTo pointing to itself', async () => {
      const { status, data } = await patchViaDraft(inactiveId, { redirectTo_ID: inactiveId });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(data)).toMatch(/itself/i);
    });

    it('rejects redirectTo pointing to a non-existent tutorial', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000999';
      const { status } = await patchViaDraft(inactiveId, { redirectTo_ID: fakeId });
      expect(status).toBeGreaterThanOrEqual(400);
    });

    it('rejects redirectTo pointing to another INACTIVE tutorial', async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const otherInactiveId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries({
        ID: otherInactiveId, slug: 'sd-other-inactive', title: 'Other', status: 'INACTIVE'
      });

      const { status, data } = await patchViaDraft(inactiveId, { redirectTo_ID: otherInactiveId });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(data)).toMatch(/redirect target must be an active/i);
    });

    it('accepts redirectTo on an INACTIVE tutorial pointing to an ACTIVE one', async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const inactiveTarget = cds.utils.uuid();
      const activeTarget = cds.utils.uuid();
      await INSERT.into(Tutorials).entries([
        { ID: inactiveTarget, slug: 'sd-redir-src', title: 'Src', status: 'INACTIVE' },
        { ID: activeTarget, slug: 'sd-redir-dst', title: 'Dst', status: 'ACTIVE' },
      ]);

      const { status } = await patchViaDraft(inactiveTarget, { redirectTo_ID: activeTarget });
      expect([200, 201, 204]).toContain(status);

      const [row] = await SELECT.from(Tutorials).where({ ID: inactiveTarget }).columns('redirectTo_ID');
      expect(row.redirectTo_ID).toBe(activeTarget);
    });

    it('TutorialPickList exposes only ACTIVE tutorials', async () => {
      const { status, data } = await project.get('/admin/TutorialPickList', adminAuth);
      expect(status).toBe(200);
      const slugs = data.value.map(t => t.slug);
      expect(slugs).toContain('sd-active');
      expect(slugs).not.toContain('sd-inactive');
    });
  });

  describe('Tutorials enhancements (#95)', () => {
    let tutId;
    const slug = 'tut95-owner';
    const owner = 'Acme Owner';

    beforeAll(async () => {
      const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
      tutId = cds.utils.uuid();
      await INSERT.into(Tutorials).entries([
        { ID: tutId, slug, title: 'Tut 95', status: 'ACTIVE' },
      ]);
      await INSERT.into(TutorialMeta).entries([
        { ID: cds.utils.uuid(), tutorial_ID: tutId, owner, ownerEmail: 'acme@example.com' },
      ]);
    });

    it('exposes meta.owner via $expand on Tutorials', async () => {
      const { status, data } = await project.get(
        `/admin/Tutorials(ID=${tutId},IsActiveEntity=true)?$expand=meta($select=owner,ownerEmail)`,
        adminAuth
      );
      expect(status).toBe(200);
      expect(data.meta).toBeTruthy();
      expect(data.meta.owner).toBe(owner);
      expect(data.meta.ownerEmail).toBe('acme@example.com');
    });
  });
});
