// test/hybrid/kg-tutorial-conceptlinks-cascade.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid test — runs only against real HANA via `cds bind --exec`.
// Confirms the Composition cascade declared on Tutorials.conceptLinks
// (db/knowledge-graph.cds via `extend entity base.Tutorials`, #787)
// actually fires when a Tutorial is DELETEd.

describe('Tutorial DELETE cascades to TutorialConceptLinks (#787)', () => {
  let db;

  // `__test__` prefix per the write-safety convention enforced by
  // test/hybrid/_guard.js. Cleanup runs in afterAll.
  const tutorialId = '00000000-0000-0000-0000-787000000001';
  const conceptId  = '00000000-0000-0000-0000-787000000002';
  const linkId     = '00000000-0000-0000-0000-787000000003';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-tutorial-conceptlinks-cascade.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  afterAll(async () => {
    if (!db) return;
    // Defense-in-depth cleanup. The test itself deletes the Tutorial
    // (triggering the cascade), so the Link should already be gone.
    // The Concept survives the cascade — clean it explicitly. The
    // Tutorial cleanup is idempotent (no-op if the test ran successfully).
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(TutorialConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(Tutorials).where({ ID: tutorialId }));
  });

  it('deletes TutorialConceptLinks rows when their parent Tutorial is deleted', async () => {
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // Setup: insert one tutorial + one concept + one link between them.
    await db.run(INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: '__test__-787-cascade',
      title: '__test__ Cascade Tutorial 787',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-cascade-concept-787',
      name: '__test__ Cascade Concept 787',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(TutorialConceptLinks).entries({
      ID: linkId,
      tutorial_ID: tutorialId,
      concept_ID: conceptId,
      predicate: 'teaches',
    }));

    // Sanity: confirm the row exists.
    const before = await db.run(SELECT.one.from(TutorialConceptLinks).where({ ID: linkId }));
    expect(before).toBeDefined();
    expect(before.tutorial_ID).toBe(tutorialId);

    // Act: delete the parent Tutorial. The Composition declaration should
    // cause CAP to cascade-delete the TutorialConceptLinks row.
    await db.run(DELETE.from(Tutorials).where({ ID: tutorialId }));

    // Assert: link row is gone (cascade fired).
    const orphan = await db.run(SELECT.one.from(TutorialConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();

    // Assert: Concept survives (it's composed by Concept itself, not Tutorial).
    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
    expect(concept.slug).toBe('__test__-cascade-concept-787');
  });
});
