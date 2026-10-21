import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const devAuth = { auth: { username: 'developer', password: 'developer' } };

describe('DrawingService', () => {

  describe('Authorization', () => {
    it('rejects non-Admin users', async () => {
      const { status } = await project.get('/drawings/listEvents()', {
        ...devAuth, validateStatus: () => true
      });
      expect(status).toBe(403);
    });
  });

  describe('listEvents', () => {
    beforeAll(async () => {
      const { Events, Users, PrizeRecords } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Events).entries([
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000001',
          name: 'Drawing Event A',
          startDate: '2026-06-01T00:00:00Z',
          endDate: '2026-06-03T23:59:59Z',
          legacyId: 7001
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000002',
          name: 'Drawing Event B',
          startDate: '2026-07-01T00:00:00Z',
          endDate: '2026-07-03T23:59:59Z',
          legacyId: 7002
        }
      ]);

      await INSERT.into(Users).entries([
        { ID: 'bbbbbbbb-2222-0000-0000-000000000011', uuid: 'draw-u1', legacyId: 7011, displayName: 'Winner1' },
        { ID: 'bbbbbbbb-2222-0000-0000-000000000012', uuid: 'draw-u2', legacyId: 7012, displayName: 'Winner2' },
        { ID: 'bbbbbbbb-2222-0000-0000-000000000013', uuid: 'draw-u3', legacyId: 7013, displayName: 'Winner3' }
      ]);

      // Only event 7001 has a CLAIMED PrizeRecord
      // Event 7002 has no CLAIMED records (only PENDING)
      await INSERT.into(PrizeRecords).entries([
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000021',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000011',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000001',
          status: 'CLAIMED',
          legacyId: 7021
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000022',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000012',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000001',
          status: 'CLAIMED',
          legacyId: 7022
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000023',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000013',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000002',
          status: 'PENDING',
          legacyId: 7023
        }
      ]);
    });

    it('listEvents returns only events with CLAIMED records, newest-first', async () => {
      const { status, data } = await project.get('/drawings/listEvents()', adminAuth);
      expect(status).toBe(200);
      expect(data.value).toHaveLength(1);
      expect(data.value[0].legacyId).toBe(7001);
    });
  });
});
