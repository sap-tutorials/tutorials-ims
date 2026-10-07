import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { clearDeletedFromQuarantine } from '../clear-deleted-from-quarantine.cjs';

const NS = 'com.sap.developers.ims';
cds.test('serve', '--project', '.', '--in-memory');

describe('clearDeletedFromQuarantine', () => {
  beforeAll(async () => { await cds.connect.to('db'); });
  beforeEach(async () => {
    const { QuarantineSnapshots, QuarantineEvents, Tutorials } = cds.entities(NS);
    await DELETE.from(QuarantineEvents);
    await DELETE.from(QuarantineSnapshots);
    await DELETE.from(Tutorials);
  });

  async function seed() {
    const { QuarantineSnapshots, Tutorials } = cds.entities(NS);
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), slug: 'dead', title: 't', status: 'DELETED' },
      { ID: cds.utils.uuid(), slug: 'live', title: 't', status: 'ACTIVE' },
    ]);
    await INSERT.into(QuarantineSnapshots).entries({
      ID: cds.utils.uuid(), buildMode: 'full', isCurrent: true, eventCount: 2,
      events: [
        { ID: cds.utils.uuid(), slug: 'dead', reason: 'x' },
        { ID: cds.utils.uuid(), slug: 'live', reason: 'y' },
      ],
    });
  }

  it('dry-run reports survivors without mutating', async () => {
    await seed();
    const { QuarantineSnapshots } = cds.entities(NS);
    const r = await clearDeletedFromQuarantine({ commit: false });
    expect(r.droppedSlugs).toEqual(['dead']);
    expect(r.survivorCount).toBe(1);
    const cur = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(cur[0].eventCount).toBe(2); // unchanged
  });

  it('commit writes a new current snapshot with only survivors', async () => {
    await seed();
    const { QuarantineSnapshots, QuarantineEvents } = cds.entities(NS);
    await clearDeletedFromQuarantine({ commit: true });
    const cur = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(cur.length).toBe(1);
    const ev = await SELECT.from(QuarantineEvents).where({ snapshot_ID: cur[0].ID });
    expect(ev.map(e => e.slug)).toEqual(['live']);
  });

  it('no-op when no current event is excluded', async () => {
    const { Tutorials, QuarantineSnapshots } = cds.entities(NS);
    await INSERT.into(Tutorials).entries({ ID: cds.utils.uuid(), slug: 'live', title: 't', status: 'ACTIVE' });
    await INSERT.into(QuarantineSnapshots).entries({
      ID: cds.utils.uuid(), buildMode: 'full', isCurrent: true, eventCount: 1,
      events: [{ ID: cds.utils.uuid(), slug: 'live', reason: 'y' }],
    });
    const r = await clearDeletedFromQuarantine({ commit: true });
    expect(r.droppedSlugs).toEqual([]);
    expect(r.newSnapshotId).toBeNull();
  });
});
