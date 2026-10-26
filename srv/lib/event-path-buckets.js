import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

/**
 * Resolve the event's mission ID using the SAME precedence as app-space
 * (getAppSpaceProgress): forward Events.mission_ID, else the Missions.event_ID
 * backlink (the only link the admin UI exposes), tie-broken by published then
 * legacyId. Returns null when no mission is configured.
 */
export async function resolveEventMissionId(event, db) {
  const { Missions } = cds.entities(NS);
  if (event?.mission_ID) return event.mission_ID;
  const linked = await db.run(
    SELECT.one.from(Missions).columns('ID')
      .where({ event_ID: event.ID })
      .orderBy('published desc', 'legacyId')
  );
  return linked?.ID ?? null;
}

/**
 * Build the map (taskType:taskLegacyId) → Set(path display-name) for an event's
 * mission tracks — direct CompletionPathItems plus GROUP items expanded through
 * GroupPathItems to their child tutorials. This is the single source of truth
 * for "which track(s) does a completed tutorial belong to", shared by the
 * display bucket aggregation (computePathBuckets) and the realtime socket emit
 * so both label completions with the SAME track names the app-space page uses.
 *
 * Returns { pathNameByToken: Map<string, Set<string>>, pathNameById: Map }.
 */
export async function buildTrackMap(missionId, db) {
  const { CompletionPaths, CompletionPathItems, GroupPathItems } = cds.entities(NS);
  const pathNameByToken = new Map();

  const paths = await db.run(
    SELECT.from(CompletionPaths).columns('ID', 'name').where({ mission_ID: missionId }).orderBy('legacyId')
  );
  const pathNameById = new Map(paths.map(p => [p.ID, p.name || '']));
  if (!paths.length) return { pathNameByToken, pathNameById };

  const pathIds = paths.map(p => p.ID);
  const items = await db.run(
    SELECT.from(CompletionPathItems).columns('path_ID', 'taskType', 'taskLegacyId', 'group_ID')
      .where({ path_ID: { in: pathIds } })
  );

  const addToken = (tok, pid) => {
    const name = pathNameById.get(pid);
    if (name == null) return;
    if (!pathNameByToken.has(tok)) pathNameByToken.set(tok, new Set());
    pathNameByToken.get(tok).add(name);
  };

  const groupToPaths = new Map();   // group_ID → Set(path_ID)
  for (const it of items) {
    if (!it.path_ID) continue;
    if (it.taskType === 'GROUP' && it.group_ID) {
      if (!groupToPaths.has(it.group_ID)) groupToPaths.set(it.group_ID, new Set());
      groupToPaths.get(it.group_ID).add(it.path_ID);
    } else if (it.taskLegacyId != null) {
      addToken(`${it.taskType}:${it.taskLegacyId}`, it.path_ID);
    }
  }

  const groupIds = [...groupToPaths.keys()];
  if (groupIds.length) {
    const gpi = await db.run(
      SELECT.from(GroupPathItems).columns('group_ID', 'tutorial.legacyId as tutLegacyId')
        .where({ group_ID: { in: groupIds } })
    );
    for (const row of gpi) {
      if (row.tutLegacyId == null) continue;
      for (const pid of groupToPaths.get(row.group_ID) ?? []) {
        addToken(`TUTORIAL:${row.tutLegacyId}`, pid);
      }
    }
  }

  return { pathNameByToken, pathNameById };
}

/**
 * Track names a single completed tutorial belongs to within an event's mission.
 * Used by the realtime socket emit to label a live completion with the SAME
 * track name(s) the display buckets use. Returns [] if the tutorial is not a
 * member of any track (→ no bar, consistent with the fetch aggregation).
 */
export async function trackNamesForTutorial(event, tutorialLegacyId, db) {
  const missionId = await resolveEventMissionId(event, db);
  if (!missionId) return [];
  const { pathNameByToken } = await buildTrackMap(missionId, db);
  return [...(pathNameByToken.get(`TUTORIAL:${tutorialLegacyId}`) ?? [])];
}

/**
 * Per-path ("track") completion buckets for an event's display dashboard.
 *
 * A "track" is one CompletionPaths row under the event's Mission — the SAME
 * definition the app-space page renders (srv/developer-service.js
 * getAppSpaceProgress). We deliberately reuse that resolution rather than
 * invent a new grouping:
 *
 *   event → mission (Events.mission_ID, else Missions.event_ID backlink)
 *         → CompletionPaths where mission_ID        (each row = one track)
 *         → CompletionPathItems where path_ID in …  ((taskType,taskLegacyId) → path)
 *           + GroupPathItems for GROUP items        (child tutorial → group → path)
 *
 * Then window-scoped TUTORIAL completions ([startDate,endDate]) are mapped to
 * their path(s) and counted. A completion can belong to more than one path
 * (a tutorial reused across tracks) — it is counted once per path it belongs
 * to, matching how app-space shows the tutorial in each track.
 *
 * Returns [{ bucketName: path.name, count, percentage }] sorted desc by count.
 * Empty array when the event has no window, no mission, or no paths.
 *
 * @param {object} event  resolved Events row (needs ID, startDate, endDate, mission_ID)
 * @param {object} db     cds db service
 */
export async function computePathBuckets(event, db) {
  if (!event?.startDate || !event?.endDate) return [];

  const { TaskRecords } = cds.entities(NS);

  // 1. Resolve the event's mission + the (taskType:taskLegacyId) → track-name
  //    map — SAME resolution the app-space page uses (shared helpers).
  const missionId = await resolveEventMissionId(event, db);
  if (!missionId) return [];
  const { pathNameByToken } = await buildTrackMap(missionId, db);
  if (pathNameByToken.size === 0) return [];

  // 2. Window-scoped TUTORIAL completions → count distinct users per track.
  const records = await db.run(
    SELECT.from(TaskRecords).columns('user_ID', 'taskLegacyId')
      .where({ taskType: 'TUTORIAL', status: { in: ['COMPLETED', 'SUPERSEDED'] } })
      .and(`completionDate >=`, event.startDate)
      .and(`completionDate <=`, event.endDate)
  );

  const seen = new Set();                // dedupe (user, track-name)
  const countByName = new Map();
  for (const r of records) {
    const names = pathNameByToken.get(`TUTORIAL:${r.taskLegacyId}`);
    if (!names) continue;
    for (const name of names) {
      const key = `${r.user_ID}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      countByName.set(name, (countByName.get(name) || 0) + 1);
    }
  }

  const total = [...countByName.values()].reduce((s, n) => s + n, 0);
  return [...countByName.entries()]
    .map(([bucketName, count]) => ({
      bucketName,
      count,
      percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}
