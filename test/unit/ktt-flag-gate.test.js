// test/unit/ktt-flag-gate.test.js
// Tests that completeLesson and syncProgress reject 503 when KTT_ENABLED is OFF,
// and succeed when it is forced ON.
// Uses __setFlagForTest / __resetFlagsForTest (globalThis-backed cache helpers
// from db-flags.js) — the same pattern as kg-path-v2-handler-flag.test.js.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const { GET, POST } = cds.test('serve', '--project', '.', '--in-memory');

let authed;
beforeAll(async () => {
  const { Users, KttLessons } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: 'bob', sapId: 'bob', legacyId: 2 });
  // KttLessons is now CSV-seeded (db/data/…-KttLessons.csv). Clear it before this
  // controlled fixture so legacyId 90002 does not collide with the seed's row.
  await DELETE.from(KttLessons);
  await INSERT.into(KttLessons).entries({ ID: cds.utils.uuid(), legacyId: 90002, slug: 'core-2' });
  authed = { auth: { username: 'bob', password: 'bob' } };
});

beforeEach(() => {
  // Each test controls the flag explicitly — reset to cold/default (OFF) first.
  __resetFlagsForTest();
});

afterEach(() => {
  __resetFlagsForTest();
});

describe('KTT_ENABLED flag gate', () => {
  describe('flag OFF (default)', () => {
    it('completeLesson rejects 503 when KTT_ENABLED is off', async () => {
      // Flag is OFF (cold cache → declared default false).
      const body = { lessonSlug: 'core-2', legacyId: 90002, title: 'Meet TLAs' };
      try {
        await POST('/ktt/completeLesson', body, authed);
        expect.fail('expected a 503 rejection');
      } catch (err) {
        expect(err.response?.status ?? err.status).toBe(503);
      }
    });

    it('syncProgress rejects 503 when KTT_ENABLED is off', async () => {
      const body = { localJson: JSON.stringify({ xp: 0, streak: 0, mastered: [] }) };
      try {
        await POST('/ktt/syncProgress', body, authed);
        expect.fail('expected a 503 rejection');
      } catch (err) {
        expect(err.response?.status ?? err.status).toBe(503);
      }
    });

    it('READ Lessons rejects 503 when KTT_ENABLED is off (page fails closed)', async () => {
      try {
        await GET('/ktt/Lessons?$top=1');
        expect.fail('expected a 503 rejection');
      } catch (err) {
        expect(err.response?.status ?? err.status).toBe(503);
      }
    });
  });

  describe('flag ON', () => {
    beforeEach(() => {
      __setFlagForTest('KTT_ENABLED', true);
    });

    it('completeLesson succeeds when KTT_ENABLED is on', async () => {
      const body = { lessonSlug: 'core-2', legacyId: 90002, title: 'Meet TLAs' };
      const r = await POST('/ktt/completeLesson', body, authed);
      expect(r.data.ok).toBe(true);
    });

    it('syncProgress succeeds when KTT_ENABLED is on', async () => {
      const body = { localJson: JSON.stringify({ xp: 10, streak: 1, mastered: ['core-2'] }) };
      const r = await POST('/ktt/syncProgress', body, authed);
      expect(r.data.mastered).toContain('core-2');
    });

    it('READ Lessons succeeds when KTT_ENABLED is on', async () => {
      const r = await GET('/ktt/Lessons?$top=1');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.data.value)).toBe(true);
    });
  });
});
