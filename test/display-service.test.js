import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const displayAuth = { auth: { username: 'display', password: 'display' } };
const devAuth = { auth: { username: 'developer', password: 'developer' } };

describe('DisplayService', () => {

  describe('Authorization', () => {
    it('rejects users without DisplayApp role', async () => {
      const { status } = await project.get('/display/Events', {
        ...devAuth, validateStatus: () => true
      });
      expect(status).toBe(403);
    });

    it('allows display users', async () => {
      const { status } = await project.get('/display/Events', displayAuth);
      expect(status).toBe(200);
    });
  });

  describe('Event Data', () => {
    beforeAll(async () => {
      const { Events, Users, Tutorials, Missions, TaskRecords } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Events).entries({
        ID: 'aaaaaaaa-1111-0000-0000-000000000001',
        name: 'Display Test Event',
        startDate: '2026-06-01T00:00:00Z',
        endDate: '2026-06-03T23:59:59Z',
        timeZone: '+00:00',
        legacyId: 5001
      });

      await INSERT.into(Users).entries([
        { ID: 'aaaaaaaa-1111-0000-0000-000000000011', uuid: 'disp-u1', legacyId: 5011, displayName: 'Player1' },
        { ID: 'aaaaaaaa-1111-0000-0000-000000000012', uuid: 'disp-u2', legacyId: 5012, displayName: 'Player2' },
        { ID: 'aaaaaaaa-1111-0000-0000-000000000013', uuid: 'disp-u3', legacyId: 5013, displayName: 'Player3' },
      ]);

      await INSERT.into(Tutorials).entries([
        { ID: 'aaaaaaaa-1111-0000-0000-000000000021', title: 'Tut 1', slug: 'disp-tut-1', legacyId: 5021 },
      ]);

      await INSERT.into(Missions).entries([
        { ID: 'aaaaaaaa-1111-0000-0000-000000000031', title: 'Mission Alpha', legacyId: 5031 },
      ]);

      await INSERT.into(TaskRecords).entries([
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000011', taskLegacyId: 5021, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-01T10:00:00Z', completionTime: 600, legacyId: 5101 },
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000011', taskLegacyId: 5031, taskType: 'MISSION', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-01T12:00:00Z', completionTime: 1800, legacyId: 5102 },
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000012', taskLegacyId: 5021, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-01T14:00:00Z', completionTime: 900, legacyId: 5103 },
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000013', taskLegacyId: 5021, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-02T09:00:00Z', completionTime: 450, legacyId: 5104 },
      ]);
    });

    it('getEventBurnup returns daily tutorial completions', async () => {
      const { status, data } = await project.get(
        '/display/getEventBurnup(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value.length).toBe(2);
      expect(data.value[0].day).toBe('2026-06-01');
      expect(data.value[0].count).toBe(2);
      expect(data.value[0].cumulative).toBe(2);
      expect(data.value[1].cumulative).toBe(3);
    });

    it('getEventBuckets returns user distribution', async () => {
      const { status, data } = await project.get(
        '/display/getEventBuckets(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value.length).toBeGreaterThan(0);
      expect(data.value[0].bucketName).toBe('1 tutorial');
      expect(data.value[0].count).toBe(3);
    });

    it('getLeaderboard returns top users', async () => {
      const { status, data } = await project.get(
        '/display/getLeaderboard(eventLegacyId=5001,top=2)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value[0].displayName).toBe('Player1');
      expect(data.value[0].completions).toBe(2);
      expect(data.value.length).toBe(2);
    });

    it('getEventTrackStats returns mission completion stats', async () => {
      const { status, data } = await project.get(
        '/display/getEventTrackStats(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value[0].title).toBe('Mission Alpha');
      expect(data.value[0].completions).toBe(1);
    });

    it('getCompletionSpeed returns average times', async () => {
      const { status, data } = await project.get(
        '/display/getCompletionSpeed(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value[0].title).toBe('Tut 1');
      expect(data.value[0].completions).toBe(3);
      // avg of 600, 900, 450 seconds = 650 seconds ≈ 11 minutes
      expect(data.value[0].avgMinutes).toBe(11);
    });

    it('returns 404 for unknown event', async () => {
      const { status } = await project.get(
        '/display/getEventBurnup(eventLegacyId=99999)',
        { ...displayAuth, validateStatus: () => true }
      );
      expect(status).toBe(404);
    });
  });
});
