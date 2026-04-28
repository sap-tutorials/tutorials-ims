import { describe, it, expect } from 'vitest';
import { buildNgdsPayload } from '../../srv/lib/ngds-client.js';

describe('ngds-client', () => {
  describe('buildNgdsPayload', () => {
    it('constructs correct JSON structure for a tutorial completion', () => {
      const payload = buildNgdsPayload({
        uuid: 'user-uuid-123',
        taskLegacyId: 42,
        taskType: 'TUTORIAL',
        taskTitle: 'Build a CAP App',
        completionDate: '2026-04-28T10:30:00Z',
        eventLegacyId: null,
        sapId: 'S0012345678'
      });

      expect(payload.context).toBe('developers.sap.com');
      expect(payload.trackingInfo.userId).toBe('user-uuid-123');
      expect(payload.imsData.taskId).toBe(42);
      expect(payload.imsData.taskType).toBe('TUTORIAL');
      expect(payload.interactionData.title).toBe('Build a CAP App');
      expect(payload.interactionData.sapAccountNumber).toBe('S0012345678');
    });

    it('includes event data when eventLegacyId is provided', () => {
      const payload = buildNgdsPayload({
        uuid: 'user-uuid-123',
        taskLegacyId: 42,
        taskType: 'TUTORIAL',
        taskTitle: 'Build a CAP App',
        completionDate: '2026-04-28T10:30:00Z',
        eventLegacyId: 99,
        sapId: null
      });

      expect(payload.imsData.eventId).toBe(99);
    });
  });
});
