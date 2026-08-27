// srv/lib/cat-game-award.js
//
// "Hit the Cat" mini-game scoring rules (issue #2042). Awards a signed-in
// player 5 points per calendar day, once per day, capped at 100 points total
// per Devtoberfest event, and only while that event is active. HTTP-free and
// unit-testable: callers pass a db/tx handle + the resolved user/event.
//
// Persistence is the CatGameAwards ledger (db/devtoberfest.cds) whose PRIMARY
// KEY is (user, event, awardDate) — so the once-per-day rule is enforced by the
// DB, not just by the pre-check below: a same-day double-tap collides on the PK
// and is reported as 'already-today' rather than double-awarding (this repo's
// raw db.run() inserts bypass CAP-layer @assert.unique — see resolve-db-user.js).

import cds from '@sap/cds';

export const DAILY_POINTS = 5;
export const MAX_POINTS = 100;

/** UTC calendar day (YYYY-MM-DD) for a Date/now — the once-per-day bucket. */
export function utcDay(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

/** True when `now` falls within the event's [startDate, endDate] (open bounds tolerated). */
export function eventIsLive(event, now = new Date()) {
  if (!event) return false;
  const t = now.getTime();
  const s = event.startDate ? Date.parse(event.startDate) : null;
  const e = event.endDate ? Date.parse(event.endDate) : null;
  if (s != null && !Number.isNaN(s) && t < s) return false;
  if (e != null && !Number.isNaN(e) && t > e) return false;
  return true;
}

const isUniqueViolation = (err) =>
  /unique|duplicate|primary key/i.test(String(err?.message ?? err));

/**
 * Award (or decline) today's cat-game points for a user in a given event.
 *
 * @param db     a connected db / tx handle (`await cds.connect.to('db')`).
 * @param userId the Users.ID (UUID) of the signed-in player.
 * @param event  the active Events row (needs `.ID`).
 * @param now    injectable clock for tests (defaults to new Date()).
 * @returns one of:
 *   { awarded:true,  points, total, cap, reason:'awarded' }
 *   { awarded:false, reason:'already-today', total, cap }
 *   { awarded:false, reason:'max',           total:cap, cap }
 */
export async function awardCatGamePoints(db, { userId, event, now = new Date() }) {
  const cap = MAX_POINTS;
  const eventId = event?.ID;
  if (!userId || !eventId) { const e = new Error('userId and event.ID required'); e.code = 'BAD_ARGS'; throw e; }

  const { CatGameAwards } = cds.entities('com.sap.developers.ims');

  const rows = await db.run(
    SELECT.from(CatGameAwards).columns('points', 'awardDate')
      .where({ user_ID: userId, event_ID: eventId }),
  );
  const total = rows.reduce((s, r) => s + (Number(r.points) || 0), 0);

  if (total >= cap) return { awarded: false, reason: 'max', total: cap, cap };

  const today = utcDay(now);
  if (rows.some((r) => String(r.awardDate).slice(0, 10) === today)) {
    return { awarded: false, reason: 'already-today', total, cap };
  }

  const points = Math.min(DAILY_POINTS, cap - total);
  try {
    await db.run(INSERT.into(CatGameAwards).entries({
      user_ID: userId,
      event_ID: eventId,
      awardDate: today,
      points,
    }));
  } catch (err) {
    // Concurrent same-day insert lost the PK race — treat as already-earned.
    if (isUniqueViolation(err)) return { awarded: false, reason: 'already-today', total, cap };
    throw err;
  }
  return { awarded: true, points, total: total + points, cap, reason: 'awarded' };
}
