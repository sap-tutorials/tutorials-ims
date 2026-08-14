// scripts/lib/ngds-resend.mjs
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
// Legacy NGDS send allowlist (parity with maybeAutoSendCompletion).
const NGDS_ELIGIBLE = ['TUTORIAL', 'GROUP', 'MISSION'];
// context.user_id must be a canonical SCI/IAS uid or the send is unresolvable.
const CANONICAL_SAP_ID = /^[PSIps]\d{6,}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Select the completions that SHOULD have been delivered to NGDS. Mirrors the
// auto-send gates exactly, minus the CF-space gate (the operator targets PROD
// deliberately via `cds bind`).
export async function selectResendCandidates(db, { epochMs = null, completedBefore = null } = {}) {
  const { TaskRecords, Users } = cds.entities(NS);
  const rows = await db.run(
    SELECT.from(TaskRecords).where({ status: 'COMPLETED', taskType: { in: NGDS_ELIGIBLE } })
  );

  const out = [];
  for (const r of rows) {
    if (r.createdBy === 'migration') continue;                 // legacy already credited
    const when = r.completionDate || r.modifiedAt;
    const t = when ? new Date(when).getTime() : NaN;
    if (epochMs != null && Number.isFinite(t) && t < epochMs) continue;        // pre-cutover
    if (completedBefore != null && Number.isFinite(t) && t >= completedBefore) continue; // optional ceiling
    if (!r.user_ID) continue;
    const u = await db.run(SELECT.one.from(Users).columns('sapId').where({ ID: r.user_ID }));
    const sapId = u?.sapId;
    if (!(typeof sapId === 'string' && CANONICAL_SAP_ID.test(sapId.trim()))) continue; // identity gate
    out.push(r);
  }
  return out;
}

// Resend eligible completions via the existing send path (queues to
// NGDSFailedMessages on failure → drained by the 2h ngds-retry job).
export async function resendMissingTracking(db, {
  dryRun = true, limit = null, epochMs = null, completedBefore = null, delayMs = 50, log = console,
} = {}) {
  let candidates = await selectResendCandidates(db, { epochMs, completedBefore });
  if (limit != null) candidates = candidates.slice(0, limit);

  if (dryRun) {
    log.info?.(`[dry-run] ${candidates.length} record(s) would be resent`);
    return { total: candidates.length, sent: 0, queued: 0, dryRun: true };
  }

  const { sendTaskRecordToNgds } = await import('../../srv/lib/ngds-client.js');
  let sent = 0, queued = 0;
  for (const rec of candidates) {
    const outcome = await sendTaskRecordToNgds(rec, db);
    if (outcome?.success) sent++; else queued++;
    const done = sent + queued;
    if (done % 50 === 0) log.info?.(`resend progress: ${done}/${candidates.length} (sent=${sent}, queued=${queued})`);
    if (delayMs) await sleep(delayMs);
  }
  log.info?.(`resend complete: total=${candidates.length} sent=${sent} queued=${queued}`);
  return { total: candidates.length, sent, queued, dryRun: false };
}
