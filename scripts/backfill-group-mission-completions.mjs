// scripts/backfill-group-mission-completions.mjs
//
// Bulk backfill of GROUP/MISSION completions from post-cutover item completions
// (issue #1934). The CAP platform never minted GROUP/MISSION rollups; this
// recomputes them from existing TUTORIAL/PUZZLE/CHECKPOINT/PETOBERFEST
// completions for users active since the cutover. Does NOT send to NGDS — that
// is scripts/backfill-ngds-send.mjs. Idempotent (upsert keyed on the record).
//
// Usage:
//   cds env / bind first, then:
//   node scripts/backfill-group-mission-completions.mjs --dry-run
//   node scripts/backfill-group-mission-completions.mjs --since=2026-08-10T00:00:00Z
//   node scripts/backfill-group-mission-completions.mjs --user=P000123
import cds from '@sap/cds';
import { rollUpParentsForCompletion } from '../srv/lib/completion-rollup.js';

const DEFAULT_SINCE = '2026-08-10T00:00:00Z';
const ITEM_TYPES = ['TUTORIAL', 'PUZZLE', 'CHECKPOINT', 'PETOBERFEST'];

/**
 * @param {{since?:string, dryRun?:boolean, userSapId?:string|null, db?:object}} opts
 * @returns {Promise<{users:number, groupsCompleted:number, missionsCompleted:number, dryRun:boolean}>}
 */
export async function runBackfill({ since = DEFAULT_SINCE, dryRun = false, userSapId = null, db } = {}) {
  const database = db || await cds.connect.to('db');
  const { TaskRecords, Users, Tutorials } = cds.entities('com.sap.developers.ims');

  // Users with a post-cutover COMPLETED item record.
  const recs = await database.run(
    SELECT.from(TaskRecords).columns('user_ID', 'taskType', 'taskLegacyId')
      .where({ status: 'COMPLETED', taskType: { in: ITEM_TYPES }, completionDate: { '>=': since } })
  );

  let allowedUserId = null;
  if (userSapId) {
    const u = await database.run(SELECT.one.from(Users).columns('ID').where({ sapId: userSapId }));
    allowedUserId = u ? u.ID : '__none__';
  }

  const byUser = new Map();
  for (const r of recs) {
    if (!r.user_ID) continue;
    if (allowedUserId && r.user_ID !== allowedUserId) continue;
    if (!byUser.has(r.user_ID)) byUser.set(r.user_ID, []);
    byUser.get(r.user_ID).push(r);
  }

  if (!dryRun) {
    for (const [userId, items] of byUser) {
      // Resolve tutorialId for TUTORIAL items (needed for group-parent lookup).
      const tutLegacyIds = [...new Set(items.filter(i => i.taskType === 'TUTORIAL').map(i => i.taskLegacyId))];
      const tuts = tutLegacyIds.length
        ? await database.run(SELECT.from(Tutorials).columns('ID', 'legacyId').where({ legacyId: { in: tutLegacyIds } }))
        : [];
      const tutIdByLegacy = new Map(tuts.map(t => [t.legacyId, t.ID]));
      // De-dupe triggers by (taskType, taskLegacyId); the rollup recomputes from
      // the user's full record state, so one trigger per distinct item is enough.
      const seen = new Set();
      for (const it of items) {
        const k = `${it.taskType}:${it.taskLegacyId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        await rollUpParentsForCompletion({
          dbUser: { ID: userId },
          task: { taskType: it.taskType, taskLegacyId: it.taskLegacyId, tutorialId: tutIdByLegacy.get(it.taskLegacyId) },
          db: database,
          send: false,
        });
      }
    }
  }

  const grp = await database.run(SELECT.from(TaskRecords).columns('ID').where({ taskType: 'GROUP', status: 'COMPLETED' }));
  const mis = await database.run(SELECT.from(TaskRecords).columns('ID').where({ taskType: 'MISSION', status: 'COMPLETED' }));
  return { users: byUser.size, groupsCompleted: grp.length, missionsCompleted: mis.length, dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : def;
  };
  const dryRun = process.argv.includes('--dry-run');
  cds.connect.to('db').then(async (db) => {
    const r = await runBackfill({ since: arg('since', DEFAULT_SINCE), dryRun, userSapId: arg('user', null), db });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
