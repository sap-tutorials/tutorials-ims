#!/usr/bin/env node
// Remove the dead `__scheduler_selfheal__` JobLastRun orphan row (#2983).
//
// The self-heal timer (srv/lib/scheduler-reaper.js `armSchedulerSelfHeal`) is a
// plain setInterval — NOT a runWithLock job — so it never writes a JobLastRun
// row. A `__scheduler_selfheal__` row, if present, is a leftover from a previous
// self-heal implementation and reads as permanently stale on any
// JobLastRun-sorted health view. It is an operator footgun, not a liveness
// signal. See docs/developers/operations/scheduler-troubleshooting.md
// ("Self-heal liveness").
//
// Idempotent and safe on any env: dry-run by default (prints the row if present),
// deletes only with --delete, no-ops if the row is absent.
//
//   cds bind --exec -- node scripts/cleanup-selfheal-orphan.cjs            # dry-run
//   cds bind --exec -- node scripts/cleanup-selfheal-orphan.cjs --delete   # delete

const cds = require("@sap/cds");

const ORPHAN = "__scheduler_selfheal__";
const DO_DELETE = process.argv.includes("--delete");

(async () => {
  // Load + link the CDS model so `cds.entities(...)` is callable. Under
  // `cds bind --exec` there is no serving lifecycle to populate cds.model, and
  // a bare CSN's `.definitions` is non-iterable — prime the getter BEFORE
  // connect, which otherwise strips the iterator linked() installs. See #757/#911.
  cds.model = cds.linked(await cds.load("*"));
  void cds.model.entities;
  await cds.connect.to("db");
  const { JobLastRun } = cds.entities("com.sap.developers.ims");

  const [row] = await cds.run(
    SELECT.from(JobLastRun).where({ jobName: ORPHAN })
  );

  if (!row) {
    console.log(`No '${ORPHAN}' row in JobLastRun — nothing to do.`);
    process.exit(0);
  }

  console.log(
    `Found orphan: jobName=${row.jobName} lastSuccessAt=${row.lastSuccessAt} ` +
      `lastErrorAt=${row.lastErrorAt ?? "null"}`
  );

  if (!DO_DELETE) {
    console.log("Dry-run (no --delete): leaving the row in place.");
    process.exit(0);
  }

  const deleted = await cds.run(DELETE.from(JobLastRun).where({ jobName: ORPHAN }));
  console.log(`Deleted ${deleted} '${ORPHAN}' row(s) from JobLastRun.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
