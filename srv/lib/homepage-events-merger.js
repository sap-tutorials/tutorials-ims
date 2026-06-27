/**
 * Merges local (DB) and remote events for the homepage Events band.
 *
 * @param {Array<{title:string,startsAt:string,location:string,format?:string,register?:string}>} local
 * @param {Array<{title:string,startsAt:string,location:string,format?:string,register?:string}>} remote
 * @param {{ now?: number, limit?: number }} [opts]
 * @returns {Array} Deduplicated, future-only, ascending-sorted, capped event list.
 */

function normTitle(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function keyOf(e) {
  return `${normTitle(e.title)}|${e.startsAt}`;
}

export function mergeEvents(local, remote, { now = Date.now(), limit = 4 } = {}) {
  const seen = new Map();

  for (const e of local || []) {
    if (!e?.title || !e?.startsAt) continue;
    seen.set(keyOf(e), e);
  }

  for (const e of remote || []) {
    if (!e?.title || !e?.startsAt) continue;
    const k = keyOf(e);
    if (!seen.has(k)) seen.set(k, e); // local wins on collision
  }

  return [...seen.values()]
    .filter(e => new Date(e.startsAt).getTime() >= now)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
    .slice(0, limit);
}
