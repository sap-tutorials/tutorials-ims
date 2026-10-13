// test/lib/completion-reconcile-all.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reconcileAll } from '../../srv/lib/completion-reconcile.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('reconcileAll', () => {
  it('sweeps published entities and returns accumulated counts (idempotent)', async () => {
    const db = await cds.connect.to('db');
    const E = cds.entities(NS);
    await db.run(INSERT.into(E.Users).entries({ ID: 'u-ra', sapId: 'RA1' }));
    await db.run(INSERT.into(E.Tutorials).entries({ ID: 't-ra', legacyId: 4001, slug: 'ra', status: 'ACTIVE' }));
    await db.run(INSERT.into(E.Groups).entries({ ID: 'g-ra', legacyId: 4500, title: 'RA', published: true }));
    await db.run(INSERT.into(E.GroupPathItems).entries({ ID: 'gi-ra', group_ID: 'g-ra', tutorial_ID: 't-ra', itemOrder: 10 }));
    await db.run(INSERT.into(E.TaskRecords).entries({ ID: 'tr-ra', user_ID: 'u-ra', taskLegacyId: 4001, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 440001, attemptNumber: 1 }));

    const r1 = await reconcileAll({ db });
    expect(r1.completed).toBeGreaterThan(0);
    const [grp] = await db.run(SELECT.from(E.TaskRecords).where({ user_ID: 'u-ra', taskType: 'GROUP' }));
    expect(grp.status).toBe('COMPLETED');

    const countBefore = (await db.run(SELECT.from(E.TaskRecords).where({ user_ID: 'u-ra', taskType: 'GROUP' }))).length;
    await reconcileAll({ db });
    const countAfter = (await db.run(SELECT.from(E.TaskRecords).where({ user_ID: 'u-ra', taskType: 'GROUP' }))).length;
    expect(countAfter).toBe(countBefore); // no duplicate rows
  });
});
