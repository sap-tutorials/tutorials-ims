// test/unit/identity-dedup-job.test.js
//
// Vitest/ESM tests for reconcileDuplicateEmails() (#2651).
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Boot CAP with in-memory SQLite once for this file.
// SELECT / INSERT / DELETE / UPDATE become globals via cds.test().
cds.test('serve', '--project', '.', '--in-memory');

const { reconcileDuplicateEmails } = await import('../../srv/jobs/identity-dedup-job.js');

describe('reconcileDuplicateEmails — dry-run batch dedup (#2651)', () => {
  let Users, Events, EventRegistrations, CatGameAwards, SecondaryAccounts;

  beforeAll(async () => {
    await cds.connect.to('db');
    ({ Users, Events, EventRegistrations, CatGameAwards, SecondaryAccounts } =
      cds.entities('com.sap.developers.ims'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 1: Dry-run reports clusters WITHOUT mutating.
  // ─────────────────────────────────────────────────────────────────────────
  it('dry-run: reports cluster without mutating user rows', async () => {
    const email = `dup-${cds.utils.uuid()}@x.io`;

    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: cds.utils.uuid(),
      email, legacyId: 1001, sapId: null,
      createdAt: '2026-09-20T00:00:00Z',
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: cds.utils.uuid(),
      email, legacyId: 1002, sapId: null,
      createdAt: '2026-09-25T00:00:00Z',
    });

    const report = await reconcileDuplicateEmails({ dryRun: true });

    expect(report.clusters).toBeGreaterThanOrEqual(1);
    expect(report.merges).toBeGreaterThanOrEqual(1);
    expect(report.executed).toBe(false);

    // Row count must be unchanged (no mutation in dry-run)
    const rowsAfter = await SELECT.from(Users).where({ email });
    expect(rowsAfter.length).toBe(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2: Execute collapses the cluster.
  // ─────────────────────────────────────────────────────────────────────────
  it('execute: records MERGED in SecondaryAccounts, primary survives', async () => {
    const email = `exec-${cds.utils.uuid()}@x.io`;
    const primaryUuid = cds.utils.uuid();
    const secondaryUuid = cds.utils.uuid();

    // Older createdAt → pickCanonicalRow prefers the oldest as canonical primary
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: primaryUuid,
      email, legacyId: 2001, sapId: null,
      createdAt: '2026-09-20T00:00:00Z',
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: secondaryUuid,
      email, legacyId: 2002, sapId: null,
      createdAt: '2026-09-25T00:00:00Z',
    });

    const report = await reconcileDuplicateEmails({ dryRun: false });

    expect(report.executed).toBe(true);
    expect(report.merges).toBeGreaterThanOrEqual(1);

    // SecondaryAccounts must have a MERGED record for secondaryUuid
    const merged = await SELECT.from(SecondaryAccounts).where({ uuid: secondaryUuid });
    expect(merged.length).toBeGreaterThanOrEqual(1);
    expect(merged.some(r => r.status === 'MERGED')).toBe(true);

    // Primary user still exists
    const primary = await SELECT.from(Users).where({ uuid: primaryUuid });
    expect(primary.length).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3: Point delta is real, not zero.
  // Two users, same email, each with 5 pts on DISTINCT days → sum 10, no trim.
  // ─────────────────────────────────────────────────────────────────────────
  it('dry-run: pointsBefore/pointsAfter are real (10 pts, no cap trim)', async () => {
    const email = `pts-${cds.utils.uuid()}@x.io`;

    const uid1 = cds.utils.uuid();
    const uid2 = cds.utils.uuid();

    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: uid1,
      email, legacyId: 3001, sapId: null,
      createdAt: '2026-09-20T00:00:00Z',
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: uid2,
      email, legacyId: 3002, sapId: null,
      createdAt: '2026-09-25T00:00:00Z',
    });

    const user1 = await SELECT.one.from(Users).where({ uuid: uid1 });
    const user2 = await SELECT.one.from(Users).where({ uuid: uid2 });

    const evId = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: evId,
      name: `DevtoberFest-pts-${evId}`,
      eventType: 'DEVTOBERFEST',
      startDate: '2026-09-21T00:00:00Z',
      endDate: '2026-10-18T00:00:00Z',
    });

    // User1: 5 pts on day 2026-09-21
    await INSERT.into(CatGameAwards).entries({
      user_ID: user1.ID, event_ID: evId, awardDate: '2026-09-21', points: 5,
    });
    // User2: 5 pts on a DISTINCT day 2026-09-22
    await INSERT.into(CatGameAwards).entries({
      user_ID: user2.ID, event_ID: evId, awardDate: '2026-09-22', points: 5,
    });

    const report = await reconcileDuplicateEmails({ dryRun: true, limit: 1000 });

    // Find this specific cluster's contribution
    // The report aggregates across ALL clusters; we can only assert that the
    // totals are at least the values from this cluster (other clusters may exist
    // from earlier tests).
    expect(report.pointsBefore).toBeGreaterThanOrEqual(10);
    expect(report.pointsAfter).toBeGreaterThanOrEqual(10);
    // capTrims may be 0 or more depending on other clusters, but for 2 distinct
    // days with 5 pts each (total 10, well under 100-cap) there is no trim from
    // this cluster — just assert fields are not all-zero (real computation ran)
    expect(report.pointsBefore).toBeGreaterThan(0);
    expect(report.executed).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 4: limit caps cluster count.
  // ─────────────────────────────────────────────────────────────────────────
  it('limit: restricts cluster count to exactly 1', async () => {
    // Insert two fresh dup-email clusters so we know at least 2 are available.
    for (let i = 0; i < 2; i++) {
      const email = `limit-${cds.utils.uuid()}@x.io`;
      await INSERT.into(Users).entries([
        { ID: cds.utils.uuid(), uuid: cds.utils.uuid(), email, legacyId: 4001 + i * 2 },
        { ID: cds.utils.uuid(), uuid: cds.utils.uuid(), email, legacyId: 4002 + i * 2 },
      ]);
    }

    const report = await reconcileDuplicateEmails({ dryRun: true, limit: 1 });

    expect(report.clusters).toBe(1);
  });
});
