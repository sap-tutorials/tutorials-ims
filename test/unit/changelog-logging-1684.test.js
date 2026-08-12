// test/unit/changelog-logging-1684.test.js
//
// #1684 — "Various objects not showing the object history".
// The @cap-js/change-tracking v2 plugin only generates DB triggers for
// ELEMENT-level @changelog annotations. Entity-level-only @changelog (the v1
// idiom this project started on, ^1.2.1) still renders the Change History
// facet but logs nothing under v2 — db/change-tracking.cds carried bare
// entity-level annotations for these entities.
//
// This suite writes to the underlying DB tables and asserts a row lands in
// sap.changelog.Changes. Triggers fire at the DB layer, so a direct UPDATE on
// the table is sufficient to prove the trigger exists. Missions (already
// element-annotated in app/change-tracking.cds) is the positive control.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

let Changes, ims;

async function changeCountFor(entityKey, attribute) {
  const rows = await SELECT.from(Changes).where({ entityKey, attribute });
  return rows.length;
}

describe('#1684 change-tracking actually logs field updates', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
    ims = cds.entities('com.sap.developers.ims');
    Changes = cds.entities('sap.changelog').Changes;
  });

  it('POSITIVE CONTROL: element-annotated entity (Missions.title) logs', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.Missions).entries({ ID, slug: `m-${ID}`, title: 'Before' });
    await UPDATE(ims.Missions).set({ title: 'After' }).where({ ID });
    expect(await changeCountFor(ID, 'title')).toBeGreaterThan(0);
  });

  it('LegacyRedirects.toPath UPDATE is logged', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.LegacyRedirects).entries({ ID, fromPath: `/old-${ID}`, toPath: '/new1', statusCode: 301 });
    await UPDATE(ims.LegacyRedirects).set({ toPath: '/new2' }).where({ ID });
    expect(await changeCountFor(ID, 'toPath')).toBeGreaterThan(0);
  });

  it('LegacyRedirects.hitCount is NOT tracked (runtime counter, avoids noise)', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.LegacyRedirects).entries({ ID, fromPath: `/h-${ID}`, toPath: '/x', statusCode: 301, hitCount: 0 });
    await UPDATE(ims.LegacyRedirects).set({ hitCount: 99 }).where({ ID });
    expect(await changeCountFor(ID, 'hitCount')).toBe(0);
  });

  it('HomepageShelves.title UPDATE is logged', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.HomepageShelves).entries({ ID, verb: 'BUILD', shelf: 'TOOLS', title: 'Before', url: 'https://x.test' });
    await UPDATE(ims.HomepageShelves).set({ title: 'After' }).where({ ID });
    expect(await changeCountFor(ID, 'title')).toBeGreaterThan(0);
  });

  it('Advocates.title UPDATE is logged', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.Advocates).entries({ ID, slug: `a-${ID}`, firstName: 'A', lastName: 'B', title: 'Dev' });
    await UPDATE(ims.Advocates).set({ title: 'Advocate' }).where({ ID });
    expect(await changeCountFor(ID, 'title')).toBeGreaterThan(0);
  });

  it('Secrets.rotationOwner UPDATE is logged', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.Secrets).entries({ ID, key: `s-${ID}`, rotationOwner: 'alice' });
    await UPDATE(ims.Secrets).set({ rotationOwner: 'bob' }).where({ ID });
    expect(await changeCountFor(ID, 'rotationOwner')).toBeGreaterThan(0);
  });

  it('Alerts.body UPDATE is logged', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.Alerts).entries({ ID, title: 'T', body: 'old', severity: 'Information', audience: 'ALL', startsAt: '2026-01-01T00:00:00Z' });
    await UPDATE(ims.Alerts).set({ body: 'new' }).where({ ID });
    expect(await changeCountFor(ID, 'body')).toBeGreaterThan(0);
  });

  it('Tutorials.title UPDATE is logged', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.Tutorials).entries({ ID, slug: `t-${ID}`, title: 'Before' });
    await UPDATE(ims.Tutorials).set({ title: 'After' }).where({ ID });
    expect(await changeCountFor(ID, 'title')).toBeGreaterThan(0);
  });

  it('Concepts.status UPDATE is logged', async () => {
    const ID = cds.utils.uuid();
    await INSERT.into(ims.Concepts).entries({ ID, slug: `c-${ID}`, name: 'Concept', status: 'ACTIVE' });
    await UPDATE(ims.Concepts).set({ status: 'VETOED' }).where({ ID });
    expect(await changeCountFor(ID, 'status')).toBeGreaterThan(0);
  });
});
