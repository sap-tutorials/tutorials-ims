import cds from '@sap/cds';
import { resolveUserSapId } from './resolve-db-user.js';

const LOG = cds.log('chat');
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

// Resolve the chat user (XSUAA `user_uuid` claim = SAP ID) to the internal
// Users.ID. Cached on the per-request user object so a single chat turn that
// uses both getUserProgress AND searchTutorials annotation doesn't pay two
// lookups. Issue #343.
async function resolveDbUserId(user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  if (user.__dbUserId !== undefined) return user.__dbUserId;
  try {
    const { Users } = cds.entities('com.sap.developers.ims');
    const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
    user.__dbUserId = dbUser?.ID || null;
    return user.__dbUserId;
  } catch (err) {
    LOG.warn('resolveDbUserId failed', err.message);
    return null;
  }
}

// Returns the user's tutorial-level progress as two flat collections:
//   - inProgress: started but not finished, ordered by recency desc
//   - completedSlugs: tutorial slugs the user has finished (for negative filter)
// Includes mission/group completion as separate arrays so the LLM can avoid
// recommending entire collections the user has already finished.
export async function getUserProgress(user, opts = {}) {
  const dbUserId = await resolveDbUserId(user);
  if (!dbUserId) {
    return { inProgress: [], completedSlugs: [], lastCompletedSlug: null, completedMissionSlugs: [], completedGroupSlugs: [] };
  }

  const limit = Math.min(Math.max(1, opts.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const { TaskRecords, Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

  const records = await SELECT.from(TaskRecords)
    .columns('taskLegacyId', 'taskType', 'status', 'progress', 'modifiedAt', 'completionDate', 'titleSnapshot', 'attemptNumber')
    .where({
      user_ID: dbUserId,
      taskType: { in: ['TUTORIAL', 'MISSION', 'GROUP'] }
    });

  const tutorialIds = [];
  const missionIds  = [];
  const groupIds    = [];
  for (const r of records) {
    if (r.taskType === 'TUTORIAL') tutorialIds.push(r.taskLegacyId);
    else if (r.taskType === 'MISSION') missionIds.push(r.taskLegacyId);
    else if (r.taskType === 'GROUP') groupIds.push(r.taskLegacyId);
  }

  const [tutorials, missions, groups] = await Promise.all([
    tutorialIds.length
      ? SELECT.from(Tutorials).columns('legacyId', 'slug', 'title').where({ legacyId: { in: tutorialIds } })
      : [],
    missionIds.length
      ? SELECT.from(Missions).columns('legacyId', 'slug', 'title').where({ legacyId: { in: missionIds } })
      : [],
    groupIds.length
      // CompletionPaths uses `name`, not `title` — alias it as `title` so the
      // downstream meta map is uniform across all three entity types.
      ? SELECT.from(CompletionPaths).columns('legacyId', 'slug', 'name as title').where({ legacyId: { in: groupIds } })
      : []
  ]);

  const tutorialMeta = new Map(tutorials.map(t => [t.legacyId, t]));
  const missionMeta  = new Map(missions.map(m => [m.legacyId, m]));
  const groupMeta    = new Map(groups.map(g => [g.legacyId, g]));

  const inProgress = [];
  const completedSlugs = [];
  const completedMissionSlugs = [];
  const completedGroupSlugs = [];

  for (const r of records) {
    const meta =
      r.taskType === 'TUTORIAL' ? tutorialMeta.get(r.taskLegacyId) :
      r.taskType === 'MISSION'  ? missionMeta.get(r.taskLegacyId)  :
      groupMeta.get(r.taskLegacyId);
    if (!meta?.slug) continue; // legacyId without a current slug → skip

    if (r.status === 'COMPLETED' || r.status === 'SUPERSEDED') {
      // Task 8 (#600): SUPERSEDED rows preserve the historical completion —
      // a user mid-attempt-2 has SUPERSEDED-from-attempt-1 + IN_PROGRESS
      // attempt-2 rows; from the LLM's perspective they have "completed"
      // the tutorial already, so surface it in completedSlugs.
      if (r.taskType === 'TUTORIAL') {
        // Capture completionDate so we can pick the most-recently-completed
        // tutorial slug downstream (recommendations rail anchor, issue #202).
        // Falls back to modifiedAt when completionDate is null on legacy rows.
        const completedAt = r.completionDate || r.modifiedAt || null;
        completedSlugs.push({ slug: meta.slug, completedAt });
      }
      else if (r.taskType === 'MISSION') completedMissionSlugs.push(meta.slug);
      else if (r.taskType === 'GROUP') completedGroupSlugs.push(meta.slug);
    } else if (r.status === 'IN_PROGRESS' && r.taskType === 'TUTORIAL') {
      inProgress.push({
        slug: meta.slug,
        title: meta.title || r.titleSnapshot || meta.slug,
        progressPercent: typeof r.progress === 'number' ? r.progress : 0,
        lastTouchedAt: r.modifiedAt || null
      });
    }
  }

  inProgress.sort((a, b) => {
    const at = a.lastTouchedAt ? new Date(a.lastTouchedAt).getTime() : 0;
    const bt = b.lastTouchedAt ? new Date(b.lastTouchedAt).getTime() : 0;
    return bt - at;
  });

  // Order completed tutorials newest-first then collapse to plain slug array
  // for backward compatibility. The newest slug is also surfaced separately as
  // lastCompletedSlug for the /browse/ recommendations rail (issue #202).
  completedSlugs.sort((a, b) => {
    const at = a.completedAt ? new Date(a.completedAt).getTime() : 0;
    const bt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
    return bt - at;
  });
  const lastCompletedSlug = completedSlugs.length > 0 ? completedSlugs[0].slug : null;
  // Dedupe: a user with multiple completion attempts on the same tutorial
  // (COMPLETED + SUPERSEDED rows post-Task-8) would otherwise see the slug
  // twice in this list. The LLM only needs the as-a-set view ("has the user
  // ever completed this?"); the row-per-attempt view lives in /me/ via
  // getMyCompletedTutorials.
  const seen = new Set();
  const completedSlugList = [];
  for (const c of completedSlugs) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    completedSlugList.push(c.slug);
  }

  return {
    inProgress: inProgress.slice(0, limit),
    completedSlugs: completedSlugList,
    lastCompletedSlug,
    completedMissionSlugs,
    completedGroupSlugs
  };
}

// Returns the user's completed-tutorial history for the public /me page.
// Each row is one TUTORIAL TaskRecord with status in (COMPLETED, SUPERSEDED),
// joined with Tutorials by legacyId so we can render slug + title +
// tag/experience/time. Anonymous users return an empty array. Skips records
// whose legacyId no longer maps to a current Tutorial slug (legacy/orphaned
// data).
//
// Task 7 (#600): SUPERSEDED rows count as historical completions. A user who
// completed a tutorial, hit "Reset progress", and completed it again sees BOTH
// completions in /me/ (sorted completionDate DESC). No dedupe — N completions
// of the same tutorial show as N rows. attemptNumber is passed through.
export async function getMyCompletedTutorials(user) {
  const dbUserId = await resolveDbUserId(user);
  if (!dbUserId) return [];

  const { TaskRecords, Tutorials } = cds.entities('com.sap.developers.ims');

  const records = await SELECT.from(TaskRecords)
    .columns('taskLegacyId', 'completionDate', 'modifiedAt', 'titleSnapshot', 'attemptNumber')
    .where({
      user_ID: dbUserId,
      taskType: 'TUTORIAL',
      status: { in: ['COMPLETED', 'SUPERSEDED'] }
    });
  if (records.length === 0) return [];

  const tutorialIds = records.map(r => r.taskLegacyId);
  const tutorials = await SELECT.from(Tutorials)
    .columns('legacyId', 'slug', 'title', 'primaryTag', 'experienceTag', 'averageTimeToComplete')
    .where({ legacyId: { in: tutorialIds } });
  const meta = new Map(tutorials.map(t => [t.legacyId, t]));

  const rows = [];
  for (const r of records) {
    const t = meta.get(r.taskLegacyId);
    if (!t?.slug) continue;
    rows.push({
      slug: t.slug,
      title: t.title || r.titleSnapshot || t.slug,
      primaryTag: t.primaryTag || null,
      experienceTag: t.experienceTag || null,
      averageTimeToComplete: typeof t.averageTimeToComplete === 'number' ? t.averageTimeToComplete : null,
      completionDate: r.completionDate || r.modifiedAt || null,
      attemptNumber: typeof r.attemptNumber === 'number' ? r.attemptNumber : 1
    });
  }

  rows.sort((a, b) => {
    const at = a.completionDate ? new Date(a.completionDate).getTime() : 0;
    const bt = b.completionDate ? new Date(b.completionDate).getTime() : 0;
    return bt - at;
  });

  return rows;
}

// Lightweight lookup used by searchTutorials annotation. Returns a Map keyed
// by `${taskType}:${slug}` → { status, progressPercent, attemptNumber }. Uses
// the same resolveDbUserId cache so the second call within a chat turn is
// cheap.
//
// Task 8 (#600): SUPERSEDED rows are filtered out — this map is consumed by
// the searchTutorials annotation which renders a per-hit badge based on the
// CURRENT user state ("in-progress", "completed", "new"). A user mid-attempt-2
// has a SUPERSEDED-from-attempt-1 row AND an IN_PROGRESS attempt-2 row; the
// hit should show as "in-progress", not "completed". Historical completions
// for the LLM live in getUserProgress.completedSlugs (which DOES include
// SUPERSEDED). Surface raw shape — callers decide what to display.
export async function getProgressLookup(user) {
  const dbUserId = await resolveDbUserId(user);
  const lookup = new Map();
  if (!dbUserId) return lookup;

  const { TaskRecords, Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

  const records = await SELECT.from(TaskRecords)
    .columns('taskLegacyId', 'taskType', 'status', 'progress', 'attemptNumber')
    .where({
      user_ID: dbUserId,
      taskType: { in: ['TUTORIAL', 'MISSION', 'GROUP'] },
      status: { '!=': 'SUPERSEDED' }
    });

  if (records.length === 0) return lookup;

  const byType = { TUTORIAL: [], MISSION: [], GROUP: [] };
  for (const r of records) {
    if (byType[r.taskType]) byType[r.taskType].push(r.taskLegacyId);
  }

  const [tutorials, missions, groups] = await Promise.all([
    byType.TUTORIAL.length
      ? SELECT.from(Tutorials).columns('legacyId', 'slug').where({ legacyId: { in: byType.TUTORIAL } })
      : [],
    byType.MISSION.length
      ? SELECT.from(Missions).columns('legacyId', 'slug').where({ legacyId: { in: byType.MISSION } })
      : [],
    byType.GROUP.length
      ? SELECT.from(CompletionPaths).columns('legacyId', 'slug').where({ legacyId: { in: byType.GROUP } })
      : []
  ]);

  const slugByType = {
    TUTORIAL: new Map(tutorials.map(t => [t.legacyId, t.slug])),
    MISSION:  new Map(missions.map(m => [m.legacyId, m.slug])),
    GROUP:    new Map(groups.map(g => [g.legacyId, g.slug]))
  };

  for (const r of records) {
    const slug = slugByType[r.taskType]?.get(r.taskLegacyId);
    if (!slug) continue;
    lookup.set(`${r.taskType}:${slug}`, {
      status: r.status,
      progressPercent: typeof r.progress === 'number' ? r.progress : 0,
      attemptNumber: typeof r.attemptNumber === 'number' ? r.attemptNumber : 1
    });
  }
  return lookup;
}
