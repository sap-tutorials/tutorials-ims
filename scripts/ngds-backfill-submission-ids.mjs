// scripts/ngds-backfill-submission-ids.mjs
// Backfill submissionId (= NGDS trackingInfo.tracking) on historical TaskRecords.
// Run:  cds bind --exec -- node scripts/ngds-backfill-submission-ids.mjs [--execute] [--batch-size N]
// Dry-run by default. Idempotent — safe to re-run.
import cds from '@sap/cds';
import { backfillSubmissionIds } from './lib/ngds-backfill.mjs';

const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');
const bi = args.indexOf('--batch-size');
const batchSize = bi >= 0 ? Number(args[bi + 1]) : 500;

const db = await cds.connect.to('db');
const result = await backfillSubmissionIds(db, { dryRun, batchSize });
console.log(JSON.stringify(result, null, 2));
if (dryRun) console.log('\n(dry-run — pass --execute to write)');
process.exit(0);
