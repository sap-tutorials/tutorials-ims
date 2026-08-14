// test/unit/top-tutorials-snapshot.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { recomputeSnapshot, readSnapshotForFeed, WINDOWS, TOP_N } from '../../srv/lib/top-tutorials-snapshot.js';

const NS = 'com.sap.developers.ims';
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

cds.test(__dirname + '/../..', '--in-memory');

async function seed() {
  const db = await cds.connect.to('db');
  const { Tutorials, TaskRecords, Users, TopTutorialsSnapshot } = cds.entities(NS);
  await db.run(DELETE.from(TopTutorialsSnapshot));
  await db.run(DELETE.from(TaskRecords));
  await db.run(DELETE.from(Tutorials));
  // Active tutorials (legacyId → slug). t-inactive is INACTIVE and must be excluded.
  await db.run(INSERT.into(Tutorials).entries([
    { ID: cds.utils.uuid(), legacyId: 1, slug: 't-popular', title: 'Popular', status: 'ACTIVE', description: 'd1' },
    { ID: cds.utils.uuid(), legacyId: 2, slug: 't-mid',     title: 'Mid',     status: null,     description: 'd2' },
    { ID: cds.utils.uuid(), legacyId: 3, slug: 't-inactive',title: 'Inactive',status: 'INACTIVE', description: 'd3' },
  ]));
  const uid = cds.utils.uuid();
  await db.run(INSERT.into(Users).entries([{ ID: uid }]));
  const rec = (legacyId, status, msAgo) => ({
    ID: cds.utils.uuid(), user_ID: uid, taskType: 'TUTORIAL', taskLegacyId: legacyId,
    status, completionDate: iso(msAgo),
  });
  await db.run(INSERT.into(TaskRecords).entries([
    // t-popular: 3 completions inside 90d (incl one SUPERSEDED — must count)
    rec(1, 'COMPLETED', 5 * DAY_MS), rec(1, 'COMPLETED', 10 * DAY_MS), rec(1, 'SUPERSEDED', 20 * DAY_MS),
    // t-mid: 1 completion inside 90d, +1 at 200d (only in the 360 window)
    rec(2, 'COMPLETED', 15 * DAY_MS), rec(2, 'COMPLETED', 200 * DAY_MS),
    // t-inactive: 50 completions inside 90d — must be EXCLUDED (inactive tutorial)
    ...Array.from({ length: 50 }, () => rec(3, 'COMPLETED', 1 * DAY_MS)),
    // noise: an IN_PROGRESS row (no completionDate window meaning) must not count
    { ID: cds.utils.uuid(), user_ID: uid, taskType: 'TUTORIAL', taskLegacyId: 1, status: 'IN_PROGRESS', completionDate: null },
  ]));
}

describe('top-tutorials-snapshot', () => {
  beforeAll(seed);

  it('materializes top-N per window, counting SUPERSEDED, excluding inactive tutorials', async () => {
    const tx = cds.tx({});
    const { count } = await recomputeSnapshot(tx);
    await tx.commit();
    expect(WINDOWS).toEqual([90, 180, 360]);
    expect(count).toBeGreaterThan(0);

    const feed = await readSnapshotForFeed(cds.tx({}));
    const w90 = feed.windows.find(w => w.windowDays === 90).items;
    // t-popular (3) ranks above t-mid (1); t-inactive excluded entirely.
    expect(w90.map(i => i.slug)).toEqual(['t-popular', 't-mid']);
    expect(w90[0].completions).toBe(3);
    expect(w90.every(i => i.slug !== 't-inactive')).toBe(true);
    // 360-day window sees t-mid's extra 200d completion → 2.
    const w360 = feed.windows.find(w => w.windowDays === 360).items;
    expect(w360.find(i => i.slug === 't-mid').completions).toBe(2);
    // hydrated card carries title + description + href.
    expect(w90[0].card.title).toBe('Popular');
    expect(w90[0].card.href).toBe('/tutorials/t-popular');
  });

  it('recompute is idempotent (atomic replace, not append)', async () => {
    const tx1 = cds.tx({}); await recomputeSnapshot(tx1); await tx1.commit();
    const before = (await readSnapshotForFeed(cds.tx({}))).windows.find(w => w.windowDays === 90).items.length;
    const tx2 = cds.tx({}); await recomputeSnapshot(tx2); await tx2.commit();
    const after = (await readSnapshotForFeed(cds.tx({}))).windows.find(w => w.windowDays === 90).items.length;
    expect(after).toBe(before);
    expect(after).toBeLessThanOrEqual(TOP_N);
  });

  it('empty table → empty windows + stable etag, no throw', async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from(cds.entities(NS).TopTutorialsSnapshot));
    const feed = await readSnapshotForFeed(cds.tx({}));
    expect(feed.windows).toEqual([]);
    expect(typeof feed.etag).toBe('string');
  });
});
