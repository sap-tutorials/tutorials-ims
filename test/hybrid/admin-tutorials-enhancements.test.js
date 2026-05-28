import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__';
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe.runIf(isSafeForWrites())('Tutorials enhancements (#95) [hybrid]', () => {
  const tutorialIds = [];
  const metaIds = [];
  const feedbackIds = [];

  afterAll(async () => {
    const { Tutorials, TutorialMeta, TutorialFeedback } = cds.entities('com.sap.developers.ims');
    for (const id of feedbackIds) await DELETE.from(TutorialFeedback).where({ ID: id });
    for (const id of metaIds)     await DELETE.from(TutorialMeta).where({ ID: id });
    for (const id of tutorialIds) await DELETE.from(Tutorials).where({ ID: id });
  });

  it('TutorialOwnerPickList compiles + returns distinct rows on HANA', async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    const tut = cds.utils.uuid();
    const meta1 = cds.utils.uuid();
    tutorialIds.push(tut); metaIds.push(meta1);
    await INSERT.into(Tutorials).entries([
      { ID: tut, slug: TEST_PREFIX + 'pl-1', title: TEST_PREFIX + 'PL', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: meta1, tutorial_ID: tut, owner: TEST_PREFIX + 'OwnerHybrid' }
    ]);

    const srv = await cds.connect.to('AdminService');
    const rows = await srv.read('TutorialOwnerPickList').where({ owner: TEST_PREFIX + 'OwnerHybrid' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].owner).toBe(TEST_PREFIX + 'OwnerHybrid');
  });

  it('Tutorials.meta/owner $filter round-trips through HANA', async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    const tut = cds.utils.uuid();
    const meta = cds.utils.uuid();
    tutorialIds.push(tut); metaIds.push(meta);
    const ownerName = TEST_PREFIX + 'FilterOwner-' + Date.now();
    await INSERT.into(Tutorials).entries([
      { ID: tut, slug: TEST_PREFIX + 'flt', title: TEST_PREFIX + 'FLT', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: meta, tutorial_ID: tut, owner: ownerName }
    ]);

    const srv = await cds.connect.to('AdminService');
    const rows = await srv.read('Tutorials')
      .columns('ID', { ref: ['meta'], expand: ['owner'] })
      .where({ 'meta.owner': ownerName });
    expect(rows.length).toBe(1);
    expect(rows[0].ID).toBe(tut);
    expect(rows[0].meta?.owner).toBe(ownerName);
  });

  it('Tutorials.feedbackSummary expands on HANA', async () => {
    const { Tutorials, TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const tut = cds.utils.uuid();
    const slug = TEST_PREFIX + 'fb-' + Date.now();
    const fb1 = cds.utils.uuid(); const fb2 = cds.utils.uuid();
    tutorialIds.push(tut); feedbackIds.push(fb1, fb2);
    await INSERT.into(Tutorials).entries([
      { ID: tut, slug, title: TEST_PREFIX + 'FB', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialFeedback).entries([
      { ID: fb1, tutorialSlug: slug, npsScore: 9 },
      { ID: fb2, tutorialSlug: slug, npsScore: 5 },
    ]);

    const srv = await cds.connect.to('AdminService');
    const [row] = await srv.read('Tutorials')
      .columns('ID', { ref: ['feedbackSummary'], expand: ['*'] })
      .where({ ID: tut });
    expect(row.feedbackSummary?.responseCount).toBe(2);
    expect(Number(row.feedbackSummary.avgNps)).toBeCloseTo(7, 0);
  });
});
