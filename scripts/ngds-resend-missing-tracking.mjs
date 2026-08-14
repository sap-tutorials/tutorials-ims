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

// Preflight: refuse --execute when eligible completions still lack a stamped
// submissionIdCompleted — running before the backfill would emit tracking-less
// payloads that SMC cannot deduplicate.
if (!dryRun) {
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const unstamped = await db.run(
    SELECT.from(TaskRecords).columns('ID')
      .where({ status: 'COMPLETED', taskType: { in: NGDS_ELIGIBLE }, submissionIdCompleted: null })
  );
  if (unstamped.length > 0) {
    console.error(
      `Refusing --execute: ${unstamped.length} eligible completion(s) still lack submissionIdCompleted` +
      ` — run scripts/ngds-backfill-submission-ids.mjs --execute first`
    );
    process.exit(2);
  }
}

const epochMs = await resolveAutoSendEpoch(db);
const cb = str('--completed-before');
const completedBefore = cb ? new Date(cb).getTime() : null;

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
