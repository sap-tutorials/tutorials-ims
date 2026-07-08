// scripts/probe-outbox-shape.mjs
//
// #1021: probe that documents the ACTUAL cds.outbox.Messages shape at
// runtime. Prints:
//   - resolved entity name + element list with type
//   - up to 5 sample rows from CDS_OUTBOX_MESSAGES (or the equivalent
//     SQLite table if run locally), redacted to just the wedge-relevant
//     columns
//   - a shape-assertion summary printed at the end so a CAP upgrade
//     that changes column semantics fails LOUDLY here instead of
//     silently in production
//
// Run against local SQLite (`node scripts/probe-outbox-shape.mjs`) OR
// hybrid HANA (`cds bind --exec -- node scripts/probe-outbox-shape.mjs`).
// The hybrid form is the important one — the initial #1021 bug shipped
// because the probe was run only against in-memory SQLite with an empty
// table, so the element list looked right but the runtime FILTER shape
// was never observed.
//
// ─────────────────────────────────────────────────────────────────────
// Confirmed shape (CAP 10.x, verified against DEV HANA 2026-07-07)
// ─────────────────────────────────────────────────────────────────────
// Reference source: node_modules/@sap/cds/libx/queue/{consts.js,index.js}
//
//   target='queue'      literal string for every scheduled task
//   task=<jobName>      the `.as(name)` label from srv.schedule().as(name)
//   status=NULL         initial (pending)
//   status='processing' picked up by the queue runner (queue/index.js:185)
//   attempts            incremented on failure
//   row is DELETE'd on success (queue/index.js:266)
//
// Stuck signature (what scheduler-wedge.js detects):
//   target='queue' AND task=<jobName> AND status='processing' AND
//     row age > STALE_FLOOR_MS (60 min)  OR
//     row survived past its own next-scheduled-fire
//
// Refresh: re-run and update the header comment above after every CAP
// major bump.

import cds from '@sap/cds';
import path from 'node:path';

async function main() {
  // If a cds bind wired up a real DB, use it; otherwise deploy in-memory.
  const isHybrid = !!process.env.VCAP_SERVICES || !!process.env.CDS_ENV_BIND;
  if (!isHybrid) {
    console.log('[probe] no bind detected — deploying model to sqlite::memory:');
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
      path.join(process.cwd(), 'node_modules/@sap/cds/srv/outbox.cds'),
    ]).to('sqlite::memory:');
  } else {
    console.log('[probe] hybrid bind detected — reading from live DB');
  }

  const outbox = cds.entities('cds.outbox');
  if (!outbox?.Messages) {
    console.error('FAIL: cds.entities("cds.outbox").Messages is missing');
    process.exit(2);
  }
  const M = outbox.Messages;
  console.log('\nEntity:', M.name);
  console.log('Elements:');
  for (const [key, def] of Object.entries(M.elements)) {
    console.log(`  - ${key}: ${def.type}${def.key ? ' (key)' : ''}`);
  }

  const db = await cds.connect.to('db');
  const allRows = await db.run(SELECT.from(M));
  console.log(`\nTotal rows: ${allRows.length}`);

  const counts = { total: allRows.length, pending: 0, processing: 0, otherStatus: 0 };
  const byTarget = new Map();
  for (const r of allRows) {
    const status = r.status ?? r.STATUS ?? null;
    const target = r.target ?? r.TARGET ?? '';
    if (status === null || status === '') counts.pending++;
    else if (status === 'processing') counts.processing++;
    else counts.otherStatus++;
    byTarget.set(target, (byTarget.get(target) ?? 0) + 1);
  }
  console.log('Status distribution:');
  console.log(`  status=NULL/empty:   ${counts.pending}`);
  console.log(`  status=processing:   ${counts.processing}`);
  console.log(`  status=other/unknown: ${counts.otherStatus}`);
  console.log('target column values:');
  for (const [tgt, cnt] of byTarget) console.log(`  ${JSON.stringify(tgt)}: ${cnt}`);

  console.log('\nUp to 5 sample rows (wedge-relevant columns only):');
  for (const r of allRows.slice(0, 5)) {
    console.log(JSON.stringify({
      ID: r.ID ?? r.id,
      timestamp: r.timestamp ?? r.TIMESTAMP,
      lastAttemptTimestamp: r.lastAttemptTimestamp ?? r.LASTATTEMPTTIMESTAMP,
      target: r.target ?? r.TARGET,
      task: r.task ?? r.TASK,
      status: r.status ?? r.STATUS,
      attempts: r.attempts ?? r.ATTEMPTS,
    }, null, 2));
  }

  // Shape assertions — fail LOUDLY if CAP changes semantics.
  console.log('\nShape assertions:');
  const requiredElements = ['target', 'task', 'status', 'timestamp', 'lastAttemptTimestamp'];
  const missing = requiredElements.filter(k => !(k in M.elements));
  if (missing.length) {
    console.error(`FAIL: missing required elements on cds.outbox.Messages: ${missing.join(', ')}`);
    process.exit(3);
  } else {
    console.log('  OK: all expected elements present (target, task, status, timestamp, lastAttemptTimestamp)');
  }

  // If we're on hybrid AND there are rows, sanity-check that target is
  // dominated by 'queue' (real semantics). One 'queue' row is enough
  // to confirm — this asserts CAP did not flip the convention.
  if (isHybrid && byTarget.size > 0) {
    if (!byTarget.has('queue')) {
      console.error('FAIL: no rows with target="queue" observed on hybrid DB — CAP semantics may have changed.');
      process.exit(4);
    }
    console.log('  OK: target="queue" observed on hybrid DB (expected for scheduled tasks)');
  }

  await cds.disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
