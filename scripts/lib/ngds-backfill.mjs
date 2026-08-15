// scripts/lib/ngds-backfill.mjs
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Backfill the legacy submission-id (= NGDS trackingInfo.tracking) onto historical
// TaskRecords that predate the stamping fix. Idempotent: only rows whose id column
// IS NULL are selected. Per-row UPDATE because each row needs a distinct UUID
// (CQL cannot assign unique values in a single bulk UPDATE); batched in a tx.
export async function backfillSubmissionIds(db, { dryRun = true, batchSize = 500, createdSince = null, completedSince = null, log = console } = {}) {
  const { TaskRecords } = cds.entities(NS);

  const completedWhere = { status: 'COMPLETED', submissionIdCompleted: null };
  const startedWhere = { status: 'IN_PROGRESS', submissionIdStarted: null };
  if (createdSince) {
    // Badge assignment only needs recent activity — scope to rows created on/after
    // the cutoff rather than stamping the full migrated history.
    completedWhere.createdAt = { '>=': createdSince };
    startedWhere.createdAt = { '>=': createdSince };
  }
  if (completedSince) {
    // Match the NGDS resend window, which is defined by completionDate (not
    // createdAt): a row created before the created-since cutoff but completed
    // within the window is still an in-window completion that must be stamped,
    // else the resend silently skips it. Applies to the COMPLETED set only
    // (IN_PROGRESS rows have no completionDate). Overrides any createdAt floor
    // on the completed set so those older-but-recently-completed rows are caught.
    delete completedWhere.createdAt;
    completedWhere.completionDate = { '>=': completedSince };
  }

  const completedMissing = await db.run(
    SELECT.from(TaskRecords).columns('ID').where(completedWhere)
  );
  const startedMissing = await db.run(
    SELECT.from(TaskRecords).columns('ID').where(startedWhere)
  );

  const plan = { completed: completedMissing.length, started: startedMissing.length, createdSince: createdSince || null, completedSince: completedSince || null };
  if (dryRun) {
    const parts = [];
    if (completedSince) parts.push(`completed.completionDate >= ${completedSince}`);
    else if (createdSince) parts.push(`created >= ${createdSince}`);
    const scope = parts.length ? ` (${parts.join('; ')})` : '';
    log.info?.(`[dry-run] would stamp submissionIdCompleted on ${plan.completed} COMPLETED row(s), submissionIdStarted on ${plan.started} IN_PROGRESS row(s)${scope}`);
    return { ...plan, updated: 0, dryRun: true };
  }

  let updated = 0;
  async function apply(rows, column) {
    for (const batch of chunk(rows, batchSize)) {
      await db.tx(async (tx) => {
        for (const r of batch) {
          await tx.run(UPDATE(TaskRecords, r.ID).set({ [column]: cds.utils.uuid() }));
          updated++;
        }
      });
      log.info?.(`${column}: ${updated} updated so far`);
    }
  }
  await apply(completedMissing, 'submissionIdCompleted');
  await apply(startedMissing, 'submissionIdStarted');

  log.info?.(`backfill complete: ${updated} row(s) stamped`);
  return { ...plan, updated, dryRun: false };
}
