#!/usr/bin/env node
// scripts/clear-deleted-from-quarantine.cjs
//
// #2585 follow-up — one-off: clear DELETED/INACTIVE tutorials from the CURRENT
// quarantine snapshot without waiting for the next full rebuild. Re-writes the
// current snapshot's events minus any whose slug is a DELETED/INACTIVE
// Tutorials row, as a NEW current snapshot (snapshots stay immutable; the
// isCurrent flip clears the old one). Idempotent: no excluded current event →
// no-op (no new snapshot). Dry-run by default; --commit to apply.
//
// Usage (cf login'd shell targeting the right space):
//   npx cds bind --exec --profile hybrid -- node scripts/clear-deleted-from-quarantine.cjs
//   npx cds bind --exec --profile hybrid -- node scripts/clear-deleted-from-quarantine.cjs --commit
'use strict';

const cds = require('@sap/cds');
const NS = 'com.sap.developers.ims';
const lc = (s) => String(s || '').toLowerCase();

async function clearDeletedFromQuarantine({ commit = false, log } = {}) {
  const logger = log || cds.log('clear-deleted-quarantine');
  const { QuarantineSnapshots, QuarantineEvents, Tutorials } = cds.entities(NS);

  // Two-step read: SELECT.one the current snapshot, then fetch its events
  // separately. A deep-expand via .columns(s => { s('*'), s.events(e => e('*')) })
  // is not used because the CQL nested-expand for to-many compositions is
  // not reliably supported in the SQL layer (CDS docs: "Nested Expands
  // following to-many associations are not supported").
  const current = await SELECT.one.from(QuarantineSnapshots).where({ isCurrent: true });
  if (!current) {
    logger.info('no current snapshot — nothing to do');
    return { currentCount: 0, survivorCount: 0, droppedSlugs: [], newSnapshotId: null };
  }

  const events = await SELECT.from(QuarantineEvents).where({ snapshot_ID: current.ID });

  const retired = await SELECT.from(Tutorials)
    .columns('slug')
    .where({ status: { in: ['DELETED', 'INACTIVE'] } });
  const retiredSet = new Set(retired.map(r => lc(r.slug)));

  const survivors = events.filter(e => !retiredSet.has(lc(e.slug)));
  const droppedSlugs = events.filter(e => retiredSet.has(lc(e.slug))).map(e => lc(e.slug));

  if (droppedSlugs.length === 0) {
    logger.info(`current snapshot has ${events.length} events, none retired — no-op`);
    return { currentCount: events.length, survivorCount: survivors.length, droppedSlugs: [], newSnapshotId: null };
  }

  logger.info(`dropping ${droppedSlugs.length} retired slug(s): ${droppedSlugs.join(', ')}`);
  if (!commit) {
    logger.info('(dry-run — pass --commit to apply)');
    return { currentCount: events.length, survivorCount: survivors.length, droppedSlugs, newSnapshotId: null };
  }

  const db = await cds.connect.to('db');
  const newId = cds.utils.uuid();
  await db.tx(async (tx) => {
    await tx.run(UPDATE(QuarantineSnapshots).set({ isCurrent: false }).where({ isCurrent: true }));
    await tx.run(INSERT.into(QuarantineSnapshots).entries({
      ID: newId,
      runId: current.runId,
      workflowUrl: current.workflowUrl,
      manifestVersion: current.manifestVersion,
      buildMode: 'full',
      isCurrent: true,
      eventCount: survivors.length,
      events: survivors.map(e => ({
        ID: cds.utils.uuid(),
        slug: lc(e.slug),
        sourceFile: e.sourceFile ?? null,
        sourceRepo: e.sourceRepo ?? null,
        reason: e.reason ?? '',
        sourceUrl: e.sourceUrl ?? null,
      })),
    }));
  });
  logger.info(`wrote new current snapshot ${newId} with ${survivors.length} survivor(s)`);
  return { currentCount: events.length, survivorCount: survivors.length, droppedSlugs, newSnapshotId: newId };
}

module.exports = { clearDeletedFromQuarantine };

if (require.main === module) {
  const commit = process.argv.includes('--commit');
  process.env.cds_requires_auth_kind = 'mocked';
  cds.load('*')
    .then(csn => { cds.model = cds.compile.for.nodejs(csn); })
    .then(() => cds.connect.to('db'))
    .then(() => clearDeletedFromQuarantine({ commit }))
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
