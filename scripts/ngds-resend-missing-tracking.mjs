// scripts/ngds-resend-missing-tracking.mjs
// Resend NGDS completions that were filtered for a missing trackingInfo.tracking.
// Run (after the fix is deployed AND backfill has run):
//   cds bind --exec -- node scripts/ngds-resend-missing-tracking.mjs [--execute] [--limit N] [--completed-before <iso>] [--delay-ms N]
// Dry-run by default. Reads the cutover floor from ImsConfig 'ngds.autosend.epoch'.
import cds from '@sap/cds';
import { resendMissingTracking, NGDS_ELIGIBLE } from './lib/ngds-resend.mjs';
import { resolveAutoSendEpoch } from '../srv/lib/ngds-autosend.js';

const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');
const num = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : dflt; };
const str = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const db = await cds.connect.to('db');

// Load + compile the model so `cds.entities(...)` resolves under `cds bind --exec`
// (there is no serving lifecycle here to populate cds.model automatically).
const csn = await cds.load('*');
cds.model = cds.compile.for.nodejs(csn);

const epochMs = await resolveAutoSendEpoch(db);
const cb = str('--completed-before');
const completedBefore = cb ? new Date(cb).getTime() : null;

// Preflight: refuse --execute when eligible completions *within the resend window*
// still lack a stamped submissionIdCompleted — those would be silently skipped by
// the candidate selection (which requires submissionIdCompleted != null), leaving a
// gap. Scoped to completionDate >= epoch to match what resend actually sends: rows
// completed before the cutover epoch are out of scope and must NOT force a refusal
// (e.g. the migrated backlog that is deliberately left unstamped).
if (!dryRun) {
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const gapWhere = { status: 'COMPLETED', taskType: { in: NGDS_ELIGIBLE }, submissionIdCompleted: null };
  if (epochMs != null) gapWhere.completionDate = { '>=': new Date(epochMs).toISOString() };
  const unstamped = await db.run(SELECT.from(TaskRecords).columns('ID').where(gapWhere));
  if (unstamped.length > 0) {
    console.error(
      `Refusing --execute: ${unstamped.length} eligible completion(s) within the resend window` +
      ` (completionDate >= ${epochMs ? new Date(epochMs).toISOString() : 'n/a'}) still lack submissionIdCompleted` +
      ` — run scripts/ngds-backfill-submission-ids.mjs --execute first`
    );
    process.exit(2);
  }
}

console.log(`epoch floor: ${epochMs ? new Date(epochMs).toISOString() : '(none)'}`);
const result = await resendMissingTracking(db, {
  dryRun,
  limit: num('--limit', null),
  epochMs,
  completedBefore,
  delayMs: num('--delay-ms', 50),
});
console.log(JSON.stringify(result, null, 2));
if (dryRun) console.log('\n(dry-run — pass --execute to send)');
process.exit(0);
