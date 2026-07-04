// test/hybrid/cron-service-schedule.test.js
//
// Hybrid smoke test: after CAP bootstraps with CronService, the outbox
// table (cds.outbox.Messages) should contain one pending row per
// registered job, with singleton names matching the jobName field.
//
// Catches config regressions (accidental protocol exposure, missing
// schedule call) that unit-mock spies cannot.
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
// Issue: #958

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('CronService schedule smoke (hybrid)', () => {
  let sched;

  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to inspect HANA outbox.');
    }
    // Trigger CAP boot so CronService.init() runs.
    await cds.connect.to('db');
    // Import the registry the same way test/hybrid/admin-run-job.test.js does
    // (cds.utils._import handles Windows file:// URL resolution). Shares the
    // SAME module instance the CronService init used.
    const schedPath = path.resolve(process.cwd(), 'srv/jobs/scheduler.js');
    sched = await cds.utils._import(schedPath);
  });

  it('outbox contains one pending message per registered job', async () => {
    const registeredJobs = Array.from(sched._getJobRegistry().values());
    // Sanity check: at least the 32 production jobs registered.
    expect(registeredJobs.length).toBeGreaterThan(30);

    const db = await cds.connect.to('db');

    // The CAP outbox writes to cds.outbox.Messages. The exact column names
    // and message-envelope shape depend on the CAP 10 outbox implementation;
    // query broadly and reason about the result set.
    let rows = [];
    try {
      const { Messages } = cds.entities('cds.outbox');
      rows = await db.run(SELECT.from(Messages));
    } catch (err) {
      // If the entity name differs across CAP 10 versions, surface a
      // helpful message rather than the raw "entity not found" error.
      throw new Error(
        `Could not query cds.outbox.Messages: ${err.message}. ` +
        `Adjust this test's SELECT once the actual outbox entity name is confirmed.`
      );
    }

    // Extract all scheduled event names from the outbox message envelopes.
    // Message payloads may be stored under `msg`, `data`, `envelope`, etc. —
    // we scan every column for the "cron.<jobName>" pattern.
    const scheduledNames = new Set();
    for (const r of rows) {
      for (const v of Object.values(r)) {
        if (typeof v !== 'string') continue;
        // Payloads are typically JSON — try to parse; fall back to substring match.
        let parsed = null;
        try { parsed = JSON.parse(v); } catch { /* not JSON */ }
        if (parsed?.event && typeof parsed.event === 'string' && parsed.event.startsWith('cron.')) {
          scheduledNames.add(parsed.event);
        } else if (v.includes('"cron.')) {
          const matches = v.match(/"cron\.[a-z0-9-]+"/g) || [];
          for (const m of matches) scheduledNames.add(m.replaceAll('"', ''));
        }
      }
    }

    // Every registered jobName should have a scheduled entry.
    const missing = [];
    for (const job of registeredJobs) {
      if (!scheduledNames.has(`cron.${job.jobName}`)) missing.push(job.jobName);
    }
    if (missing.length > 0) {
      throw new Error(
        `Outbox missing scheduled entries for: ${missing.join(', ')}. ` +
        `Found ${scheduledNames.size} scheduled cron.* entries total.`
      );
    }
  });
});
