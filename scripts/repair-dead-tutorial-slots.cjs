/* eslint-disable no-console */
/**
 * General repair: strip retired (INACTIVE/DELETED) tutorials from completion
 * paths and reconcile affected Group/Mission completion, without demoting any
 * user who was already COMPLETED.
 *
 * Background: a retired tutorial left in a mission's CompletionPathItems or a
 * group's GroupPathItems stays a REQUIRED slot (the rollup + NavigatorCatalog
 * view key on taskLegacyId / tutorial FK and do NOT filter on Tutorials.STATUS),
 * so the parent can never reach 100%. Users report "finished everything, still
 * stuck at N/M". Reported cases: #2718 (mission 12479), #2719 (mission 12052),
 * #2722 (mission 16326, group 16325). The durable fix is the completion
 * cascade/self-heal rework (#2732); this tool is the fleet-wide stopgap that
 * clears every dead slot at once and keeps existing completers whole.
 *
 * Operation (strip-only — all observed cases are pure retirements with no live
 * successor; repoint is never correct for a dead slot and stays a manual script):
 *   SCAN       find every CompletionPathItems/GroupPathItems whose tutorial is
 *              INACTIVE or DELETED; report slug, status, completers, parents.
 *   STRIP      DELETE those slots (snapshot each first).
 *   RECONCILE  for every affected group/mission, replay the REAL rollup
 *              (rollUpParentsForCompletion, send:false) per affected user so the
 *              reduced path recomputes — group first then mission (findParents
 *              walks child→group→mission in one call).
 *   GRANDFATHER never demote: snapshot every COMPLETED Group/Mission TaskRecord
 *              for affected parents BEFORE reconcile; after reconcile, restore
 *              any that the recompute downgraded (CAP's upsert downgrades, unlike
 *              legacy). Credit is preserved; only upgrades/new-completions stick.
 *
 * Single-process lock (.migration-data/.repair-lock) — refuses to start if held,
 * because two concurrent --commit runs race the grandfather set (caused 1068
 * duplicate inserts during #2719). Removed on clean exit.
 *
 * Modes: --dry-run (default) | --commit | --verify-only
 * Run via: npx cds bind --exec -- node scripts/repair-dead-tutorial-slots.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const NS = 'com.sap.developers.ims';
const CPI = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
const GPI = '"COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS"';
const TUT = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
const TR = '"COM_SAP_DEVELOPERS_IMS_TASKRECORDS"';
const DEAD = `('INACTIVE','DELETED')`;

const MIG_DIR = path.resolve(__dirname, '..', '.migration-data');
const LOCK = path.join(MIG_DIR, '.repair-lock');
const SNAP = path.join(MIG_DIR, `dead-slot-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
let snapInit = false;
function snap(r) { if (!snapInit) { fs.mkdirSync(MIG_DIR, { recursive: true }); snapInit = true; } fs.appendFileSync(SNAP, JSON.stringify(r) + '\n'); }

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERIFY_ONLY = argv.includes('--verify-only');
if (COMMIT && VERIFY_ONLY) { console.error('--commit and --verify-only are mutually exclusive'); process.exit(1); }

function acquireLock() {
  fs.mkdirSync(MIG_DIR, { recursive: true });
  try { fs.writeFileSync(LOCK, `pid ${process.pid} @ ${new Date().toISOString()}`, { flag: 'wx' }); }
  catch { console.error(`FATAL: lock held (${LOCK}). Another repair run is active — refusing (prevents the #2719 double-insert race). Delete the lock only if you are sure no run is live.`); process.exit(1); }
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch { /* ignore */ } }

async function main() {
  const { rollUpParentsForCompletion } = await import(pathToFileURL(path.resolve(__dirname, '..', 'srv/lib/completion-rollup.js')).href);

  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name?.includes('Hana');
  if (!isHana) { console.error('FATAL: run on HANA via `cds bind --exec`.'); process.exit(1); }

  // ── SCAN ──────────────────────────────────────────────────────────────
  const cpiDead = await db.run(
    `SELECT i."ID", i."PATH_ID", i."TASKLEGACYID", i."TUTORIAL_ID", i."ITEMORDER",
            t."SLUG", t."STATUS", p."MISSION_ID"
       FROM ${CPI} i JOIN ${TUT} t ON t."LEGACYID" = i."TASKLEGACYID"
       JOIN "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" p ON p."ID" = i."PATH_ID"
      WHERE i."TASKTYPE" = 'TUTORIAL' AND t."STATUS" IN ${DEAD}`
  );
  const gpiDead = await db.run(
    `SELECT i."ID", i."GROUP_ID", i."TUTORIAL_ID", i."ITEMORDER", t."LEGACYID", t."SLUG", t."STATUS"
       FROM ${GPI} i JOIN ${TUT} t ON t."ID" = i."TUTORIAL_ID"
      WHERE t."STATUS" IN ${DEAD}`
  );

  console.log(`── SCAN ──`);
  console.log(`  dead mission-path slots (CompletionPathItems): ${cpiDead.length}`);
  for (const r of cpiDead) console.log(`    ${r.SLUG} (${r.TASKLEGACYID}, ${r.STATUS}) in path ${r.PATH_ID} → mission ${r.MISSION_ID}`);
  console.log(`  dead group slots (GroupPathItems): ${gpiDead.length}`);
  for (const r of gpiDead) console.log(`    ${r.SLUG} (${r.LEGACYID}, ${r.STATUS}) in group ${r.GROUP_ID}`);

  if (VERIFY_ONLY) {
    const clean = cpiDead.length === 0 && gpiDead.length === 0;
    console.log(`\nVERIFY: ${clean ? 'CLEAN — no dead slots' : 'WORK REMAINS'}`);
    process.exit(clean ? 0 : 2);
  }

  // Affected parents: missions (from CPI) + groups (from GPI). Resolve a SURVIVING
  // child tutorial per affected group/mission to drive the real rollup.
  const affectedMissionUuids = new Set(cpiDead.map(r => r.MISSION_ID).filter(Boolean));
  const affectedGroupUuids = new Set(gpiDead.map(r => r.GROUP_ID).filter(Boolean));

  if (!COMMIT) {
    console.log(`\n── DRY RUN ── plan:`);
    console.log(`  STRIP ${cpiDead.length} mission-path slots + ${gpiDead.length} group slots`);
    console.log(`  RECONCILE ${affectedMissionUuids.size} missions + ${affectedGroupUuids.size} groups (grandfather: never demote)`);
    console.log(`\nRe-run with --commit to apply.`);
    process.exit(0);
  }

  acquireLock();
  try {
    console.log(`\nSnapshot: ${SNAP}`);

    // ── GRANDFATHER snapshot: every COMPLETED Group/Mission TaskRecord for affected parents ──
    const groupLegacyRows = affectedGroupUuids.size
      ? await db.run(`SELECT "ID","LEGACYID" FROM "COM_SAP_DEVELOPERS_IMS_GROUPS" WHERE "ID" IN (${[...affectedGroupUuids].map(() => '?').join(',')})`, [...affectedGroupUuids])
      : [];
    const missionLegacyRows = affectedMissionUuids.size
      ? await db.run(`SELECT "ID","LEGACYID" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE "ID" IN (${[...affectedMissionUuids].map(() => '?').join(',')})`, [...affectedMissionUuids])
      : [];
    const parentLegacy = [
      ...groupLegacyRows.map(g => ({ legacyId: g.LEGACYID, type: 'GROUP' })),
      ...missionLegacyRows.map(m => ({ legacyId: m.LEGACYID, type: 'MISSION' })),
    ];
    const priorCompleted = new Map(); // `${type}:${legacyId}:${user}` -> record
    for (const p of parentLegacy) {
      const rows = await db.run(`SELECT "ID","USER_ID","PROGRESS","COMPLETIONDATE" FROM ${TR} WHERE "TASKLEGACYID"=? AND "TASKTYPE"=? AND "STATUS"='COMPLETED'`, [p.legacyId, p.type]);
      for (const r of rows) priorCompleted.set(`${p.type}:${p.legacyId}:${r.USER_ID}`, r);
    }
    console.log(`Grandfather baseline: ${priorCompleted.size} COMPLETED parent records snapshotted.`);

    // ── STRIP ──
    for (const r of cpiDead) { snap({ kind: 'cpi-delete', row: r }); await db.run(`DELETE FROM ${CPI} WHERE "ID"=?`, [r.ID]); }
    for (const r of gpiDead) { snap({ kind: 'gpi-delete', row: r }); await db.run(`DELETE FROM ${GPI} WHERE "ID"=?`, [r.ID]); }
    console.log(`STRIP: removed ${cpiDead.length} mission-path + ${gpiDead.length} group slots.`);

    // ── RECONCILE: per affected group, replay rollup for every user who has ANY
    //    completed tutorial in that group (they are the only ones whose parent
    //    status can change). One surviving child drives findParents→group+mission. ──
    const reconcileUser = async (uid, tutorialId, taskLegacyId) =>
      rollUpParentsForCompletion({ dbUser: { ID: uid }, task: { taskType: 'TUTORIAL', taskLegacyId, tutorialId }, db, send: false });

    const affectedUserCount = { groups: 0, missions: 0 };
    // Groups
    for (const g of groupLegacyRows) {
      const [surv] = await db.run(`SELECT i."TUTORIAL_ID", t."LEGACYID" FROM ${GPI} i JOIN ${TUT} t ON t."ID"=i."TUTORIAL_ID" WHERE i."GROUP_ID"=? AND t."STATUS" NOT IN ${DEAD} ORDER BY i."ITEMORDER"`, [g.ID]);
      if (!surv) { console.log(`  group ${g.LEGACYID}: no surviving tutorial — skipping reconcile (empty group)`); continue; }
      const users = await db.run(`SELECT DISTINCT tr."USER_ID" FROM ${TR} tr JOIN ${GPI} i ON i."TUTORIAL_ID"=(SELECT "ID" FROM ${TUT} WHERE "LEGACYID"=tr."TASKLEGACYID") WHERE i."GROUP_ID"=? AND tr."STATUS"='COMPLETED'`, [g.ID]);
      for (const u of users) { await reconcileUser(u.USER_ID, surv.TUTORIAL_ID, surv.LEGACYID); affectedUserCount.groups++; }
      console.log(`  group ${g.LEGACYID}: reconciled ${users.length} users`);
    }
    // Missions whose dead slot was a DIRECT tutorial (not via group) — reconcile via a surviving direct tutorial.
    for (const m of missionLegacyRows) {
      const [surv] = await db.run(`SELECT i."TASKLEGACYID", i."TUTORIAL_ID" FROM ${CPI} i JOIN "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" p ON p."ID"=i."PATH_ID" JOIN ${TUT} t ON t."LEGACYID"=i."TASKLEGACYID" WHERE p."MISSION_ID"=? AND i."TASKTYPE"='TUTORIAL' AND t."STATUS" NOT IN ${DEAD} ORDER BY i."ITEMORDER"`, [m.ID]);
      if (!surv) { console.log(`  mission ${m.LEGACYID}: no surviving direct tutorial (group-only mission handled above)`); continue; }
      const users = await db.run(`SELECT DISTINCT "USER_ID" FROM ${TR} WHERE "TASKLEGACYID"=? AND "STATUS"='COMPLETED'`, [surv.TASKLEGACYID]);
      for (const u of users) { await reconcileUser(u.USER_ID, surv.TUTORIAL_ID, surv.TASKLEGACYID); affectedUserCount.missions++; }
      console.log(`  mission ${m.LEGACYID}: reconciled ${users.length} users`);
    }
    console.log(`RECONCILE: ${affectedUserCount.groups} group-user + ${affectedUserCount.missions} mission-user rollups.`);

    // ── GRANDFATHER restore: re-promote any previously-COMPLETED parent that the
    //    reconcile demoted. (CAP upsert downgrades; legacy never did.) ──
    let restored = 0;
    for (const [key, prior] of priorCompleted) {
      const [type, legacyId, uid] = key.split(':');
      const [now] = await db.run(`SELECT "ID","STATUS" FROM ${TR} WHERE "USER_ID"=? AND "TASKLEGACYID"=? AND "TASKTYPE"=? AND "STATUS"!='SUPERSEDED'`, [uid, Number(legacyId), type]);
      if (now && now.STATUS !== 'COMPLETED') {
        snap({ kind: 'grandfather-restore', type, legacyId, user: uid, demotedTo: now.STATUS });
        await db.run(`UPDATE ${TR} SET "STATUS"='COMPLETED', "PROGRESS"=100, "COMPLETIONDATE"=? WHERE "ID"=?`, [prior.COMPLETIONDATE || new Date().toISOString(), now.ID]);
        restored++;
      }
    }
    console.log(`GRANDFATHER: restored ${restored} parent records the reconcile would have demoted.`);
    console.log(`\nDONE. Snapshot: ${SNAP}`);
  } finally {
    releaseLock();
  }
  process.exit(0);
}

main().catch((e) => { releaseLock(); console.error('ERR', e.stack || e.message); process.exit(1); });
