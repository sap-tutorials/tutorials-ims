// test/unit/app-space-checkpoint-title.test.js
//
// Unit tests for app-space CHECKPOINT item title resolution (#<issue>).
//
// A CHECKPOINT completion path item with only a checkpointTitle field (no task
// record, no tutorial FK) should render its title from CompletionPathItems.checkpointTitle
// when calling getAppSpaceProgress or getEventProgress.
//
// Pattern: same as developer-service-identity-reads.test.js — seed an Event with
// a Mission + CompletionPath + CompletionPathItems (CHECKPOINT type). Call the
// handlers and assert the CHECKPOINT item's title resolves from checkpointTitle.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';
const ISS = 'https://test-checkpoint.ondemand.example';
const SUB = 'checkpoint-sub-test';
const EMAIL = 'checkpoint-test@x.example';
const ROLES = { 'authenticated-user': true, 'Tutorial.API': true };
const USER = {
  id: EMAIL,
  roles: ROLES,
  authInfo: { token: { payload: { iss: ISS, sub: SUB } } },
};

// Helper: send an action/event via srv.tx so req.user is set correctly.
const call = (srv, event, data = {}) =>
  srv.tx({ user: USER }, (tx) => tx.send({ event, data }));

describe('app-space CHECKPOINT title resolution', () => {
  let srv;
  let eventLegacyId;
  let missionLegacyId;
  const CHECKPOINT_TITLE = 'Claim your prize';

  beforeAll(async () => {
    srv = await cds.connect.to('DeveloperService');

    const {
      Events,
      Missions,
      CompletionPaths,
      CompletionPathItems,
    } = cds.entities(NS);

    const missionId = cds.utils.uuid();
    const eventId = cds.utils.uuid();
    const pathId = cds.utils.uuid();

    missionLegacyId = 99010;
    eventLegacyId = 99020;

    // Seed a Mission
    await INSERT.into(Missions).entries({
      ID: missionId,
      title: 'Checkpoint Title Test Mission',
      legacyId: missionLegacyId,
      missionType: 'SEQUENTIAL',
    });

    // Seed an Event linked to the Mission
    await INSERT.into(Events).entries({
      ID: eventId,
      name: 'Checkpoint Title Test Event',
      legacyId: eventLegacyId,
      eventType: 'DEVTOBERFEST',
      startDate: new Date().toISOString(),
      mission_ID: missionId,
      event_ID: eventId,
    });

    // Seed a CompletionPath
    await INSERT.into(CompletionPaths).entries({
      ID: pathId,
      mission_ID: missionId,
      name: 'Test Path',
      legacyId: 99030,
    });

    // Seed a CHECKPOINT CompletionPathItem with only checkpointTitle, no task record
    await INSERT.into(CompletionPathItems).entries({
      ID: cds.utils.uuid(),
      path_ID: pathId,
      taskLegacyId: null,
      taskType: 'CHECKPOINT',
      checkpointTitle: CHECKPOINT_TITLE,
      itemOrder: 1,
      legacyId: 99040,
    });

    // Bidirectional link for getEventProgress
    await UPDATE(Missions, missionId).set({ event_ID: eventId });
  });

  // ── getAppSpaceProgress ────────────────────────────────────────────────────
  it('CHECKPOINT item in getAppSpaceProgress resolves title from checkpointTitle', async () => {
    const res = await call(srv, 'getAppSpaceProgress', { eventLegacyId });

    expect(res).to.have.property('paths');
    expect(Array.isArray(res.paths)).to.equal(true);

    const items = res.paths.flatMap((p) => p.items);
    const checkpoint = items.find((i) => i.type === 'CHECKPOINT');

    expect(checkpoint).to.exist;
    expect(checkpoint.title).to.equal(CHECKPOINT_TITLE);
  });

  // ── getEventProgress ───────────────────────────────────────────────────────
  it('CHECKPOINT item in getEventProgress resolves title from checkpointTitle', async () => {
    const res = await call(srv, 'getEventProgress', { missionLegacyId });

    expect(res).to.have.property('paths');
    expect(Array.isArray(res.paths)).to.equal(true);

    const items = res.paths.flatMap((p) => p.items);
    const checkpoint = items.find((i) => i.type === 'CHECKPOINT');

    expect(checkpoint).to.exist;
    expect(checkpoint.title).to.equal(CHECKPOINT_TITLE);
  });
});
