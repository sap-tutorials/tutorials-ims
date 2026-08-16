// scripts/ngds-backfill-submission-ids.mjs
// Backfill submissionId (= NGDS trackingInfo.tracking) on historical TaskRecords.
// Run:  cds bind --exec -- node scripts/ngds-backfill-submission-ids.mjs [--execute] [--batch-size N] [--created-since <iso>]
// Dry-run by default. Idempotent — safe to re-run.
// --created-since scopes to rows created on/after an ISO date (badge assignment
// only needs recent activity, not the full migrated backlog).
import cds from '@sap/cds';
import { backfillSubmissionIds } from './lib/ngds-backfill.mjs';

const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');
const bi = args.indexOf('--batch-size');
const batchSize = bi >= 0 ? Number(args[bi + 1]) : 500;
const si = args.indexOf('--created-since');
const createdSince = si >= 0 ? args[si + 1] : null;
const ci = args.indexOf('--completed-since');
const completedSince = ci >= 0 ? args[ci + 1] : null;

// Load + compile the model so `cds.entities(...)` resolves under `cds bind --exec`
// (there is no serving lifecycle here to populate cds.model automatically).
const csn = await cds.load('*');
cds.model = cds.compile.for.nodejs(csn);

const db = await cds.connect.to('db');
const result = await backfillSubmissionIds(db, { dryRun, batchSize, createdSince, completedSince });
console.log(JSON.stringify(result, null, 2));
if (dryRun) console.log('\n(dry-run — pass --execute to write)');
process.exit(0);
