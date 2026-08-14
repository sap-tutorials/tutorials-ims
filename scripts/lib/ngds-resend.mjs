// scripts/lib/ngds-resend.mjs
//
// NOTE — kill-switch intentionally NOT consulted:
// `ngds.autosend.enabled` (ImsConfig) governs the automatic on-completion path
// in srv/lib/ngds-autosend.js only. This script is a deliberate operator action
// invoked via `cds bind --exec` — dry-run by default — so it bypasses the
// kill-switch by design. SMC deduplicates on `trackingInfo.tracking`, so a
// double-send for the same submissionId is harmless.
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
// Legacy NGDS send allowlist (parity with maybeAutoSendCompletion).
export const NGDS_ELIGIBLE = ['TUTORIAL', 'GROUP', 'MISSION'];
// context.user_id must be a canonical SCI/IAS uid or the send is unresolvable.
const CANONICAL_SAP_ID = /^[PSIps]\d{6,}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chunk an array into sub-arrays of at most `size` elements.
// Required for HANA packet-cap safety on .in() predicates (known gotcha:
// cqn-where-in-hana-packet-cap — chunk at 500).
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Select the completions that SHOULD have been delivered to NGDS. Mirrors the
// auto-send gates exactly, minus the CF-space gate (the operator targets PROD
// deliberately via `cds bind`).
export async function selectResendCandidates(db, { epochMs = null, completedBefore = null } = {}) {
  const { TaskRecords, Users } = cds.entities(NS);

  // Push the two hardest constraints into the DB query:
  //   submissionIdCompleted != null — only re-send rows that were already
  //     backfilled; guards against emitting tracking-less payloads if run
  //     out-of-order (before ngds-backfill-submission-ids --execute).
  //   completionDate >= epochMs   — epoch pushed to WHERE so the DB skips
  //     pre-cutover rows entirely rather than fetching them into Node.
  // The remaining in-process gates below are belt-and-suspenders for parity.
  const where = { status: 'COMPLETED', taskType: { in: NGDS_ELIGIBLE }, submissionIdCompleted: { '!=': null } };
  if (epochMs != null) where.completionDate = { '>=': new Date(epochMs).toISOString() };
  const rows = await db.run(SELECT.from(TaskRecords).where(where));

  // Pass 1: apply cheap in-process gates (no DB round-trips).
  const survivors = [];
  for (const r of rows) {
    if (r.createdBy === 'migration') continue;                 // legacy already credited
    const when = r.completionDate || r.modifiedAt;
    const t = when ? new Date(when).getTime() : NaN;
    if (epochMs != null && Number.isFinite(t) && t < epochMs) continue;        // pre-cutover
    if (completedBefore != null && Number.isFinite(t) && t >= completedBefore) continue; // optional ceiling
    if (!r.user_ID) continue;
    survivors.push(r);
  }

  if (survivors.length === 0) return [];

  // Pass 2: bulk-fetch canonical users. Chunked at 500 to respect the HANA
  // packet cap on .in() list size (cqn-where-in-hana-packet-cap).
  const distinctIds = [...new Set(survivors.map(r => r.user_ID))];
  const canonicalIds = new Set();
  for (const ids of chunk(distinctIds, 500)) {
    const users = await db.run(
      SELECT.from(Users).columns('ID', 'sapId').where({ ID: { in: ids } })
    );
    for (const u of users) {
      const sapId = u?.sapId;
      if (typeof sapId === 'string' && CANONICAL_SAP_ID.test(sapId.trim())) {
        canonicalIds.add(u.ID);
      }
    }
  }

  // Pass 3: keep only survivors whose user has a canonical sapId.
  return survivors.filter(r => canonicalIds.has(r.user_ID));
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
