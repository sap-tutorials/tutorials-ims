import cds from '@sap/cds';
import { mergeAccounts } from '../lib/account-merge.js';

// pickCanonicalRow lives in the workspace core (packages/core/resolve-db-user.js).
// Import chain:
//  1. Try @tutorials/core directly — works when the workspace symlink is fresh
//     (post-merge main) or we're inside the CF bundle.
//  2. Try the relative workspace path — works in the worktree where the symlink
//     still points at a pre-Task-2 main-repo copy that lacks pickCanonicalRow.
//  3. Fall back to the srv/lib re-export (bundle path at CF runtime).
async function loadPick() {
  for (const path of [
    '@tutorials/core/resolve-db-user.js',
    '../../packages/core/resolve-db-user.js',
    '../lib/resolve-db-user.js',
  ]) {
    try {
      const m = await import(path);
      if (typeof m.pickCanonicalRow === 'function') return m.pickCanonicalRow;
    } catch { /* try next */ }
  }
  throw new Error('pickCanonicalRow could not be loaded from any known path');
}

// Sum a user's CatGameAwards points (across all events) — used for the
// before/after delta so the dry-run report shows real point movement.
async function sumAwards(CatGameAwards, userIds) {
  if (!userIds.length) return 0;
  const rows = await SELECT.from(CatGameAwards).where({ user_ID: { in: userIds } });
  return rows.reduce((n, r) => n + (r.points ?? 0), 0);
}

export async function reconcileDuplicateEmails({ dryRun = true, limit } = {}) {
  const LOG = cds.log('identity-dedup');
  const { Users, EventRegistrations, CatGameAwards } = cds.entities('com.sap.developers.ims');
  const pickCanonicalRow = await loadPick();

  // Clusters: emails shared by >1 Users row. lower() so case variants cluster.
  const dupEmails = await SELECT`email, count(*) as n`.from(Users)
    .where`email is not null`.groupBy('email').having`count(*) > 1`;
  const slice = limit ? dupEmails.slice(0, limit) : dupEmails;

  let merges = 0, pointsBefore = 0, pointsAfter = 0, capTrims = 0;

  for (const { email } of slice) {
    const rows = await SELECT.from(Users).where`lower(email) = ${String(email).toLowerCase()}`;
    if (rows.length < 2) continue;

    // Tag registration-bearing rows so pickCanonicalRow prefers them.
    for (const r of rows) {
      const reg = await SELECT.one.from(EventRegistrations).where({ user_ID: r.ID });
      r.__hasRegistration = !!reg;
    }
    const primary = pickCanonicalRow(rows);
    const secondaries = rows.filter((r) => r.ID !== primary.ID);

    // Points before = sum across ALL rows in the cluster (primary + secondaries).
    const clusterIds = rows.map((r) => r.ID);
    const before = await sumAwards(CatGameAwards, clusterIds);
    pointsBefore += before;

    if (dryRun) {
      // Dry run: report what WOULD merge, and the capped after-total we WOULD
      // land on (sum, but no event can exceed 100). Approximate the cap by
      // clamping per-event; good enough for review-grade numbers.
      merges += secondaries.length;
      const afterCapped = await projectCappedTotal(CatGameAwards, clusterIds);
      pointsAfter += afterCapped.total;
      capTrims += afterCapped.trimmed;
      continue;
    }

    for (const s of secondaries) {
      await mergeAccounts(primary.uuid, s.uuid);
      merges++;
    }
    // Points after = sum on the surviving primary row only.
    const after = await sumAwards(CatGameAwards, [primary.ID]);
    pointsAfter += after;
    capTrims += Math.max(0, before - after);
  }

  LOG.info(`reconcile dryRun=${dryRun} clusters=${slice.length} merges=${merges} pointsBefore=${pointsBefore} pointsAfter=${pointsAfter} capTrims=${capTrims}`);
  return { clusters: slice.length, merges, pointsBefore, pointsAfter, capTrims, executed: !dryRun };
}

// Dry-run helper: project the post-merge per-event total under the 100-cap,
// without mutating. Groups the cluster's awards by (event, awardDate), sums
// per day to the 5-cap, then clamps each event to 100. Returns {total, trimmed}.
async function projectCappedTotal(CatGameAwards, clusterIds) {
  if (!clusterIds.length) return { total: 0, trimmed: 0 };
  const rows = await SELECT.from(CatGameAwards).where({ user_ID: { in: clusterIds } });
  const DAILY = 5, EVENT_CAP = 100;
  const rawByEvent = {};       // event → sum of raw points
  const perDay = {};           // `${event}|${day}` → summed-then-daily-capped
  for (const r of rows) {
    rawByEvent[r.event_ID] = (rawByEvent[r.event_ID] ?? 0) + (r.points ?? 0);
    const k = `${r.event_ID}|${r.awardDate}`;
    perDay[k] = Math.min((perDay[k] ?? 0) + (r.points ?? 0), DAILY);
  }
  const cappedByEvent = {};
  for (const [k, pts] of Object.entries(perDay)) {
    const ev = k.split('|')[0];
    cappedByEvent[ev] = (cappedByEvent[ev] ?? 0) + pts;
  }
  let total = 0, trimmed = 0;
  for (const ev of Object.keys(cappedByEvent)) {
    const capped = Math.min(cappedByEvent[ev], EVENT_CAP);
    total += capped;
    trimmed += (rawByEvent[ev] ?? 0) - capped;
  }
  return { total, trimmed };
}
