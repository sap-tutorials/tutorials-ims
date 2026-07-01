// srv/jobs/materialize-co-completions.js
//
// Nightly cron that rebuilds the CoCompletions table.
//
// Ports the pair-aggregation body from srv/lib/co-completion.js
// computeCoCompletions() and writes the (sourceSlug, targetSlug, score)
// tuples into the CoCompletions entity so the neighborhood handler can do
// an indexed single-slug lookup at request time instead of a ~60s scan of
// TaskRecords on every cold start.
//
// Design decisions:
//
//   - We store each undirected edge TWICE (A→B and B→A) so runtime reads
//     are a single `WHERE sourceSlug = ?` query.
//   - The cron truncates + repopulates inside one transaction. Readers see
//     the old snapshot until commit, then atomically the new one — no
//     stale-mixed-with-fresh windows for a live query.
//   - TopN cap of 20 per source: matches the runtime helper's default cap
//     (topN=10) with headroom so we don't have to re-materialize when the
//     handler experiments with slightly bigger caps.
//   - Batch insert size 500: keeps HANA transaction memory bounded even
//     for the ~1M rows we'll write at project scale.
//
// The job is registered in srv/jobs/scheduler.js:registerJobs() with a
// daily 04:33 UTC schedule (off-peak, off-minute per project convention).

import cds from '@sap/cds';

const LOG = cds.log('materialize-co-completions');
const TOP_N_STORED_PER_SLUG = 20;
const BATCH_SIZE = 500;

/**
 * Cron entry point. Returns a summary object for the scheduler's
 * PipelineLog record and per-job telemetry.
 */
export async function runMaterializeCoCompletions() {
  const db = await cds.connect.to('db');
  const t0 = Date.now();

  // Step 1: aggregate pairs. This is the same logic as
  // computeCoCompletions() but inlined here so we don't have to keep the
  // module's TTL cache warm through the cron path.
  const { Tutorials, TaskRecords, CoCompletions } =
    cds.entities('com.sap.developers.ims');

  const tutorials = await SELECT.from(Tutorials)
    .columns('legacyId', 'slug')
    .where(`status = 'ACTIVE' or status is null`);
  const slugById = new Map(
    tutorials.map((t) => [t.legacyId, t.slug]).filter(([, s]) => !!s),
  );

  const records = await SELECT.from(TaskRecords)
    .columns('user_ID', 'taskLegacyId')
    .where({ taskType: 'TUTORIAL', status: { in: ['COMPLETED', 'SUPERSEDED'] } });

  const byUser = new Map();
  for (const r of records) {
    const slug = slugById.get(r.taskLegacyId);
    if (!slug) continue;
    if (!byUser.has(r.user_ID)) byUser.set(r.user_ID, new Set());
    byUser.get(r.user_ID).add(slug);
  }

  const pairCounts = new Map();
  for (const slugs of byUser.values()) {
    const arr = [...slugs];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const [a, b] = arr[i] < arr[j] ? [arr[i], arr[j]] : [arr[j], arr[i]];
        const key = `${a}\x1f${b}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Step 2: for each slug, keep its top-N neighbors so writes are bounded.
  // Symmetric: an edge (A↔B) contributes to both A's neighbors and B's.
  const neighborsBySlug = new Map(); // slug -> Array<{slug, score}>
  for (const [key, score] of pairCounts) {
    const [a, b] = key.split('\x1f');
    if (!neighborsBySlug.has(a)) neighborsBySlug.set(a, []);
    if (!neighborsBySlug.has(b)) neighborsBySlug.set(b, []);
    neighborsBySlug.get(a).push({ slug: b, score });
    neighborsBySlug.get(b).push({ slug: a, score });
  }

  // Sort + cap each side to TOP_N_STORED_PER_SLUG.
  let totalPairs = 0;
  const rowsToInsert = [];
  for (const [source, neighbors] of neighborsBySlug) {
    neighbors.sort((x, y) => y.score - x.score || x.slug.localeCompare(y.slug));
    const capped = neighbors.slice(0, TOP_N_STORED_PER_SLUG);
    for (const n of capped) {
      rowsToInsert.push({ sourceSlug: source, targetSlug: n.slug, score: n.score });
      totalPairs++;
    }
  }
  const aggregateMs = Date.now() - t0;
  LOG.info(
    `aggregated ${totalPairs} pair rows from ${records.length} records across ${byUser.size} users in ${aggregateMs}ms`,
  );

  // Step 3: swap the whole table in one transaction. DELETE-then-INSERT is
  // fine here because CoCompletions has no FK references; nothing else
  // reads it during the swap (readers block on the commit).
  const writeT0 = Date.now();
  await db.tx(async (tx) => {
    await tx.run(DELETE.from(CoCompletions));
    for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
      const batch = rowsToInsert.slice(i, i + BATCH_SIZE);
      await tx.run(INSERT.into(CoCompletions).entries(batch));
    }
  });
  const writeMs = Date.now() - writeT0;
  LOG.info(`wrote ${totalPairs} rows in ${writeMs}ms`);

  return {
    userCount: byUser.size,
    recordCount: records.length,
    pairCount: pairCounts.size,
    rowsWritten: totalPairs,
    aggregateMs,
    writeMs,
    totalMs: Date.now() - t0,
  };
}
