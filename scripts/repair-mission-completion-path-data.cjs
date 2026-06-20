/* eslint-disable no-console */
/**
 * One-shot repair: backfill Missions.legacyId, CompletionPaths.legacyId,
 * CompletionPaths.slug for rows where they are NULL. Reports unresolvable
 * CompletionPathItems for SuperAdmin manual triage (no auto-fix because
 * the row contains no signal to recover the intended target).
 *
 * Background: AdminService historically created Missions/Groups/CompletionPaths
 * via Fiori draft activation without legacyId/slug auto-init. The forward
 * fix in PR #?? (issue #436) closes the leak; this script heals existing
 * partial-NULL rows.
 *
 * Out of scope (per spec):
 *   - Auto-repair of CompletionPathItems with NULL tutorial_ID/group_ID/
 *     itemOrder/checkpointTitle. Reported only.
 *   - TaskRecords. (Tutorials.legacyId orphans handled by PR #452's
 *     repair script; same data-loss boundary applies.)
 *
 * Modes:
 *   --dry-run     (default) — print plan, no writes
 *   --commit               — execute, snapshot first
 *   --verify-only          — exit 0 if all clean, 2 if work remains
 *
 * Run via:  npx cds bind --exec -- node scripts/repair-mission-completion-path-data.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
// slug-utils.js is ESM; can't `require` it. Loaded via dynamic import() inside main().

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `mission-cp-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);
let snapshotInited = false;
function appendSnapshot(record) {
  if (!snapshotInited) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    snapshotInited = true;
  }
  fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERIFY_ONLY = argv.includes('--verify-only');
const DRY_RUN = argv.includes('--dry-run');
if (COMMIT && VERIFY_ONLY) {
  console.error('--commit and --verify-only are mutually exclusive');
  process.exit(1);
}
if (COMMIT && DRY_RUN) {
  console.error('--commit and --dry-run are mutually exclusive');
  process.exit(1);
}

const MISSIONS_TBL = '"COM_SAP_DEVELOPERS_IMS_MISSIONS"';
const PATHS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"';
const ITEMS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
const MISSION_SEQ = '"COM_SAP_DEVELOPERS_IMS_MISSIONS_SEQ"';
const PATH_SEQ = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS_SEQ"';

async function main() {
  // ESM helper imported dynamically (slug-utils.js exports slugify/ensureUniqueSlug as ESM).
  const { slugify, ensureUniqueSlug } = await import('../srv/lib/slug-utils.js');

  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);

  // ── Find defects ───────────────────────────────────────────────────────
  const missionNullLegacy = await db.run(
    `SELECT "ID", "TITLE" FROM ${MISSIONS_TBL} WHERE "LEGACYID" IS NULL ORDER BY "TITLE"`
  );
  const pathDefects = await db.run(`
    SELECT "ID", "MISSION_ID", "NAME", "SLUG", "LEGACYID"
      FROM ${PATHS_TBL}
     WHERE "LEGACYID" IS NULL OR "SLUG" IS NULL
     ORDER BY "NAME"
  `);
  const itemDefects = await db.run(`
    SELECT "ID", "PATH_ID", "ITEMORDER", "TASKTYPE", "TUTORIAL_ID", "GROUP_ID", "CHECKPOINTTITLE"
      FROM ${ITEMS_TBL}
     WHERE "ITEMORDER" IS NULL
        OR ("TASKTYPE" = 'TUTORIAL'   AND "TUTORIAL_ID"     IS NULL)
        OR ("TASKTYPE" = 'GROUP'      AND "GROUP_ID"        IS NULL)
        OR ("TASKTYPE" = 'CHECKPOINT' AND "CHECKPOINTTITLE" IS NULL)
     ORDER BY "PATH_ID", "ITEMORDER"
  `);

  if (VERIFY_ONLY) {
    console.log(`Missions with NULL legacyId: ${missionNullLegacy.length}`);
    console.log(`CompletionPaths with NULL legacyId or slug: ${pathDefects.length}`);
    console.log(`CompletionPathItems unresolvable (reported only): ${itemDefects.length}`);
    const dirty = missionNullLegacy.length + pathDefects.length;
    // Items aren't auto-repaired, so they don't gate verify-only's exit code —
    // the script's job is data-shape, not data-correctness on items.
    process.exit(dirty === 0 ? 0 : 2);
  }

  console.log(`\n--- Missions with NULL legacyId: ${missionNullLegacy.length} ---`);
  for (const r of missionNullLegacy) {
    console.log(`  ${r.TITLE.padEnd(60)}  ID=${r.ID.slice(0, 8)}`);
  }
  console.log(`\n--- CompletionPaths with NULL legacyId/slug: ${pathDefects.length} ---`);
  for (const r of pathDefects) {
    const flags = [r.LEGACYID == null ? 'legacy' : null, r.SLUG == null ? 'slug' : null].filter(Boolean).join('+');
    console.log(`  ${(r.NAME ?? '<no-name>').padEnd(40)}  mission=${r.MISSION_ID?.slice(0, 8) ?? 'null'}  ID=${r.ID.slice(0, 8)}  fix=${flags}`);
  }
  console.log(`\n--- CompletionPathItems unresolvable (REPORTED ONLY): ${itemDefects.length} ---`);
  for (const r of itemDefects) {
    const reasons = [];
    if (r.ITEMORDER == null) reasons.push('itemOrder=null');
    if (r.TASKTYPE === 'TUTORIAL' && !r.TUTORIAL_ID) reasons.push('TUTORIAL+tutorial_ID=null');
    if (r.TASKTYPE === 'GROUP' && !r.GROUP_ID) reasons.push('GROUP+group_ID=null');
    if (r.TASKTYPE === 'CHECKPOINT' && !r.CHECKPOINTTITLE) reasons.push('CHECKPOINT+checkpointTitle=null');
    console.log(`  path=${r.PATH_ID?.slice(0, 8) ?? 'null'}  ID=${r.ID.slice(0, 8)}  ${reasons.join(', ')}`);
  }
  console.log('\n  (CompletionPathItems are reported only — SuperAdmin re-links via admin UI.)');

  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to apply Missions+CompletionPaths repair.');
    return;
  }

  // ── Repair Missions ────────────────────────────────────────────────────
  let missionsRepaired = 0, missionsFailed = 0;
  for (const r of missionNullLegacy) {
    try {
      await db.tx(async tx => {
        const recheck = await tx.run(`SELECT "LEGACYID" FROM ${MISSIONS_TBL} WHERE "ID" = ? FOR UPDATE`, [r.ID]);
        if (recheck[0]?.LEGACYID != null) {
          console.log(`  ${r.ID.slice(0, 8)} skipped — already has legacyId=${recheck[0].LEGACYID}`);
          return;
        }
        const [seq] = await tx.run(`SELECT ${MISSION_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
        appendSnapshot({ kind: 'mission-before', table: MISSIONS_TBL, id: r.ID, title: r.TITLE, newLegacyId: seq.v });
        await tx.run(
          `UPDATE ${MISSIONS_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
          [seq.v, r.ID]
        );
        missionsRepaired++;
        console.log(`  ✓ Mission ${r.ID.slice(0, 8)} → legacyId=${seq.v}`);
      });
    } catch (err) {
      missionsFailed++;
      console.error(`  ✗ Mission ${r.ID.slice(0, 8)} failed: ${err.message}`);
    }
  }

  // ── Repair CompletionPaths ─────────────────────────────────────────────
  let pathsRepaired = 0, pathsFailed = 0;
  for (const r of pathDefects) {
    try {
      await db.tx(async tx => {
        const recheck = await tx.run(
          `SELECT "LEGACYID", "SLUG", "NAME", "MISSION_ID" FROM ${PATHS_TBL} WHERE "ID" = ? FOR UPDATE`,
          [r.ID]
        );
        const cur = recheck[0];
        if (!cur) return;

        appendSnapshot({ kind: 'path-before', table: PATHS_TBL, id: r.ID, name: cur.NAME, mission: cur.MISSION_ID });

        const updates = [];
        const params = [];
        if (cur.LEGACYID == null) {
          const [seq] = await tx.run(`SELECT ${PATH_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
          updates.push('"LEGACYID" = ?');
          params.push(seq.v);
        }
        if (cur.SLUG == null) {
          if (!cur.NAME || !cur.MISSION_ID) {
            console.log(`  ⚠ path ${r.ID.slice(0, 8)} has no name or no mission_ID; skipping slug derive`);
          } else {
            // Build sibling-slug taken-set (scope-unique per mission).
            const siblings = await tx.run(
              `SELECT "ID", "SLUG" FROM ${PATHS_TBL} WHERE "MISSION_ID" = ? AND "SLUG" IS NOT NULL AND "ID" <> ?`,
              [cur.MISSION_ID, r.ID]
            );
            const taken = new Set(siblings.map(s => s.SLUG).filter(Boolean));
            const slug = ensureUniqueSlug(slugify(cur.NAME), taken, null);
            updates.push('"SLUG" = ?');
            params.push(slug);
          }
        }
        if (updates.length === 0) {
          console.log(`  ${r.ID.slice(0, 8)} skipped — concurrent repair already healed`);
          return;
        }
        params.push(r.ID);
        await tx.run(
          `UPDATE ${PATHS_TBL} SET ${updates.join(', ')} WHERE "ID" = ?`,
          params
        );
        pathsRepaired++;
        console.log(`  ✓ Path ${r.ID.slice(0, 8)} updated: ${updates.join(', ')}`);
      });
    } catch (err) {
      pathsFailed++;
      console.error(`  ✗ Path ${r.ID.slice(0, 8)} failed: ${err.message}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    missionsScanned: missionNullLegacy.length,
    missionsRepaired,
    missionsFailed,
    pathsScanned: pathDefects.length,
    pathsRepaired,
    pathsFailed,
    itemDefectsReported: itemDefects.length,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
