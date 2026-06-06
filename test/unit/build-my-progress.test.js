// test/unit/build-my-progress.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

vi.mock('../../srv/lib/user-progress.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getUserProgress: vi.fn(actual.getUserProgress)
  };
});

import { getUserProgress } from '../../srv/lib/user-progress.js';
import { myProgressHandler } from '../../srv/lib/my-progress-handler.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

const USER_UUID = 'mp-test-user-001';
const USER_ID = '00000000-0000-0000-0000-000000000aa1';

async function seed() {
  const { Users, Tutorials, Missions, CompletionPaths, TaskRecords } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords);
  await DELETE.from(Tutorials);
  await DELETE.from(Missions);
  await DELETE.from(CompletionPaths);
  await DELETE.from(Users);

  await INSERT.into(Users).entries({
    ID: USER_ID, uuid: USER_UUID, legacyId: 9101, firstName: 'X', lastName: 'Y', email: 'x@y'
  });
  await INSERT.into(Tutorials).entries([
    { ID: '11111111-0000-0000-0000-000000000a01', legacyId: 500, slug: 'done-tut',     title: 'Done Tut' },
    { ID: '11111111-0000-0000-0000-000000000a02', legacyId: 501, slug: 'inprog-tut',   title: 'In Progress Tut' },
    { ID: '11111111-0000-0000-0000-000000000a03', legacyId: 502, slug: 'zero-tut',     title: 'Zero Tut' }
  ]);
  await INSERT.into(Missions).entries([
    { ID: '22222222-0000-0000-0000-000000000a01', legacyId: 600, slug: 'done-mission', title: 'Done Mission' }
  ]);
  await INSERT.into(CompletionPaths).entries([
    { ID: '33333333-0000-0000-0000-000000000a01', legacyId: 700, slug: 'done-group', name: 'Done Group' }
  ]);
  await INSERT.into(TaskRecords).entries([
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a01', user_ID: USER_ID, taskLegacyId: 500, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100 },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a02', user_ID: USER_ID, taskLegacyId: 501, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 60, modifiedAt: '2026-05-20T10:00:00Z' },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a03', user_ID: USER_ID, taskLegacyId: 502, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 0,  modifiedAt: '2026-05-19T10:00:00Z' },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a04', user_ID: USER_ID, taskLegacyId: 600, taskType: 'MISSION',  status: 'COMPLETED', progress: 100 },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a05', user_ID: USER_ID, taskLegacyId: 700, taskType: 'GROUP',    status: 'COMPLETED', progress: 100 }
  ]);
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

describe('GET /build/my-progress handler', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    await seed();
  });

  it('returns empty-shape payload with 200 for anonymous user', async () => {
    const req = { user: { id: 'anonymous' } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      authenticated: false,
      tutorials: { completedSlugs: [], inProgress: [], lastCompletedSlug: null },
      missionSlugs: [],
      groupSlugs: []
    });
  });

  it('returns populated payload for signed-in user', async () => {
    const req = { user: { id: USER_UUID } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.tutorials.completedSlugs).toEqual(['done-tut']);
    expect(res.body.tutorials.lastCompletedSlug).toBe('done-tut');
    expect(res.body.tutorials.inProgress).toEqual([
      { slug: 'inprog-tut', progressPercent: 60 }
    ]);
    expect(res.body.missionSlugs).toEqual(['done-mission']);
    expect(res.body.groupSlugs).toEqual(['done-group']);
  });

  it('filters out inProgress entries with progressPercent === 0', async () => {
    const req = { user: { id: USER_UUID } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    const slugs = res.body.tutorials.inProgress.map(p => p.slug);
    expect(slugs).not.toContain('zero-tut');
  });

  it('returns empty-shape payload with 200 when getUserProgress throws', async () => {
    vi.mocked(getUserProgress).mockImplementationOnce(async () => { throw new Error('db down'); });
    const req = { user: { id: USER_UUID } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      authenticated: false,
      tutorials: { completedSlugs: [], inProgress: [], lastCompletedSlug: null },
      missionSlugs: [],
      groupSlugs: []
    });
  });
});
