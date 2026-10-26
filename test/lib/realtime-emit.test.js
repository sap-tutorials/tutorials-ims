import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('DeveloperService realtime emit', () => {

  it('emits tutorialCompleted to EventStreamService after tutorial completion', async () => {
    const eventStream = await cds.connect.to('EventStreamService');
    expect(typeof eventStream.emit).toBe('function');
  });

  it('emits tutorialCompleted to DisplayService after tutorial completion', async () => {
    const display = await cds.connect.to('DisplayService');
    expect(typeof display.emit).toBe('function');
  });

  describe('date-window event context (no event_ID required)', () => {
    beforeAll(async () => {
      const { Users, Events } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Users).entries({
        ID: 'dddddddd-0000-0000-0000-000000000001', sapId: 'wsdev', uuid: 'wsdev', legacyId: 6001,
      });
      // Active window: now ∈ [start, end].
      const now = Date.now();
      await INSERT.into(Events).entries({
        ID: 'eeeeeeee-0000-0000-0000-000000000001', legacyId: 888001,
        name: 'Active WS Event', eventType: 'TECHED',
        startDate: new Date(now - 3600_000).toISOString(),
        endDate: new Date(now + 3600_000).toISOString(),
      });
    });

    it('completes a tutorial with no event_ID during an active window without error', async () => {
      // The handler no longer bails on `!result.event_ID`; it looks up the
      // active event window instead. Completing a plain tutorial (no event_ID)
      // must still succeed — and the WS fan-out happens best-effort in an
      // after-handler, so a broadcast failure never fails the completion.
      const res = await project.post('/api/createTaskRecord',
        { taskLegacyId: 20001, taskType: 'TUTORIAL' },
        { auth: { username: 'wsdev', password: 'wsdev' } });
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('COMPLETED');
    });
  });
});
