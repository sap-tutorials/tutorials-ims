// test/hybrid/kg-cascade-delete.test.js
// Hybrid test — runs only against real HANA via `cds bind --exec`.
// Consolidated cascade-delete audit for all 7 Phase 4 KG parent entities.
// See docs/superpowers/specs/2026-07-01-789-kg-cascade-delete-audit-design.md.
//
// Fixture ID convention: 00000000-0000-0000-0000-789NNNNNNNNN
// Slug prefix: __test__-789-*
// One describe block per parent; each block is self-contained
// (its own beforeAll/afterAll, its own fixture UUIDs).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

function assertHanaKind(db) {
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    throw new Error(
      'kg-cascade-delete.test.js must run against HANA. ' +
      'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// Row 1: Tutorials → TutorialConceptLinks (#787, moved from PR #792)
// ────────────────────────────────────────────────────────────────────
describe.runIf(isSafeForWrites())('Tutorial DELETE cascades to TutorialConceptLinks', () => {
  const tutorialId = '00000000-0000-0000-0000-789000000001';
  const conceptId  = '00000000-0000-0000-0000-789000000002';
  const linkId     = '00000000-0000-0000-0000-789000000003';

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialConceptLinks).where({ ID: linkId });
    await DELETE.from(Concepts).where({ ID: conceptId });
    await DELETE.from(Tutorials).where({ ID: tutorialId });
  });

  it('deletes TutorialConceptLinks rows when their parent Tutorial is deleted', async () => {
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: '__test__-789-cascade-tut',
      title: '__test__ Cascade Tutorial 789',
    });
    await INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-tut',
      name: '__test__ Cascade Concept (tut)',
      status: 'ACTIVE',
    });
    await INSERT.into(TutorialConceptLinks).entries({
      ID: linkId,
      tutorial_ID: tutorialId,
      concept_ID: conceptId,
      predicate: 'teaches',
    });

    const before = await SELECT.one.from(TutorialConceptLinks).where({ ID: linkId });
    expect(before).toBeDefined();
    expect(before.tutorial_ID).toBe(tutorialId);

    await DELETE.from(Tutorials).where({ ID: tutorialId });

    const orphan = await SELECT.one.from(TutorialConceptLinks).where({ ID: linkId });
    expect(orphan).toBeUndefined();

    const concept = await SELECT.one.from(Concepts).where({ ID: conceptId });
    expect(concept).toBeDefined();
    expect(concept.slug).toBe('__test__-789-cascade-concept-tut');
  });
});
