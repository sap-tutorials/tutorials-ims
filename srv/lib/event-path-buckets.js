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
 * #1866: manually-authored event content populates a path/group item's
 * `tutorial_ID` FK (UUID) and leaves `taskLegacyId` NULL — this is the normal
 * shape for the TechEd/DSAG event missions, NOT a data defect. TaskRecords key
 * completions by `taskLegacyId`, so every such item must be resolved FK-first
 * (tutorial_ID → Tutorials.legacyId) before it can be matched to a completion.
 * The earlier legacyId-only read missed all FK-only items, so whole tracks
 * (e.g. "Joule Studio with N8N", "Frontend") counted 0 despite real tutorials
 * and real activity. This mirrors path-item-task-resolver.buildTaskMap.
 *
 * Returns { pathNameByToken: Map<string, Set<string>>, pathNameById: Map }.
 */
export async function buildTrackMap(missionId, db) {
  const { Tutorials, CompletionPaths, CompletionPathItems, GroupPathItems } = cds.entities(NS);
  const pathNameByToken = new Map();

  const paths = await db.run(
    SELECT.from(CompletionPaths).columns('ID', 'name').where({ mission_ID: missionId }).orderBy('legacyId')
  );
  const pathNameById = new Map(paths.map(p => [p.ID, p.name || '']));
  if (!paths.length) return { pathNameByToken, pathNameById };

  const pathIds = paths.map(p => p.ID);
  const items = await db.run(
    SELECT.from(CompletionPathItems).columns('path_ID', 'taskType', 'taskLegacyId', 'tutorial_ID', 'group_ID')
      .where({ path_ID: { in: pathIds } })
  );

  const addToken = (tok, pid) => {
    const name = pathNameById.get(pid);
    if (name == null) return;
    if (!pathNameByToken.has(tok)) pathNameByToken.set(tok, new Set());
    pathNameByToken.get(tok).add(name);
  };

  // Collect tutorial_ID UUIDs that need legacyId resolution (direct items +,
  // after the GROUP query below, group children). Map each (tutorial_ID → path).
  const tutUuidToPaths = new Map();     // tutorial_ID → Set(path_ID)
  const groupToPaths = new Map();       // group_ID → Set(path_ID)
  const addUuidPath = (uuid, pid) => {
    if (!tutUuidToPaths.has(uuid)) tutUuidToPaths.set(uuid, new Set());
    tutUuidToPaths.get(uuid).add(pid);
  };

  for (const it of items) {
    if (!it.path_ID) continue;
    if (it.taskType === 'GROUP' && it.group_ID) {
      if (!groupToPaths.has(it.group_ID)) groupToPaths.set(it.group_ID, new Set());
      groupToPaths.get(it.group_ID).add(it.path_ID);
    } else if (it.taskType === 'TUTORIAL') {
      // FK-first (#1866): prefer tutorial_ID; else the item's own taskLegacyId.
      if (it.tutorial_ID) addUuidPath(it.tutorial_ID, it.path_ID);
      else if (it.taskLegacyId != null) addToken(`TUTORIAL:${it.taskLegacyId}`, it.path_ID);
    } else if (it.taskLegacyId != null) {
      // CHECKPOINT / PETOBERFEST carry no FK — legacyId only (unchanged).
      addToken(`${it.taskType}:${it.taskLegacyId}`, it.path_ID);
    }
  }

  // Expand GROUP items to their child tutorials (GroupPathItems), FK-first too.
  const groupIds = [...groupToPaths.keys()];
  if (groupIds.length) {
    const gpi = await db.run(
      SELECT.from(GroupPathItems).columns('group_ID', 'tutorial_ID')
        .where({ group_ID: { in: groupIds } })
    );
    for (const row of gpi) {
      if (!row.tutorial_ID) continue;
      for (const pid of groupToPaths.get(row.group_ID) ?? []) {
        addUuidPath(row.tutorial_ID, pid);
      }
    }
  }

  // Resolve all collected tutorial_ID UUIDs → legacyId in one batch, then key
  // the map by legacyId (what TaskRecords.taskLegacyId carries).
  const uuids = [...tutUuidToPaths.keys()];
  if (uuids.length) {
    const tuts = await db.run(
      SELECT.from(Tutorials).columns('ID', 'legacyId').where({ ID: { in: uuids } })
    );
    for (const t of tuts) {
      if (t.legacyId == null) continue;
      for (const pid of tutUuidToPaths.get(t.ID) ?? []) {
        addToken(`TUTORIAL:${t.legacyId}`, pid);
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
 * their track(s) and counted. Every completion counts (NOT distinct users) —
 * a track with 5 tutorial completions reads 5, even by one person. A completion
 * can belong to more than one track (a tutorial reused across tracks) and is
 * counted once per track, matching how app-space shows it in each.
 *
 * NOTE: only TUTORIAL completions are counted. CHECKPOINT path items in the
 * current data carry null taskLegacyId (no join key) and there are no checkpoint
 * completions to credit, so checkpoint counting is deferred (would be inert).
 *
 * Returns { buckets, totalCompletions }:
 *   buckets          [{ bucketName: track.name, count, percentage }] desc by count
 *   totalCompletions ALL window TUTORIAL completions, regardless of track
 *                    membership — the display hero number ("total activity").
 * buckets is [] when the event has no window/mission/paths; totalCompletions is
 * still returned (0 when no window).
 *
 * @param {object} event  resolved Events row (needs ID, startDate, endDate, mission_ID)
 * @param {object} db     cds db service
 */
export async function computePathBuckets(event, db) {
  if (!event?.startDate || !event?.endDate) return { buckets: [], totalCompletions: 0 };

  const { TaskRecords } = cds.entities(NS);

  // Window-scoped TUTORIAL completions — the hero "total activity" counts ALL
  // of these, regardless of whether the tutorial belongs to an event track.
  const records = await db.run(
    SELECT.from(TaskRecords).columns('taskLegacyId')
      .where({ taskType: 'TUTORIAL', status: { in: ['COMPLETED', 'SUPERSEDED'] } })
      .and(`completionDate >=`, event.startDate)
      .and(`completionDate <=`, event.endDate)
  );
  const totalCompletions = records.length;

  // Resolve the event's mission + the (taskType:taskLegacyId) → track-name map —
  // SAME resolution the app-space page uses (shared helpers).
  const missionId = await resolveEventMissionId(event, db);
  if (!missionId) return { buckets: [], totalCompletions };
  const { pathNameByToken } = await buildTrackMap(missionId, db);
  if (pathNameByToken.size === 0) return { buckets: [], totalCompletions };

  // Per-track bars: count every completion (NOT distinct users) whose tutorial
  // is a member of the track. One completion in N tracks counts once per track.
  const countByName = new Map();
  for (const r of records) {
    const names = pathNameByToken.get(`TUTORIAL:${r.taskLegacyId}`);
    if (!names) continue;
    for (const name of names) {
      countByName.set(name, (countByName.get(name) || 0) + 1);
    }
  }

  const total = [...countByName.values()].reduce((s, n) => s + n, 0);
  const buckets = [...countByName.entries()]
    .map(([bucketName, count]) => ({
      bucketName,
      count,
      percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return { buckets, totalCompletions };
}
