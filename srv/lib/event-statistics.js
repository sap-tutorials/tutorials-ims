/**
 * Compute task completion counts by type and unique user count.
 * @param {Array} records - TaskRecords with taskType, status, user_ID
 * @returns {{ tutorials: number, groups: number, missions: number, uniqueUsers: number }}
 */
export function computeEventStatistics(records) {
  const completed = records.filter(r => r.status === 'COMPLETED');
  const users = new Set();
  let tutorials = 0, groups = 0, missions = 0;

  for (const r of completed) {
    users.add(r.user_ID);
    if (r.taskType === 'TUTORIAL') tutorials++;
    else if (r.taskType === 'GROUP') groups++;
    else if (r.taskType === 'MISSION') missions++;
  }

  return { tutorials, groups, missions, uniqueUsers: users.size };
}

/**
 * Compute daily completion burnup with cumulative totals.
 * @param {Array} records - Completed TaskRecords with completionDate
 * @param {string} tzOffset - Timezone offset string like "+05:00" or "-08:00"
 * @returns {Array<{ day: string, count: number, cumulative: number }>}
 */
export function computeBurnup(records, tzOffset) {
  if (records.length === 0) return [];

  const offsetMs = parseOffsetToMs(tzOffset);
  const dayCounts = new Map();

  for (const r of records) {
    if (!r.completionDate) continue;
    const adjusted = new Date(new Date(r.completionDate).getTime() + offsetMs);
    const day = adjusted.toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }

  const sorted = [...dayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let cumulative = 0;
  return sorted.map(([day, count]) => {
    cumulative += count;
    return { day, count, cumulative };
  });
}

/**
 * Aggregate completions per mission (track stats).
 * @param {Array} records - TaskRecords with taskLegacyId, user_ID, status
 * @param {Array} missions - Mission entities with legacyId, title
 */
export function computeTrackStats(records, missions) {
  const completed = records.filter(r => r.status === 'COMPLETED');
  const missionMap = new Map(missions.map(m => [m.legacyId, m.title]));
  const stats = new Map();

  for (const r of completed) {
    if (!missionMap.has(r.taskLegacyId)) continue;
    if (!stats.has(r.taskLegacyId)) {
      stats.set(r.taskLegacyId, { users: new Set(), completions: 0 });
    }
    const s = stats.get(r.taskLegacyId);
    s.users.add(r.user_ID);
    s.completions++;
  }

  return missions
    .filter(m => stats.has(m.legacyId))
    .map(m => {
      const s = stats.get(m.legacyId);
      return {
        missionLegacyId: m.legacyId,
        title: m.title,
        uniqueUsers: s.users.size,
        completions: s.completions
      };
    });
}

/**
 * Calculate average completion time per task.
 * @param {Array} records - TaskRecords with taskLegacyId, completionTime (seconds)
 * @param {Array} tasks - Task entities with legacyId, title
 */
export function computeCompletionSpeed(records, tasks) {
  const taskMap = new Map(tasks.map(t => [t.legacyId, t.title]));
  const grouped = new Map();

  for (const r of records) {
    if (r.completionTime == null || !taskMap.has(r.taskLegacyId)) continue;
    if (!grouped.has(r.taskLegacyId)) grouped.set(r.taskLegacyId, []);
    grouped.get(r.taskLegacyId).push(r.completionTime);
  }

  return tasks
    .filter(t => grouped.has(t.legacyId))
    .map(t => {
      const times = grouped.get(t.legacyId);
      const avgSeconds = times.reduce((sum, v) => sum + Number(v), 0) / times.length;
      return {
        taskLegacyId: t.legacyId,
        title: t.title,
        avgMinutes: Math.round(avgSeconds / 60),
        completions: times.length
      };
    });
}

/**
 * Compute leaderboard: top N users by completion count.
 * @param {Array} records - TaskRecords with user_ID, status
 * @param {Array} users - User entities with ID, legacyId, displayName
 * @param {number} top - Number of users to return
 */
export function computeLeaderboard(records, users, top) {
  const completed = records.filter(r => r.status === 'COMPLETED');
  const counts = new Map();

  for (const r of completed) {
    counts.set(r.user_ID, (counts.get(r.user_ID) || 0) + 1);
  }

  const userMap = new Map(users.map(u => [u.ID, u]));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([userId, completions]) => {
      const user = userMap.get(userId);
      return {
        userLegacyId: user?.legacyId || 0,
        displayName: user?.displayName || '',
        completions,
        points: completions * 10
      };
    });
}

function parseOffsetToMs(offset) {
  if (!offset) return 0;
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (parseInt(match[2]) * 3600000 + parseInt(match[3]) * 60000);
}
