// test/unit/developer-service-identity-reads.test.js
//
// TDD for #2730 (Task 2): all 9 bucket-A READ handlers in developer-service.js
// must resolve null-sapId identity-link users via resolveDbUserScoped (tiered:
// pin → (iss,sub) identity link → sapId). The old resolveUserSapId + sapId-only
// lookup returns null/empty for IAS/social/GitHub logins whose Users row has
// sapId = NULL. This test seeds one such user and asserts each handler returns
// the user's real data instead of the empty/zero fallback.
//
// Pattern: same as session-favorites-identity.test.js — a Users row with
// sapId=null + a matching UserIdentities row (issuer, subject). The cds.test
// harness serves the whole model in-memory so we can INSERT seed data and call
// the service actions directly via srv.tx.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';
const ISS = 'https://test-fake.ondemand.example';
const SUB = 'reads-sub-2730';
const EMAIL = 'reads-2730@x.example';
const ROLES = { 'authenticated-user': true, 'Tutorial.API': true };
const USER = {
  id: EMAIL,
  roles: ROLES,
  authInfo: { token: { payload: { iss: ISS, sub: SUB } } },
};

// Helper: send an action/event via srv.tx so req.user is set correctly.
const call = (srv, event, data = {}) =>
  srv.tx({ user: USER }, (tx) => tx.send({ event, data }));

describe('#2730 user-scoped reads resolve null-sapId identity-link users', () => {
  let srv;
  let uid;

  // Seed once: a null-sapId Users row + its (iss,sub) identity link + various
  // data rows that each handler needs in order to return real (non-empty) data.
  beforeAll(async () => {
    srv = await cds.connect.to('DeveloperService');

    const {
      Users,
      UserIdentities,
      UserLearningPreferences,
      TaskRecords,
      Missions,
      Events,
      CompletionPaths,
      CompletionPathItems,
      Tutorials,
    } = cds.entities(NS);

    uid = cds.utils.uuid();

    // 1. The null-sapId Users row (the regression subject)
    await INSERT.into(Users).entries({
      ID: uid,
      uuid: cds.utils.uuid(),
      sapId: null,
      email: EMAIL,
      legacyId: 812001,
      khorosId: 'khoros-test-42',
      khorosLogin: 'testuser-42',
      khorosAvatarUrl: '',
    });

    // 2. The (iss,sub) identity link that ties the JWT to the Users row
    await INSERT.into(UserIdentities).entries({
      ID: cds.utils.uuid(),
      user_ID: uid,
      issuer: ISS,
      subject: SUB,
      provider: 'ias',
      emailVerified: true,
      linkedAt: new Date().toISOString(),
    });

    // 3. LearningPreferences row — for before('READ','LearningPreferences')
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: uid,
      deployment: 'cloud',
      role: 'developer',
    });

    // 4. A MISSION TaskRecord (COMPLETED) — for countCompletedMissionsTotal,
    //    countCompletedMissionsPercent, findTaskProgressByUserAndTasksIds
    await INSERT.into(TaskRecords).entries({
      ID: cds.utils.uuid(),
      user_ID: uid,
      taskLegacyId: 99001,
      taskType: 'MISSION',
      status: 'COMPLETED',
      progress: 100,
      completionDate: new Date().toISOString(),
      legacyId: 50001,
    });

    // 5. A TUTORIAL TaskRecord (COMPLETED) — for TaskRecords before('READ'),
    //    findTaskProgressByUserAndTasksIds
    await INSERT.into(TaskRecords).entries({
      ID: cds.utils.uuid(),
      user_ID: uid,
      taskLegacyId: 99002,
      taskType: 'TUTORIAL',
      status: 'COMPLETED',
      progress: 100,
      completionDate: new Date().toISOString(),
      legacyId: 50002,
    });

    // 6. A Mission + Event + CompletionPath + CompletionPathItem + linked
    //    Tutorials entry — for getEventProgress and getAppSpaceProgress.
    const missionId = cds.utils.uuid();
    const eventId = cds.utils.uuid();
    const pathId = cds.utils.uuid();
    const tutorialId = cds.utils.uuid();

    await INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: 'identity-reads-test-tut',
      title: 'Identity Reads Test Tutorial',
      legacyId: 99003,
      stepCount: 1,
    });

    await INSERT.into(Missions).entries({
      ID: missionId,
      title: 'Identity Reads Test Mission',
      legacyId: 99010,
      missionType: 'SEQUENTIAL',
    });

    await INSERT.into(Events).entries({
      ID: eventId,
      name: 'Test Event 2730',
      legacyId: 99020,
      eventType: 'DEVTOBERFEST',
      startDate: new Date().toISOString(),
      mission_ID: missionId,
    });

    await INSERT.into(CompletionPaths).entries({
      ID: pathId,
      mission_ID: missionId,
      name: 'Test Path',
      legacyId: 99030,
    });

    await INSERT.into(CompletionPathItems).entries({
      ID: cds.utils.uuid(),
      path_ID: pathId,
      tutorial_ID: tutorialId,
      taskLegacyId: 99003,
      taskType: 'TUTORIAL',
      itemOrder: 1,
      legacyId: 99040,
    });

    // Also link the Event back to the Mission (bidirectional for getEventProgress)
    await UPDATE(Missions, missionId).set({ event_ID: eventId });
  });

  // ── Handler 1: before('READ', 'LearningPreferences') ──────────────────────
  it('LearningPreferences before(READ) scopes to the identity-link user (not empty)', async () => {
    const rows = await srv.tx({ user: USER }, (tx) =>
      tx.run(SELECT.from('DeveloperService.LearningPreferences'))
    );
    expect(rows.length).to.equal(1);
    expect(rows[0].deployment).to.equal('cloud');
  });

  // ── Handler 2: getProgress ─────────────────────────────────────────────────
  it('getProgress returns the user shape (resolves, does not 401/empty-by-miss)', async () => {
    // No tutorial seeded for a "known" slug → 404 is correct, but the handler
    // must get PAST user resolution (not reject 401 for null sapId).
    const res = await call(srv, 'getProgress', { slug: 'any-unknown-slug' }).catch((e) => e);
    // unknown slug → 404 is correct; the decisive check is NOT 401.
    expect(res?.code ?? 404).to.not.equal(401);
  });

  // ── Handler 3: findTaskProgressByUserAndTasksIds ───────────────────────────
  it('findTaskProgressByUserAndTasksIds returns the MISSION record (not empty array)', async () => {
    const res = await call(srv, 'findTaskProgressByUserAndTasksIds', {
      taskLegacyIds: [99001, 99002],
    });
    expect(Array.isArray(res)).to.equal(true);
    expect(res.length).to.be.greaterThan(0);
    const legacyIds = res.map((r) => r.taskLegacyId);
    expect(legacyIds).to.include(99001);
  });

  // ── Handler 4: countCompletedMissionsTotal ─────────────────────────────────
  it('countCompletedMissionsTotal returns > 0 (not zero) for null-sapId user', async () => {
    const res = await call(srv, 'countCompletedMissionsTotal', {});
    expect(res).to.be.greaterThan(0);
  });

  // ── Handler 5: countCompletedMissionsPercent ───────────────────────────────
  it('countCompletedMissionsPercent returns > 0 (not zero) for null-sapId user', async () => {
    const res = await call(srv, 'countCompletedMissionsPercent', {});
    // The seeded mission is the only MISSION record in the DB so percent == 1.0
    // (or some positive number). The decisive check: it is NOT 0.
    expect(res).to.be.greaterThan(0);
  });

  // ── Handler 6: getEventProgress ───────────────────────────────────────────
  it('getEventProgress returns paths (not 404) and scopes records to the user', async () => {
    const res = await call(srv, 'getEventProgress', { missionLegacyId: 99010 });
    expect(res).to.have.property('paths');
    expect(Array.isArray(res.paths)).to.equal(true);
    // At least one path was seeded.
    expect(res.paths.length).to.be.greaterThan(0);
  });

  // ── Handler 7: getAppSpaceProgress ────────────────────────────────────────
  it('getAppSpaceProgress returns `authenticated: true` for identity-link user (not false)', async () => {
    const res = await call(srv, 'getAppSpaceProgress', { eventLegacyId: 99020 });
    expect(res).to.have.property('authenticated');
    // Pre-fix: `Boolean(sapId)` → false when sapId is null.
    // Post-fix: `Boolean(dbUser)` → true when user resolved via identity link.
    expect(res.authenticated).to.equal(true);
  });

  // ── Handler 8: before('READ', 'TaskRecords') ──────────────────────────────
  it('TaskRecords before(READ) scopes to the identity-link user (not empty)', async () => {
    const rows = await srv.tx({ user: USER }, (tx) =>
      tx.run(SELECT.from('DeveloperService.TaskRecords'))
    );
    expect(rows.length).to.be.greaterThan(0);
    // Every row must belong to this user's ID.
    for (const row of rows) {
      expect(row.user_ID).to.equal(uid);
    }
  });

  // ── Handler 9: getKhorosProfile ───────────────────────────────────────────
  it('getKhorosProfile returns { linked: true } for null-sapId user with khorosId set', async () => {
    // The seeded Users row has khorosId='khoros-test-42'. Pre-fix the handler
    // would reject(401) on null sapId. Post-fix it resolves via identity link.
    const res = await call(srv, 'getKhorosProfile', {}).catch((e) => e);
    // Either { linked: true, ... } (khorosId found) or an upstream network miss
    // that falls back to { linked: true, rank: '' } — but NOT a 401.
    expect(res?.code ?? 200).to.not.equal(401);
    expect(res).to.have.property('linked', true);
  });
});
