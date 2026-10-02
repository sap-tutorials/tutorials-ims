import cds from '@sap/cds';

// Shared task resolution for CompletionPathItems in the event / app-space
// progress handlers (srv/developer-service.js: getEventProgress,
// getAppSpaceProgress).
//
// #1866: manually-authored content (the high-ID prod batch, e.g. the
// DSAG-Jahreskongress 2026 / SAP Connect 2026 event missions) populates the
// item's tutorial_ID FK (UUID) but leaves taskLegacyId null. The original
// legacyId-only lookup fetched tutorials by taskLegacyId and keyed the task
// map by legacyId, so those items missed the map entirely → App-Space rendered
// empty tutorial cards. The mission catalog builder (srv/lib/build-catalog.js)
// already resolves tutorial_ID first; this helper gives the two progress
// handlers the same FK-first behavior.
//
// CHECKPOINT / PETOBERFEST items carry no FK column, so they resolve by
// taskLegacyId only (unchanged behavior).

/**
 * Fetch tutorials/checkpoints/petoberfests for the given path items and build a
 * lookup map keyed by BOTH `TUTORIAL:uuid:<ID>` and `TUTORIAL:<legacyId>` for
 * tutorials, and `CHECKPOINT:<legacyId>` / `PETOBERFEST:<legacyId>` for the
 * others.
 *
 * @param {object} opts
 * @param {Array}  opts.items   CompletionPathItems rows (must include taskType,
 *                              taskLegacyId, tutorial_ID).
 * @param {object} opts.entities { Tutorials, Checkpoints, Petoberfests } CDS entities.
 * @returns {Promise<Map>} task map
 */
export async function buildTaskMap({ items, entities }) {
  const { Tutorials, Checkpoints, Petoberfests } = entities;

  const legacyIds = [...new Set(items.map(i => i.taskLegacyId).filter(v => v != null))];
  const tutorialUuids = [...new Set(
    items
      .filter(i => i.taskType === 'TUTORIAL' && i.tutorial_ID)
      .map(i => i.tutorial_ID)
  )];

  // Tutorials: resolve by legacyId OR tutorial_ID so items carrying only one of
  // the two still resolve. Two separate queries merged in JS — avoids a
  // combined OR across two columns (CQN OR shorthand is error-prone and HANA/
  // SQLite differ) and de-dupes on ID.
  const tutorialById = new Map();
  if (legacyIds.length > 0) {
    for (const t of await SELECT.from(Tutorials).where({ legacyId: { in: legacyIds } })) {
      tutorialById.set(t.ID, t);
    }
  }
  if (tutorialUuids.length > 0) {
    for (const t of await SELECT.from(Tutorials).where({ ID: { in: tutorialUuids } })) {
      tutorialById.set(t.ID, t);
    }
  }
  const tutorials = [...tutorialById.values()];

  const checkpoints = legacyIds.length > 0
    ? await SELECT.from(Checkpoints).where({ legacyId: { in: legacyIds } })
    : [];
  const petoberfests = legacyIds.length > 0
    ? await SELECT.from(Petoberfests).where({ legacyId: { in: legacyIds } })
    : [];

  const taskMap = new Map();
  for (const t of tutorials) {
    if (t.ID != null) taskMap.set(`TUTORIAL:uuid:${t.ID}`, t);
    // Only index by legacyId when the tutorial actually has one AND no better
    // (slug-bearing) entry is already present — mirrors the original
    // last-write-wins semantics; the missing-slug re-query below still applies.
    if (t.legacyId != null) taskMap.set(`TUTORIAL:${t.legacyId}`, t);
  }
  for (const c of checkpoints) taskMap.set(`CHECKPOINT:${c.legacyId}`, c);
  for (const p of petoberfests) taskMap.set(`PETOBERFEST:${p.legacyId}`, p);

  // Slug-freshness safety net (ported from getEventProgress): if a resolved
  // TUTORIAL has no slug, re-query by legacyId filtering to slug-bearing rows.
  const missingSlugIds = tutorials
    .filter(t => t.legacyId != null && !t.slug)
    .map(t => t.legacyId);
  if (missingSlugIds.length > 0) {
    const fresh = await SELECT.from(Tutorials)
      .where({ legacyId: { in: missingSlugIds }, slug: { '!=': null } });
    for (const t of fresh) {
      if (t.ID != null) taskMap.set(`TUTORIAL:uuid:${t.ID}`, t);
      if (t.legacyId != null) taskMap.set(`TUTORIAL:${t.legacyId}`, t);
    }
  }

  return taskMap;
}

/**
 * Resolve the task record for an item, FK (tutorial_ID) first, then
 * `${taskType}:${taskLegacyId}`.
 * @returns {object|undefined}
 */
export function resolveTask(taskMap, item) {
  if (item.taskType === 'TUTORIAL' && item.tutorial_ID) {
    const byUuid = taskMap.get(`TUTORIAL:uuid:${item.tutorial_ID}`);
    if (byUuid) return byUuid;
  }
  return taskMap.get(`${item.taskType}:${item.taskLegacyId}`);
}

/**
 * The legacyId to use for this item's output `imsId` and for user TaskRecord
 * lookups: the item's own taskLegacyId when present, else the resolved
 * tutorial's legacyId (manually-authored FK-only items).
 * @returns {number|null}
 */
export function effectiveLegacyId(taskMap, item) {
  if (item.taskLegacyId != null) return item.taskLegacyId;
  const task = resolveTask(taskMap, item);
  return task?.legacyId ?? null;
}
