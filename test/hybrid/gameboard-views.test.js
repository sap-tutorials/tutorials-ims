// test/hybrid/gameboard-views.test.js
//
// Plan: docs/superpowers/plans/2026-07-31-devtoberfest-gameboard-plan-a-foundation.md (Task 1)
//
// Verifies the two gameboard provider views deploy and resolve against real
// HANA (DEV space), exposing exactly the frozen cross-container column contract
// that the separate `sap-community-gameboard` MTA consumes via synonyms:
//   - GAMEBOARD_PARTICIPANT_V1: USER_ID, FIRST_NAME, LAST_INITIAL, COMMUNITY_ID,
//     COMMUNITY_LOGIN, JOINED_AT, EVENT_ID
//   - GAMEBOARD_COMPLETION_V1:  USER_ID, TUTORIAL_SLUG, TASK_TYPE,
//     COMPLETION_DATE, EVENT_ID
//
// Read-only: the views are SELECT-only projections, so this test performs no
// writes and needs no _guard cleanup. It only asserts the views resolve and
// return well-shaped rows.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('gameboard provider views (hybrid)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  it('GAMEBOARD_PARTICIPANT_V1 resolves and exposes the frozen columns', async () => {
    const rows = await db.run(
      `SELECT TOP 1 "USER_ID","FIRST_NAME","LAST_INITIAL","COMMUNITY_ID","COMMUNITY_LOGIN","JOINED_AT","EVENT_ID" FROM "GAMEBOARD_PARTICIPANT_V1"`,
    );
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length) {
      // LAST_INITIAL is a single char (LEFT(...,1)); may be '' for a
      // participant with a null/empty lastName, so assert length <= 1.
      expect(String(rows[0].LAST_INITIAL ?? '').length).toBeLessThanOrEqual(1);
    }
  });

  it('GAMEBOARD_COMPLETION_V1 resolves, is TUTORIAL-scoped, and lowercases the slug', async () => {
    const rows = await db.run(
      `SELECT TOP 5 "USER_ID","TUTORIAL_SLUG","TASK_TYPE","COMPLETION_DATE","EVENT_ID" FROM "GAMEBOARD_COMPLETION_V1"`,
    );
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) {
      expect(r.TASK_TYPE).toBe('TUTORIAL');
      if (r.TUTORIAL_SLUG) {
        expect(r.TUTORIAL_SLUG).toBe(r.TUTORIAL_SLUG.toLowerCase());
      }
    }
  });
});
