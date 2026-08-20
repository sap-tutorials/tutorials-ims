// scripts/backfill-ngds-send.mjs
//
// Send backfilled GROUP/MISSION completions to NGDS (issue #1934). Separate,
// deliberate operator step (NOT run by the bulk backfill, which intentionally
// bypasses NGDS). Rate-limited and resumable via a cursor in
// ImsConfig 'ngds.backfill.cursor'. The NGDS receiver dedups on
// trackingInfo.tracking (= submissionIdCompleted), so re-runs are safe.
//
// Gates honored (parity with live auto-send): env=prod + kill-switch
// (isAutoSendActive), completionDate >= epoch, createdBy != 'migration',
// canonical SCI/IAS sapId. Run in PROD after the bulk backfill:
//   node scripts/backfill-ngds-send.mjs --dry-run
//   node scripts/backfill-ngds-send.mjs --rate=1.5 --limit=500
import cds from '@sap/cds';
import { resolveAutoSendEpoch, isAutoSendActive } from '../srv/lib/ngds-autosend.js';
import { sendTaskRecordToNgds } from '../srv/lib/ngds-client.js';

const CURSOR_KEY = 'ngds.backfill.cursor';
const ELIGIBLE = ['GROUP', 'MISSION'];
const CANONICAL_SAP_ID = /^[PSIps]\d{6,}$/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readCursor(db) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const row = await db.run(SELECT.one.from(ImsConfig).columns('value').where({ key: CURSOR_KEY }));
  return row?.value || '';
}
async function writeCursor(db, value) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.one.from(ImsConfig).where({ key: CURSOR_KEY }));
  if (existing) await db.run(UPDATE(ImsConfig).set({ value }).where({ key: CURSOR_KEY }));
  else await db.run(INSERT.into(ImsConfig).entries({ key: CURSOR_KEY, value }));
}

/**
 * @param {{since?:string|null, dryRun?:boolean, limit?:number, rate?:number,
 *          db?:object, forceActive?:boolean, sendFn?:Function}} opts
 * @returns {Promise<{eligible:number, sent:number, skipped:number, since?:string, inactive?:boolean}>}
 */
export async function runNgdsSend({ since = null, dryRun = false, limit = Infinity, rate = 1.5, db, forceActive = false, sendFn = sendTaskRecordToNgds } = {}) {
  const database = db || await cds.connect.to('db');
  const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');

  if (!dryRun && !forceActive && !(await isAutoSendActive(database))) {
    return { eligible: 0, sent: 0, skipped: 0, inactive: true };
  }
  const epochMs = await resolveAutoSendEpoch(database);
  const sinceIso = since || (epochMs != null ? new Date(epochMs).toISOString() : '2026-08-10T00:00:00Z');
  const cursor = await readCursor(database);

  const rows = await database.run(
    SELECT.from(TaskRecords)
      .where({ taskType: { in: ELIGIBLE }, status: 'COMPLETED', completionDate: { '>=': sinceIso } })
      .orderBy('completionDate', 'ID')
  );

  let eligible = 0, sent = 0, skipped = 0;
  const delayMs = rate > 0 ? Math.round(1000 / rate) : 0;
  for (const rec of rows) {
    const key = `${rec.completionDate}|${rec.ID}`;
    if (cursor && key <= cursor) { skipped++; continue; }
    if (rec.createdBy === 'migration') { skipped++; continue; }
    const u = await database.run(SELECT.one.from(Users).columns('sapId').where({ ID: rec.user_ID }));
    if (!u || !CANONICAL_SAP_ID.test(String(u.sapId || '').trim())) { skipped++; continue; }
    eligible++;
    if (dryRun) continue;
    if (sent >= limit) break;
    await sendFn(rec, database);
    sent++;
    await writeCursor(database, key);
    if (delayMs) await sleep(delayMs);
  }
  return { eligible, sent, skipped, since: sinceIso };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : def;
  };
  const dryRun = process.argv.includes('--dry-run');
  cds.connect.to('db').then(async (db) => {
    const r = await runNgdsSend({
      since: arg('since', null), dryRun,
      limit: Number(arg('limit', Infinity)), rate: Number(arg('rate', 1.5)), db,
    });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
