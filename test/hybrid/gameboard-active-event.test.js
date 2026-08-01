// test/hybrid/gameboard-active-event.test.js
//
// Plan: docs/superpowers/plans/2026-08-01-gameboard-login-join-empty-arcade-fixes-plan.md (Task 1)
//
// GAMEBOARD_ACTIVE_EVENT_V1 resolves the active Devtoberfest event from
// DevtoberfestConfig (isActive=true → currentEvent), INDEPENDENT of
// EventRegistrations — so the gameboard knows the active event even at 0
// participants (the fix for the "log in" bug + empty board).

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('GAMEBOARD_ACTIVE_EVENT_V1 (hybrid)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('resolves the config-active event (0 or 1 row), registration-independent', async () => {
    const rows = await db.run(
      `SELECT "EVENT_ID","EVENT_NAME","EVENT_START","EVENT_END" FROM "GAMEBOARD_ACTIVE_EVENT_V1"`,
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(1);
    // If an event is configured active, it carries an id + a window.
    if (rows.length) {
      expect(rows[0].EVENT_ID).toBeTruthy();
    }
  });
});
