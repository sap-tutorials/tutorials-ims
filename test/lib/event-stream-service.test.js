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

  it('getEventBuckets counts completions within the event date window, ignoring event_ID', async () => {
    const db = await cds.connect.to('db');
    const { Events, Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    const eventID = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: eventID, legacyId: 777001, name: 'Window Test Event',
      eventType: 'TECHED',
      startDate: '2026-10-26T14:00:00Z', endDate: '2026-10-29T16:00:00Z',
    });

    const u1 = cds.utils.uuid(), u2 = cds.utils.uuid();
    await INSERT.into(Users).entries(
      { ID: u1, legacyId: 777101 }, { ID: u2, legacyId: 777102 });

    await INSERT.into(TaskRecords).entries(
      // In window, no event_ID — must still count (the bug: event_ID join missed these)
      { ID: cds.utils.uuid(), user_ID: u1, taskLegacyId: 1, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-27T10:00:00Z' },
      { ID: cds.utils.uuid(), user_ID: u1, taskLegacyId: 2, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-27T11:00:00Z' },
      { ID: cds.utils.uuid(), user_ID: u2, taskLegacyId: 1, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-28T09:00:00Z' },
      // Before window — excluded
      { ID: cds.utils.uuid(), user_ID: u2, taskLegacyId: 3, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-10-01T09:00:00Z' },
      // After window — excluded
      { ID: cds.utils.uuid(), user_ID: u1, taskLegacyId: 4, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-11-01T09:00:00Z' },
      // In window but wrong taskType — excluded
      { ID: cds.utils.uuid(), user_ID: u2, taskLegacyId: 5, taskType: 'MISSION', status: 'COMPLETED', completionDate: '2026-10-27T12:00:00Z' },
    );

    const res = await project.get('/rest/event-stream/getEventBuckets(eventLegacyId=777001)');
    const body = res.data ?? res;
    // u1 = 2 tutorials, u2 = 1 tutorial → buckets: {"1 tutorial":1, "2 tutorials":1}
    const byName = Object.fromEntries(body.buckets.map(b => [b.bucketName, b.count]));
    expect(byName['2 tutorials']).toBe(1);
    expect(byName['1 tutorial']).toBe(1);

    await DELETE.from(TaskRecords).where({ user_ID: { in: [u1, u2] } });
    await DELETE.from(Users).where({ ID: { in: [u1, u2] } });
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
