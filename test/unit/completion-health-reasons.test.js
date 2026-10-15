// test/unit/completion-health-reasons.test.js
//
// #2787 — extended reasons for findUnhealthyEntities: 'deleted' and 'not-served'.
//
// Seeds mirror test/lib/completion-reconcile.test.js:
//   - cds.test(cds.root) at module level
//   - beforeEach / afterEach for setup / teardown
//   - INSERT.into(E.*) via CQL globals

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { findUnhealthyEntities } from '../../srv/lib/completion-reconcile.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('findUnhealthyEntities extended reasons', () => {
  let db;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    const E = cds.entities(NS);

    // --- Scenario 1: published Group whose single child has status DELETED ---
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 't-del', legacyId: 6001, slug: 'tut-deleted', status: 'DELETED' },
    ));
    await db.run(INSERT.into(E.Groups).entries(
      { ID: 'g-del', legacyId: 6100, title: 'G-Del', slug: 'grp-deleted-child', published: true },
    ));
    await db.run(INSERT.into(E.GroupPathItems).entries(
      { ID: 'gpi-del', group_ID: 'g-del', tutorial_ID: 't-del', itemOrder: 10 },
    ));

    // --- Scenario 2: published Group with one ACTIVE child served + one ACTIVE unserved ---
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 't-srv',  legacyId: 6002, slug: 'tut-served',   status: 'ACTIVE' },
      { ID: 't-nosrv', legacyId: 6003, slug: 'tut-unserved', status: 'ACTIVE' },
    ));
    await db.run(INSERT.into(E.Groups).entries(
      { ID: 'g-nosrv', legacyId: 6200, title: 'G-NoSrv', slug: 'grp-unserved-child', published: true },
    ));
    await db.run(INSERT.into(E.GroupPathItems).entries(
      { ID: 'gpi-srv',   group_ID: 'g-nosrv', tutorial_ID: 't-srv',   itemOrder: 10 },
      { ID: 'gpi-nosrv', group_ID: 'g-nosrv', tutorial_ID: 't-nosrv', itemOrder: 20 },
    ));
    // Only the served tutorial has a ContentCurrent row; the unserved one has none.
    await db.run(INSERT.into(E.ContentCurrent).entries(
      { slug: 'tut-served' },
    ));
  });

  afterEach(async () => {
    const E = cds.entities(NS);
    await db.run(DELETE.from(E.GroupPathItems).where({ ID: { in: ['gpi-del', 'gpi-srv', 'gpi-nosrv'] } }));
    await db.run(DELETE.from(E.Groups).where({ ID: { in: ['g-del', 'g-nosrv'] } }));
    await db.run(DELETE.from(E.Tutorials).where({ ID: { in: ['t-del', 't-srv', 't-nosrv'] } }));
    await db.run(DELETE.from(E.ContentCurrent).where({ slug: 'tut-served' }));
  });

  it('flags a DELETED child as reason "deleted" (not "inactive")', async () => {
    const out = await findUnhealthyEntities(db);
    const g = out.find(e => e.kind === 'GROUP' && e.slug === 'grp-deleted-child');
    expect(g).toBeDefined();
    expect(g.badSlots.some(s => s.reason === 'deleted')).toBe(true);
    expect(g.badSlots.some(s => s.reason === 'inactive')).toBe(false);
  });

  it('flags an ACTIVE published child with no ContentCurrent row as "not-served"', async () => {
    const out = await findUnhealthyEntities(db);
    const g = out.find(e => e.kind === 'GROUP' && e.slug === 'grp-unserved-child');
    expect(g).toBeDefined();
    expect(g.badSlots.some(s => s.reason === 'not-served')).toBe(true);
  });

  it('does NOT flag the ACTIVE served child as "not-served"', async () => {
    const out = await findUnhealthyEntities(db);
    const g = out.find(e => e.kind === 'GROUP' && e.slug === 'grp-unserved-child');
    expect(g).toBeDefined();
    // badSlots should contain 'not-served' for tut-unserved (legacyId 6003), not tut-served
    const notServedSlots = g.badSlots.filter(s => s.reason === 'not-served');
    expect(notServedSlots.every(s => s.taskLegacyId !== 6002)).toBe(true);
  });
});
