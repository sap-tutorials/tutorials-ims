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

/**
 * Expand the GROUP CompletionPathItems among `items` into their child tutorials.
 *
 * A path item with `taskType === 'GROUP'` carries a `group_ID` (NOT a
 * tutorial) — the group's ordered tutorial list lives in `GroupPathItems`
 * (group_ID → tutorial_ID, ordered by itemOrder). The event / app-space
 * progress handlers emit one output item per path row, so a GROUP row would
 * render as a single untyped card with zero tutorials. This helper reads the
 * child tutorials once (batched across all groups in the path set) so each
 * GROUP can be flattened into its TUTORIAL children — mirroring
 * srv/lib/build-catalog.js's nested-group handling.
 *
 * @param {object} opts
 * @param {Array}  opts.items    CompletionPathItems rows (must include taskType, group_ID).
 * @param {object} opts.entities { GroupPathItems, Tutorials } CDS entities.
 * @returns {Promise<Map>} Map keyed by group_ID → ordered array of child
 *   tutorial rows ({ ID, legacyId, slug, title, description, experienceTag,
 *   averageTimeToComplete }). Empty map when there are no GROUP items.
 */
export async function expandGroupTutorials({ items, entities }) {
  const { GroupPathItems, Tutorials } = entities;

  const groupIds = [...new Set(
    items
      .filter(i => i.taskType === 'GROUP' && i.group_ID)
      .map(i => i.group_ID)
  )];
  const byGroupId = new Map();
  if (groupIds.length === 0) return byGroupId;

  // All child rows for every GROUP in one query, ordered so the per-group
  // slices stay in itemOrder.
  const gpItems = await SELECT.from(GroupPathItems)
    .where({ group_ID: { in: groupIds } })
    .orderBy('itemOrder');

  const tutorialUuids = [...new Set(gpItems.map(gpi => gpi.tutorial_ID).filter(Boolean))];
  const tutorialByUuid = new Map();
  if (tutorialUuids.length > 0) {
    for (const t of await SELECT.from(Tutorials).where({ ID: { in: tutorialUuids } })) {
      tutorialByUuid.set(t.ID, t);
    }
  }

  for (const gpi of gpItems) {
    const t = tutorialByUuid.get(gpi.tutorial_ID);
    if (!t) continue; // orphaned child; skip rather than emit a blank card
    if (!byGroupId.has(gpi.group_ID)) byGroupId.set(gpi.group_ID, []);
    byGroupId.get(gpi.group_ID).push(t);
  }
  return byGroupId;
}

/**
 * Shape a resolved tutorial row into the progress-handler output item.
 * Shared so direct path items and expanded GROUP children render identically.
 * @param {object} task    tutorial/checkpoint row (may be undefined)
 * @param {number|null} effLegacyId  effective legacyId (imsId + record key)
 * @param {object} record  user TaskRecord for this task (may be undefined)
 * @param {string} type    output item type ('TUTORIAL' | 'CHECKPOINT' | ...)
 */
// #2866 — App Space completion time window.
// App Space prize credit must reflect work done DURING the event. A COMPLETED
// TUTORIAL whose completionDate falls outside the event's inclusive
// [startDate, endDate] window is downgraded to the plain status
// 'COMPLETED_OUT_OF_WINDOW', which the Vue client (strict === 'COMPLETED'
// gating) does not count toward the track or prize barcode.
//
// FAIL-OPEN: gate only when BOTH event dates are present. If either is
// null/absent (or `event` is omitted, as getEventProgress does), behave
// exactly as before (any COMPLETED counts) — this protects non-TechEd /
// un-dated events and keeps getEventProgress time-agnostic. (Do NOT reuse
// cat-game-award.js's eventIsLive, which tolerates open bounds; our rule is
// stricter.) Null completionDate on a gated event cannot be proven in-window
// → downgraded. Only TUTORIAL items are gated.
const COMPLETED_OUT_OF_WINDOW = 'COMPLETED_OUT_OF_WINDOW';
function effectiveStatus(record, type, event) {
  const status = record?.status || '';
  if (!event || type !== 'TUTORIAL' || status !== 'COMPLETED') return status;
  const start = event.startDate ? Date.parse(event.startDate) : NaN;
  const end = event.endDate ? Date.parse(event.endDate) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return status; // fail-open: no usable window
  const done = record?.completionDate ? Date.parse(record.completionDate) : NaN;
  if (Number.isNaN(done) || done < start || done > end) return COMPLETED_OUT_OF_WINDOW;
  return status;
}

function shapeItem(task, effLegacyId, record, type, checkpointTitle, event, unavail) {
  return {
    imsId: effLegacyId,
    title: task?.title || record?.titleSnapshot || checkpointTitle || '',
    type,
    status: effectiveStatus(record, type, event),
    progress: record?.progress || 0,
    experience: task?.experienceTag || '',
    timeToComplete: task?.averageTimeToComplete || 0,
    url: task?.slug ? `/tutorials/${task.slug}.html` : '',
    description: task?.description || '',
    recordId: record?.legacyId || 0,
    // #2864: per-path-item temporarily-unavailable flag. Carried only for
    // direct items; GROUP-expanded children are stamped false by the caller
    // (not inherited from the parent GROUP item), matching the mission page
    // (packages/content/catalog-data.js). unavailableReason omitted when empty.
    temporarilyUnavailable: unavail?.temporarilyUnavailable === true,
    ...(unavail?.unavailableReason ? { unavailableReason: unavail.unavailableReason } : {}),
  };
}

/**
 * Build the ordered output items for a single path, expanding any GROUP item
 * into its child tutorials. Direct items keep their existing shape/behavior;
 * GROUP items are replaced (in place, preserving itemOrder) by one TUTORIAL
 * output item per child tutorial.
 *
 * Fixes the "0 tutorials" App-Space bug: a GROUP path item used to emit a
 * single `type:'GROUP'` card the frontend filtered out.
 *
 * @param {object} opts
 * @param {Array}  opts.pathItems       CompletionPathItems for this path, itemOrder-sorted.
 * @param {Map}    opts.taskMap         from buildTaskMap (direct items).
 * @param {Map}    opts.effLegacyByItem item → effective legacyId (direct items).
 * @param {Map}    opts.groupTutorials  group_ID → child tutorial rows (expandGroupTutorials).
 * @param {Map}    opts.recordMap       `${taskType}:${legacyId}` → user TaskRecord.
 * @param {object} [opts.event]         #2866: when provided (App Space only),
 *   gates COMPLETED tutorials to the event's [startDate,endDate] window — see
 *   effectiveStatus. Omit (getEventProgress) to keep status time-agnostic.
 * @returns {Array} output items
 */
export function buildPathItems({ pathItems, taskMap, effLegacyByItem, groupTutorials, recordMap, event }) {
  const out = [];
  for (const i of pathItems) {
    if (i.taskType === 'GROUP') {
      const children = (i.group_ID && groupTutorials.get(i.group_ID)) || [];
      for (const t of children) {
        const record = t.legacyId != null ? recordMap.get(`TUTORIAL:${t.legacyId}`) : undefined;
        // #2864: group children are NOT inherited-unavailable — stamp false.
        out.push(shapeItem(t, t.legacyId ?? null, record, 'TUTORIAL', null, event, null));
      }
      continue;
    }
    const task = resolveTask(taskMap, i);
    const effLegacyId = effLegacyByItem.get(i);
    const record = recordMap.get(`${i.taskType}:${effLegacyId}`);
    out.push(shapeItem(task, effLegacyId, record, i.taskType, i.checkpointTitle, event, i));
  }
  return out;
}

/**
 * The TUTORIAL legacyIds reachable through GROUP items (child tutorials), so
 * the handler can batch their user TaskRecord lookups alongside direct items.
 * @param {Map} groupTutorials  group_ID → child tutorial rows
 * @returns {number[]} de-duped legacyIds
 */
export function groupChildLegacyIds(groupTutorials) {
  const ids = new Set();
  for (const children of groupTutorials.values()) {
    for (const t of children) if (t.legacyId != null) ids.add(t.legacyId);
  }
  return [...ids];
}
