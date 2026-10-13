// test/lib/completion-rollup-inactive.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadGroupSlots, loadMissionSlots } from '../../srv/lib/completion-rollup.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('slot loaders exclude INACTIVE tutorials', () => {
  let db;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    const { Tutorials, Groups, GroupPathItems } = cds.entities(NS);
    await db.run(INSERT.into(Tutorials).entries(
      { ID: 't-act', legacyId: 7001, slug: 'active-tut', status: 'ACTIVE' },
      { ID: 't-ina', legacyId: 7002, slug: 'retired-tut', status: 'INACTIVE' },
    ));
    await db.run(INSERT.into(Groups).entries({ ID: 'g-1', legacyId: 8001, title: 'G' }));
    await db.run(INSERT.into(GroupPathItems).entries(
      { ID: 'gpi-1', group_ID: 'g-1', tutorial_ID: 't-act', itemOrder: 10 },
      { ID: 'gpi-2', group_ID: 'g-1', tutorial_ID: 't-ina', itemOrder: 20 },
    ));
  });
  afterEach(async () => {
    const { Tutorials, Groups, GroupPathItems } = cds.entities(NS);
    await db.run(DELETE.from(GroupPathItems).where({ group_ID: 'g-1' }));
    await db.run(DELETE.from(Groups).where({ ID: 'g-1' }));
    await db.run(DELETE.from(Tutorials).where({ ID: { in: ['t-act', 't-ina'] } }));
  });

  it('drops the INACTIVE tutorial slot, keeps the ACTIVE one', async () => {
    const slots = await loadGroupSlots('g-1', db);
    expect(slots).toHaveLength(1);
    expect(slots[0].tokens).toEqual(['TUTORIAL:7001']);
  });

  it('loadMissionSlots drops INACTIVE direct tutorial items', async () => {
    const { Missions, CompletionPaths, CompletionPathItems } = cds.entities(NS);
    await db.run(INSERT.into(Missions).entries({ ID: 'm-1', legacyId: 8501, title: 'M' }));
    await db.run(INSERT.into(CompletionPaths).entries({ ID: 'cp-1', mission_ID: 'm-1', legacyId: 8601 }));
    await db.run(INSERT.into(CompletionPathItems).entries(
      { ID: 'cpi-1', path_ID: 'cp-1', taskType: 'TUTORIAL', taskLegacyId: 7001, itemOrder: 10 },
      { ID: 'cpi-2', path_ID: 'cp-1', taskType: 'TUTORIAL', taskLegacyId: 7002, itemOrder: 20 },
    ));
    const slots = await loadMissionSlots('m-1', db);
    expect(slots).toHaveLength(1);
    expect(slots[0].tokens).toEqual(['TUTORIAL:7001']);
    await db.run(DELETE.from(CompletionPathItems).where({ path_ID: 'cp-1' }));
    await db.run(DELETE.from(CompletionPaths).where({ ID: 'cp-1' }));
    await db.run(DELETE.from(Missions).where({ ID: 'm-1' }));
  });
});
