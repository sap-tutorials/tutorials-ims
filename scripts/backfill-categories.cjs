#!/usr/bin/env node
'use strict';

const VALID_KINDS = ['all', 'mission', 'group', 'tutorial'];

/**
 * Parse command-line arguments.
 * @param {string[]} argv - process.argv.slice(2) or equivalent
 * @returns {{ kind: string, fromId: string|null, concurrency: number, dryRun: boolean }}
 */
function parseArgs(argv) {
  const args = { kind: 'all', fromId: null, concurrency: 4, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--kind=')) {
      args.kind = a.slice('--kind='.length);
    } else if (a === '--from-id') {
      args.fromId = argv[++i];
    } else if (a.startsWith('--from-id=')) {
      args.fromId = a.slice('--from-id='.length);
    } else if (a.startsWith('--concurrency=')) {
      args.concurrency = Number.parseInt(a.slice('--concurrency='.length), 10) || 4;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    }
  }
  if (!VALID_KINDS.includes(args.kind)) {
    throw new Error(`--kind must be one of ${VALID_KINDS.join('|')}, got: ${args.kind}`);
  }
  return args;
}

/**
 * Map kind string to CDS entity name.
 * @param {string} kind
 * @returns {string}
 */
function kindToEntity(kind) {
  const map = { mission: 'Missions', group: 'Groups', tutorial: 'Tutorials' };
  return map[kind];
}

/**
 * Run a batch of items concurrently using Promise.allSettled.
 * @param {Array} items
 * @param {number} concurrency
 * @param {(item: any) => Promise<any>} fn
 * @returns {Promise<Array<PromiseSettledResult<any>>>}
 */
async function batchProcess(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function main(argv) {
  const args = parseArgs(argv);
  const cds = require('@sap/cds');

  // Connect to database
  const db = await cds.connect.to('db');

  // Dynamic import for ESM module
  const { classifyAndPersist } = await import('../srv/lib/category-classifier.js');

  const kinds = args.kind === 'all' ? ['mission', 'group', 'tutorial'] : [args.kind];

  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const kind of kinds) {
    const entityName = kindToEntity(kind);
    console.log(`[backfill] Processing kind=${kind} (entity=${entityName}) ...`);

    // Fetch all IDs ordered
    const rows = await db.run(
      SELECT.from(entityName).columns('ID').orderBy('ID')
    );

    let items = rows;

    // Apply --from-id resume cutoff: skip until we find the matching ID, then include from there
    if (args.fromId) {
      const cutoffIndex = items.findIndex(r => r.ID === args.fromId);
      if (cutoffIndex === -1) {
        console.warn(`[backfill] --from-id ${args.fromId} not found in ${entityName}; processing all`);
      } else {
        const skippedCount = cutoffIndex;
        items = items.slice(cutoffIndex);
        totalSkipped += skippedCount;
        console.log(`[backfill] Resuming from ID ${args.fromId} (skipped ${skippedCount} items)`);
      }
    }

    console.log(`[backfill] ${items.length} items to process for kind=${kind}`);

    let succeeded = 0;
    let failed = 0;
    let processed = 0;

    const results = await batchProcess(items, args.concurrency, async (row) => {
      if (args.dryRun) {
        return { id: row.ID, dryRun: true };
      }
      await classifyAndPersist(kind, row.ID);
      return { id: row.ID };
    });

    for (const result of results) {
      processed++;
      if (result.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        const id = items[results.indexOf(result)]?.ID ?? '?';
        console.error(`[backfill] FAILED kind=${kind} id=${id}: ${result.reason}`);
      }

      if (processed % 50 === 0) {
        console.log(`[backfill] Progress kind=${kind}: ${processed}/${items.length} (ok=${succeeded} fail=${failed})`);
      }
    }

    console.log(`[backfill] Done kind=${kind}: total=${items.length} succeeded=${succeeded} failed=${failed}`);
    totalSucceeded += succeeded;
    totalFailed += failed;
  }

  const grandTotal = totalSucceeded + totalFailed;
  console.log(`[backfill] Summary: total=${grandTotal} succeeded=${totalSucceeded} failed=${totalFailed} skipped=${totalSkipped}`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => {
    console.error('[backfill] FATAL', e);
    process.exit(2);
  });
}

module.exports = { parseArgs };
