import cds from '@sap/cds';

const LOG = cds.log('chat');
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

// Resolve the chat user (XSUAA sub) to the internal Users.ID. Cached on the
// per-request user object so a single chat turn that uses both getUserProgress
// AND searchTutorials annotation doesn't pay two lookups.
async function resolveDbUserId(user) {
  if (!user?.id || user.id === 'anonymous') return null;
  if (user.__dbUserId !== undefined) return user.__dbUserId;
  try {
    const { Users } = cds.entities('com.sap.developers.ims');
    const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
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
    return { inProgress: [], completedSlugs: [], completedMissionSlugs: [], completedGroupSlugs: [] };
  }

  const limit = Math.min(Math.max(1, opts.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const { TaskRecords, Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

  const records = await SELECT.from(TaskRecords)
    .columns('taskLegacyId', 'taskType', 'status', 'progress', 'modifiedAt', 'completionDate', 'titleSnapshot')
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

    if (r.status === 'COMPLETED') {
      if (r.taskType === 'TUTORIAL') completedSlugs.push(meta.slug);
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

  return {
    inProgress: inProgress.slice(0, limit),
    completedSlugs,
    completedMissionSlugs,
    completedGroupSlugs
  };
}

// Lightweight lookup used by searchTutorials annotation. Returns a Map keyed
// by `${taskType}:${slug}` → { status, progressPercent }. Uses the same
// resolveDbUserId cache so the second call within a chat turn is cheap.
export async function getProgressLookup(user) {
  const dbUserId = await resolveDbUserId(user);
  const lookup = new Map();
  if (!dbUserId) return lookup;

  const { TaskRecords, Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

  const records = await SELECT.from(TaskRecords)
    .columns('taskLegacyId', 'taskType', 'status', 'progress')
    .where({
      user_ID: dbUserId,
      taskType: { in: ['TUTORIAL', 'MISSION', 'GROUP'] }
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
      progressPercent: typeof r.progress === 'number' ? r.progress : 0
    });
  }
  return lookup;
}
