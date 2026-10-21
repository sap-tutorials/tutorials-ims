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
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000003',
          name: 'Drawing Event C',
          startDate: '2026-08-01T00:00:00Z',
          endDate: '2026-08-03T23:59:59Z',
          legacyId: 7003
        }
      ]);

      await INSERT.into(Users).entries([
        { ID: 'bbbbbbbb-2222-0000-0000-000000000011', uuid: 'draw-u1', legacyId: 7011, displayName: 'Winner1' },
        { ID: 'bbbbbbbb-2222-0000-0000-000000000012', uuid: 'draw-u2', legacyId: 7012, displayName: 'Winner2' },
        { ID: 'bbbbbbbb-2222-0000-0000-000000000013', uuid: 'draw-u3', legacyId: 7013, displayName: 'Winner3' }
      ]);

      // Events 7001 and 7003 have CLAIMED PrizeRecords; event 7002 has only PENDING.
      // This ensures the filter (only CLAIMED events) AND the sort (newest-first) are both exercised.
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
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000024',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000011',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000003',
          status: 'CLAIMED',
          legacyId: 7024
        }
      ]);
    });

    it('listEvents returns only events with CLAIMED records, newest-first', async () => {
      const { status, data } = await project.get('/drawings/listEvents()', adminAuth);
      expect(status).toBe(200);
      // 7003 (2026-08-01) and 7001 (2026-06-01) have CLAIMED records; 7002 (PENDING only) is excluded
      expect(data.value).toHaveLength(2);
      expect(data.value[0].legacyId).toBe(7003); // newest first
      expect(data.value[1].legacyId).toBe(7001);
    });
  });

  // ---------------------------------------------------------------------------
  // pool and draw
  // ---------------------------------------------------------------------------
  // Seed layout (uses dedicated events 7010/7011/7012 to avoid contamination
  // from the listEvents seed above which already inserted CLAIMED rows for 7001):
  //   Event 7010 (ID: ...010):
  //     User A (ID: ...031, displayName:'UserA', email:'a@test.com') — 2 CLAIMED rows (counts once)
  //     User B (ID: ...032, displayName:'UserB', email:null)         — 1 CLAIMED row
  //     User C (ID: ...033, displayName:'ANONYMIZED', email:null)    — 1 CLAIMED row (excluded)
  //     User D (ID: ...034, displayName:'UserD', email:'d@test.com') — 1 PENDING row only (excluded)
  //   Event 7011: no CLAIMED rows — pool = 0
  //   Event 7012: only User B CLAIMED — deterministic draw with null email
  // ---------------------------------------------------------------------------
  describe('pool and draw', () => {
    beforeAll(async () => {
      const { Events, Users, PrizeRecords } = cds.entities('com.sap.developers.ims');

      // Dedicated events for pool/draw tests
      await INSERT.into(Events).entries([
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000010',
          name: 'Pool Draw Event A',
          startDate: '2026-09-01T00:00:00Z',
          endDate: '2026-09-03T23:59:59Z',
          legacyId: 7010
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000020',
          name: 'Pool Draw Event B (empty)',
          startDate: '2026-09-04T00:00:00Z',
          endDate: '2026-09-06T23:59:59Z',
          legacyId: 7011
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000030',
          name: 'Pool Draw Event C (B only)',
          startDate: '2026-09-07T00:00:00Z',
          endDate: '2026-09-09T23:59:59Z',
          legacyId: 7012
        }
      ]);

      // Users A-D for pool/draw tests
      await INSERT.into(Users).entries([
        { ID: 'bbbbbbbb-2222-0000-0000-000000000031', uuid: 'draw-pool-u1', legacyId: 8031, displayName: 'UserA', email: 'a@test.com' },
        { ID: 'bbbbbbbb-2222-0000-0000-000000000032', uuid: 'draw-pool-u2', legacyId: 8032, displayName: 'UserB', email: null },
        { ID: 'bbbbbbbb-2222-0000-0000-000000000033', uuid: 'draw-pool-u3', legacyId: 8033, displayName: 'ANONYMIZED', email: null },
        { ID: 'bbbbbbbb-2222-0000-0000-000000000034', uuid: 'draw-pool-u4', legacyId: 8034, displayName: 'UserD', email: 'd@test.com' }
      ]);

      await INSERT.into(PrizeRecords).entries([
        // Event 7010 — User A, 2 CLAIMED rows (should count as 1 distinct)
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000041',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000031',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000010',
          status: 'CLAIMED',
          legacyId: 8041
        },
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000042',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000031',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000010',
          status: 'CLAIMED',
          legacyId: 8042
        },
        // Event 7010 — User B, 1 CLAIMED, email null
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000043',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000032',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000010',
          status: 'CLAIMED',
          legacyId: 8043
        },
        // Event 7010 — User C (ANONYMIZED), 1 CLAIMED — must be excluded from pool
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000044',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000033',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000010',
          status: 'CLAIMED',
          legacyId: 8044
        },
        // Event 7010 — User D, PENDING only — must be excluded from pool
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000045',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000034',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000010',
          status: 'PENDING',
          legacyId: 8045
        },
        // Event 7012 — only User B (null email) — ensures draw works with null email
        {
          ID: 'bbbbbbbb-2222-0000-0000-000000000046',
          user_ID: 'bbbbbbbb-2222-0000-0000-000000000032',
          event_ID: 'bbbbbbbb-2222-0000-0000-000000000030',
          status: 'CLAIMED',
          legacyId: 8046
        }
      ]);
    });

    it('pool counts distinct non-anonymized claimers', async () => {
      const { status, data } = await project.get('/drawings/pool(eventId=7010)', adminAuth);
      expect(status).toBe(200);
      // UserA (counted once despite 2 rows) + UserB = 2; UserC (ANONYMIZED) and UserD (PENDING) excluded
      expect(data.eligibleCount).toBe(2);
      expect(data.eventId).toBe(7010);
    });

    it('pool is 0 for event with no claims', async () => {
      const { status, data } = await project.get('/drawings/pool(eventId=7011)', adminAuth);
      expect(status).toBe(200);
      expect(data.eligibleCount).toBe(0);
    });

    it('pool 404s for unknown event', async () => {
      const { status } = await project.get('/drawings/pool(eventId=99999)', {
        ...adminAuth, validateStatus: () => true
      });
      expect(status).toBe(404);
    });

    it('draw 404s for unknown event', async () => {
      const { status } = await project.get('/drawings/draw(eventId=99999)', {
        ...adminAuth, validateStatus: () => true
      });
      expect(status).toBe(404);
    });

    it('draw returns a pool member', async () => {
      const { status, data } = await project.get('/drawings/draw(eventId=7010)', adminAuth);
      expect(status).toBe(200);
      expect(data.eligibleCount).toBe(2);
      expect(['UserA', 'UserB']).toContain(data.winner.displayName);
    });

    it('draw returns null winner for empty pool', async () => {
      const { status, data } = await project.get('/drawings/draw(eventId=7011)', adminAuth);
      expect(status).toBe(200);
      expect(data.winner).toBeNull();
      expect(data.eligibleCount).toBe(0);
    });

    it('draw can return a winner with null email', async () => {
      // Event 7012 has only UserB (email:null) as eligible claimer
      const { status, data } = await project.get('/drawings/draw(eventId=7012)', adminAuth);
      expect(status).toBe(200);
      expect(data.winner.displayName).toBe('UserB');
      expect(data.winner.email).toBeNull();
      expect(data.eligibleCount).toBe(1);
    });
  });
});

