// test/lib/completion-rollup-emptyguard.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rollUpParentsForCompletion } from '../../srv/lib/completion-rollup.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('empty-slot guard', () => {
  let db;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    const { Users, Tutorials, Missions, CompletionPaths, CompletionPathItems } = cds.entities(NS);
    await db.run(INSERT.into(Users).entries({ ID: 'u-eg', sapId: 'EG1' }));
    // Mission whose only slot is an INACTIVE tutorial → filters to total 0.
    await db.run(INSERT.into(Tutorials).entries({ ID: 't-dead', legacyId: 6001, slug: 'dead', status: 'INACTIVE' }));
    await db.run(INSERT.into(Missions).entries({ ID: 'm-eg', legacyId: 6500, title: 'Empty' }));
    await db.run(INSERT.into(CompletionPaths).entries({ ID: 'cp-eg', mission_ID: 'm-eg', legacyId: 6600 }));
    await db.run(INSERT.into(CompletionPathItems).entries({ ID: 'cpi-eg', path_ID: 'cp-eg', taskType: 'TUTORIAL', taskLegacyId: 6001, itemOrder: 10 }));
  });
  afterEach(async () => {
    const E = cds.entities(NS);
    await db.run(DELETE.from(E.TaskRecords).where({ user_ID: 'u-eg' }));
    await db.run(DELETE.from(E.CompletionPathItems).where({ path_ID: 'cp-eg' }));
    await db.run(DELETE.from(E.CompletionPaths).where({ ID: 'cp-eg' }));
    await db.run(DELETE.from(E.Missions).where({ ID: 'm-eg' }));
    await db.run(DELETE.from(E.Tutorials).where({ ID: 't-dead' }));
    await db.run(DELETE.from(E.Users).where({ ID: 'u-eg' }));
  });

  it('writes NO mission record when all slots filtered to INACTIVE', async () => {
    // trigger as if the (now-inactive) tutorial completed
    await rollUpParentsForCompletion({ dbUser: { ID: 'u-eg' }, task: { taskType: 'TUTORIAL', taskLegacyId: 6001 }, db, send: false });
    const { TaskRecords } = cds.entities(NS);
    const rows = await db.run(SELECT.from(TaskRecords).where({ user_ID: 'u-eg', taskType: 'MISSION' }));
    expect(rows).toHaveLength(0); // NOT auto-completed
  });
});
