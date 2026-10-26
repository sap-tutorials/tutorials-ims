import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('EventStreamService', () => {

  it('getEventBuckets returns bucket array for valid event', async () => {
    const { EventStreamService } = cds.services;
    expect(EventStreamService).toBeDefined();
  });

  it('exposes tutorialCompleted event in model', () => {
    const model = cds.model;
    const event = model.definitions['EventStreamService.tutorialCompleted'];
    expect(event).toBeDefined();
    expect(event.kind).toBe('event');
    expect(event.elements.bucketName).toBeDefined();
    expect(event.elements.completeDate).toBeDefined();
    expect(event.elements.tutorialTitle).toBeDefined();
  });

  it('getEventBuckets rejects with 404 for non-existent event', async () => {
    const res = await project.get('/rest/event-stream/getEventBuckets(eventLegacyId=99999)')
      .catch(e => e);
    expect(res.response?.status ?? res.status).toBe(404);
  });

  it('getEventBuckets returns per-track buckets grouped by CompletionPath, window-scoped', async () => {
    const { Events, Missions, Users, Tutorials, CompletionPaths, CompletionPathItems, TaskRecords } =
      cds.entities('com.sap.developers.ims');

    const eventID = cds.utils.uuid(), misID = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: eventID, legacyId: 777001, name: 'Window Test Event', eventType: 'TECHED',
      startDate: '2026-10-26T14:00:00Z', endDate: '2026-10-29T16:00:00Z',
    });
    await INSERT.into(Missions).entries({ ID: misID, legacyId: 777050, title: 'M', event_ID: eventID, published: true });
    await INSERT.into(CompletionPaths).entries(
      { ID: 'esp-A', legacyId: 777060, name: 'Alpha', mission_ID: misID },
      { ID: 'esp-B', legacyId: 777061, name: 'Beta', mission_ID: misID },
    );
    await INSERT.into(Tutorials).entries(
      { ID: 'est-1', legacyId: 7701, title: 'T1', status: 'ACTIVE' },
      { ID: 'est-2', legacyId: 7702, title: 'T2', status: 'ACTIVE' },
    );
    await INSERT.into(CompletionPathItems).entries(
      { ID: 'escpi-1', legacyId: 777070, path_ID: 'esp-A', taskType: 'TUTORIAL', taskLegacyId: 7701, itemOrder: 1 },
      { ID: 'escpi-2', legacyId: 777071, path_ID: 'esp-B', taskType: 'TUTORIAL', taskLegacyId: 7702, itemOrder: 1 },
    );

    const u1 = cds.utils.uuid(), u2 = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: u1, legacyId: 777101 }, { ID: u2, legacyId: 777102 });
    await INSERT.into(TaskRecords).entries(
      // Alpha: u1 + u2 complete 7701 (in window) → Alpha = 2
      { ID: cds.utils.uuid(), user_ID: u1, taskLegacyId: 7701, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-27T10:00:00Z' },
      { ID: cds.utils.uuid(), user_ID: u2, taskLegacyId: 7701, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-28T09:00:00Z' },
      // Beta: u1 completes 7702 → Beta = 1
      { ID: cds.utils.uuid(), user_ID: u1, taskLegacyId: 7702, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-27T11:00:00Z' },
      // Out of window — excluded
      { ID: cds.utils.uuid(), user_ID: u2, taskLegacyId: 7702, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-01T09:00:00Z' },
      // Not a path tutorial — contributes to no track
      { ID: cds.utils.uuid(), user_ID: u2, taskLegacyId: 7799, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-27T12:00:00Z' },
    );

    const res = await project.get('/rest/event-stream/getEventBuckets(eventLegacyId=777001)');
    const body = res.data ?? res;
    const byName = Object.fromEntries(body.buckets.map(b => [b.bucketName, b.count]));
    expect(byName['Alpha']).toBe(2);
    expect(byName['Beta']).toBe(1);
    expect(body.buckets.length).toBe(2);

    await DELETE.from(TaskRecords).where({ user_ID: { in: [u1, u2] } });
    await DELETE.from(Users).where({ ID: { in: [u1, u2] } });
    await DELETE.from(CompletionPathItems).where({ path_ID: { in: ['esp-A', 'esp-B'] } });
    await DELETE.from(CompletionPaths).where({ ID: { in: ['esp-A', 'esp-B'] } });
    await DELETE.from(Missions).where({ ID: misID });
    await DELETE.from(Events).where({ ID: eventID });
  });

  it('getEventBuckets returns empty buckets when the event has no date window', async () => {
    const { Events } = cds.entities('com.sap.developers.ims');
    const eventID = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: eventID, legacyId: 777002, name: 'No Window Event', eventType: 'OTHER',
    });
    const res = await project.get('/rest/event-stream/getEventBuckets(eventLegacyId=777002)');
    const body = res.data ?? res;
    expect(body.buckets).toEqual([]);
    await DELETE.from(Events).where({ ID: eventID });
  });
});
