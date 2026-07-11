// test/unit/mcp-progress-tools.test.js
//
// Unit tests for DeveloperService authenticated MCP read tools:
//   get_my_tutorials, get_my_missions, get_my_events,
//   get_my_completed_steps, get_tutorial_step
//
// (#1105 Task 11)
//
// Auth pattern: basic-auth username becomes req.user.id, which resolveUserSapId
// falls back to as sapId. Seed Users with sapId == the basic-auth username.
//
// Fixture corrections vs brief:
//   - Users.sapId must match the basic-auth username string
//   - TaskRecords uses taskLegacyId (matches Tutorials.legacyId), taskType,
//     status — NOT tutorial_ID or completedSteps array
//   - ContentManifest.version is Integer; ContentFiles.content is LargeBinary
//     (field name: content, not contentGz); mimeType not contentType

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

const project = cds.test('serve', '--project', '.', '--in-memory');

const U1_SAPID = 'u1@ex.com';
const U2_SAPID = 'u2@ex.com';

// Basic-auth helpers (username = sapId → resolveUserSapId falls back to user.id)
const auth1 = { auth: { username: U1_SAPID, password: 'x' } };
const anonReq = {};

describe('DeveloperService authenticated MCP read tools', () => {
  beforeAll(async () => {
    const {
      Users, Tutorials, Steps, TaskRecords
    } = cds.entities('com.sap.developers.ims');

    // Users — sapId must match the basic-auth username.
    await INSERT.into(Users).entries([
      { ID: 'u1-id', sapId: U1_SAPID, uuid: 'uuid-u1', displayName: 'U1', email: U1_SAPID },
      { ID: 'u2-id', sapId: U2_SAPID, uuid: 'uuid-u2', displayName: 'U2', email: U2_SAPID },
    ]);

    // Tutorials — legacyId used as join key for TaskRecords.taskLegacyId.
    // stepCount exists on Tutorials (schema line 40); status is TaskStatus enum.
    await INSERT.into(Tutorials).entries([
      { ID: 't-a', slug: 'tut-a', title: 'A', legacyId: 1001, status: 'ACTIVE' },
      { ID: 't-b', slug: 'tut-b', title: 'B', legacyId: 1002, status: 'ACTIVE' },
      { ID: 't-c', slug: 'tut-c', title: 'C', legacyId: 1003, status: 'ACTIVE' },
    ]);

    // Steps for tut-a (for get_my_completed_steps test).
    // legacyId on Steps matches TaskRecords.taskLegacyId for STEP records.
    await INSERT.into(Steps).entries([
      { ID: 's-1', tutorial_ID: 't-a', stepOrder: 1, title: 'Step 1', legacyId: 2001, status: 'ACTIVE' },
      { ID: 's-2', tutorial_ID: 't-a', stepOrder: 2, title: 'Step 2', legacyId: 2002, status: 'ACTIVE' },
      { ID: 's-3', tutorial_ID: 't-a', stepOrder: 3, title: 'Step 3', legacyId: 2003, status: 'ACTIVE' },
    ]);

    // TaskRecords for get_my_tutorials:
    //   u1 has tut-a COMPLETED and tut-b IN_PROGRESS
    //   u2 has tut-a COMPLETED and tut-c IN_PROGRESS — neither should leak to
    //   u1. The u2 IN_PROGRESS row (tut-c) is the isolation tripwire: if the
    //   store dropped its user filter, u1's status='all'/'in_progress' calls
    //   would surface tut-c.
    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-1', user_ID: 'u1-id', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'COMPLETED', attemptNumber: 1 },
      { ID: 'tr-2', user_ID: 'u1-id', taskLegacyId: 1002, taskType: 'TUTORIAL', status: 'IN_PROGRESS', attemptNumber: 1 },
      { ID: 'tr-3', user_ID: 'u2-id', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'COMPLETED', attemptNumber: 1 },
      { ID: 'tr-4', user_ID: 'u2-id', taskLegacyId: 1003, taskType: 'TUTORIAL', status: 'IN_PROGRESS', attemptNumber: 1 },
      // STEP records for u1 on tut-a (all 3 steps completed)
      { ID: 'tr-s1', user_ID: 'u1-id', taskLegacyId: 2001, taskType: 'STEP', status: 'COMPLETED', attemptNumber: 1 },
      { ID: 'tr-s2', user_ID: 'u1-id', taskLegacyId: 2002, taskType: 'STEP', status: 'COMPLETED', attemptNumber: 1 },
      { ID: 'tr-s3', user_ID: 'u1-id', taskLegacyId: 2003, taskType: 'STEP', status: 'COMPLETED', attemptNumber: 1 },
    ]);
  });

  it('get_my_tutorials returns only the caller\'s rows, filtered by status', async () => {
    const { data } = await project.get(
      `/api/get_my_tutorials(status='in_progress',limit=10)`,
      auth1
    );
    // u1 has exactly one in_progress tutorial: tut-b. u2's in_progress tut-c
    // must NOT appear — asserting the slug (not just the count) makes a
    // dropped-user-filter leak fail here rather than pass silently.
    expect(data.value).toHaveLength(1);
    expect(data.value[0].slug).toBe('tut-b');
    expect(data.value[0].status).toBe('in_progress');
    expect(data.value.map(r => r.slug)).not.toContain('tut-c'); // u2's row must not leak
  });

  it('get_my_tutorials isolates users — status=all returns only u1 slugs', async () => {
    const { data } = await project.get(
      `/api/get_my_tutorials(status='all',limit=50)`,
      auth1
    );
    const slugs = data.value.map(r => r.slug).sort();
    // u1's two tutorials only. u2 also has tut-a (COMPLETED) + tut-c
    // (IN_PROGRESS); if the store's user filter regressed, tut-c would appear
    // and this would be length 3.
    expect(slugs).toEqual(['tut-a', 'tut-b']);
  });

  it('get_my_tutorials clamps limit to 50', async () => {
    const { data } = await project.get(
      `/api/get_my_tutorials(status='all',limit=9999)`,
      auth1
    );
    expect(data.value.length).toBeLessThanOrEqual(50);
  });

  it('get_my_tutorials rejects an unknown status with 400', async () => {
    await expect(
      project.get(`/api/get_my_tutorials(status='ohno',limit=10)`, auth1)
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('get_my_completed_steps returns completedSteps for the caller\'s tutorial', async () => {
    const { data } = await project.get(
      `/api/get_my_completed_steps(slug='tut-a')`,
      auth1
    );
    expect(data.completedSteps).toEqual([1, 2, 3]);
    expect(data.attemptNumber).toBe(1);
  });

  it('get_my_completed_steps returns empty array for a slug the caller has never started', async () => {
    const { data } = await project.get(
      `/api/get_my_completed_steps(slug='tut-c')`,
      auth1
    );
    // tut-c has no steps seeded, so store returns { slug, completedSteps: [], attemptNumber: 1 }
    expect(data.completedSteps).toEqual([]);
    expect(data.slug).toBe('tut-c');
  });

  it('get_tutorial_step (authenticated) returns per-step HTML', async () => {
    const { ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');
    const htmlContent = `
      <main class="tutorial-body">
        <section class="step" data-step-number="1"><h2 class="step-title">One</h2><p>step-one-body</p></section>
        <section class="step" data-step-number="2"><h2 class="step-title">Two</h2><p>step-two-body</p></section>
      </main>`;
    const gzBuf = gzipSync(Buffer.from(htmlContent));

    // version is Integer in the schema (ContentManifestAspect.key version : Integer)
    await INSERT.into(ContentManifest).entries({
      version: 9001, status: 'ACTIVE', publishedAt: new Date()
    });
    // ContentFiles.content is LargeBinary (not contentGz); mimeType not contentType
    await INSERT.into(ContentFiles).entries({
      version: 9001, slug: 'tut-a', content: gzBuf, mimeType: 'text/html'
    });

    // Must set KG_STEP_SLICER_ENABLED to not 'false' (default is enabled)
    delete process.env.KG_STEP_SLICER_ENABLED;

    const { data } = await project.get(
      `/api/get_tutorial_step(slug='tut-a',stepNumber=1)`,
      auth1
    );
    expect(data.html).toContain('step-one-body');
    expect(data.stepTitle).toBe('One');
    expect(data.totalSteps).toBe(2);
  });

  it('rejects anonymous callers with 401', async () => {
    await expect(
      project.get(`/api/get_my_tutorials(status='all',limit=10)`, anonReq)
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});
