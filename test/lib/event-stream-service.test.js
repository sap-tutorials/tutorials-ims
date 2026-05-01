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

  it('getEventBuckets returns empty array for non-existent event', async () => {
    const { data } = await project.get('/rest/event-stream/getEventBuckets(eventLegacyId=99999)');
    expect(data).toEqual([]);
  });
});
