// test/unit/srv/gc-external-content-cascade.test.js
//
// Regression guard for the cascade-delete invariant in
// srv/jobs/gc-external-content-job.js (#447 Task 1 review fix).
//
// Bug: PR-1's initial GC implementation issued DELETE on stale
// LearningJourneys rows but Associations (vs Compositions) don't cascade —
// so LearningJourneyConceptLinks and LearningJourneyPrerequisites rows
// pointing at the deleted journey were left dangling with FK refs to a
// nonexistent parent.
//
// Fix:
//   1. db/external-content.cds — flip the journey-side Associations to
//      Compositions of LearningJourneyConceptLinks + LearningJourneyPrerequisites.
//   2. srv/jobs/gc-external-content-job.js — explicit sweep of dangling
//      sibling Associations (LearningJourneyPrerequisites.prerequisite)
//      BEFORE the parent DELETE.
//
// This test exercises BOTH paths.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { runGcExternalContent } from '../../../srv/jobs/gc-external-content-job.js';

cds.test('serve', '--project', '.', '--in-memory');

const NAMESPACE = 'com.sap.developers.ims.external';

// learning-journey TTL = 365 days; GC cutoff is lastSeenAt + 2*TTL → past
// today, so we need a lastSeenAt that's > 730 days old to be eligible.
const STALE_DATE = new Date(Date.now() - 800 * 24 * 60 * 60 * 1000).toISOString();
const FRESH_DATE = new Date().toISOString();

const STALE_ID         = '11111111-1111-1111-1111-111111111111';
const FRESH_ID         = '22222222-2222-2222-2222-222222222222';
const REFERENCING_ID   = '33333333-3333-3333-3333-333333333333';
const CONCEPT_ID       = '44444444-4444-4444-4444-444444444444';
const LINK_ID          = '55555555-5555-5555-5555-555555555555';
const PREREQ_JOURNEY_SIDE = '66666666-6666-6666-6666-666666666666';
const PREREQ_PREREQ_SIDE  = '77777777-7777-7777-7777-777777777777';

describe('gc-external-content — cascade-delete invariant', () => {
  let db;
  let LearningJourneys;
  let LearningJourneyConceptLinks;
  let LearningJourneyPrerequisites;
  let Concepts;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const ents = cds.entities(NAMESPACE);
    LearningJourneys = ents.LearningJourneys;
    LearningJourneyConceptLinks = ents.LearningJourneyConceptLinks;
    LearningJourneyPrerequisites = ents.LearningJourneyPrerequisites;
    Concepts = cds.entities('com.sap.developers.ims').Concepts;
  });

  beforeEach(async () => {
    // Reset state — order matters (children before parents to satisfy FKs).
    await db.run(DELETE.from(LearningJourneyConceptLinks));
    await db.run(DELETE.from(LearningJourneyPrerequisites));
    await db.run(DELETE.from(LearningJourneys));
    await db.run(DELETE.from(Concepts).where({ ID: CONCEPT_ID }));

    // Seed a concept for the link-row FK.
    await db.run(INSERT.into(Concepts).entries([{
      ID: CONCEPT_ID,
      slug: 'kg-test-concept-cascade',
      name: 'Test Concept',
      status: 'ACTIVE',
      extractionCount: 1,
    }]));
  });

  it('cascade-deletes journey-side link rows when a journey is GC-eligible', async () => {
    // 1. Insert a stale journey + a link row.
    await db.run(INSERT.into(LearningJourneys).entries([{
      ID: STALE_ID, slug: 'stale-journey', title: 'Stale', lastSeenAt: STALE_DATE,
    }]));
    await db.run(INSERT.into(LearningJourneyConceptLinks).entries([{
      ID: LINK_ID, journey_ID: STALE_ID, concept_ID: CONCEPT_ID,
      predicate: 'covers', confidence: 0.9,
    }]));

    // 2. Run the GC.
    await runGcExternalContent();

    // 3. The journey AND its link rows should both be gone.
    const remaining = await SELECT.from(LearningJourneys).where({ ID: STALE_ID });
    expect(remaining).toHaveLength(0);
    const links = await SELECT.from(LearningJourneyConceptLinks).where({ journey_ID: STALE_ID });
    expect(links).toHaveLength(0);
  });

  it('cascade-deletes journey-side prereq rows when a journey is GC-eligible', async () => {
    // Insert a stale journey + another fresh journey referenced as prereq.
    await db.run(INSERT.into(LearningJourneys).entries([
      { ID: STALE_ID, slug: 'stale-journey', title: 'Stale', lastSeenAt: STALE_DATE },
      { ID: FRESH_ID, slug: 'fresh-journey', title: 'Fresh', lastSeenAt: FRESH_DATE },
    ]));
    await db.run(INSERT.into(LearningJourneyPrerequisites).entries([{
      ID: PREREQ_JOURNEY_SIDE, journey_ID: STALE_ID, prerequisite_ID: FRESH_ID,
      reason: 'test', confidence: 0.8,
    }]));

    await runGcExternalContent();

    // The stale journey is gone; the prereq row referencing it from the
    // journey side is gone (composition cascade); the fresh journey survives.
    const staleSurvives = await SELECT.from(LearningJourneys).where({ ID: STALE_ID });
    expect(staleSurvives).toHaveLength(0);
    const freshSurvives = await SELECT.from(LearningJourneys).where({ ID: FRESH_ID });
    expect(freshSurvives).toHaveLength(1);
    const prereqs = await SELECT.from(LearningJourneyPrerequisites).where({ journey_ID: STALE_ID });
    expect(prereqs).toHaveLength(0);
  });

  it('sweeps dangling prereq-side references to a GC-eligible journey', async () => {
    // Insert a stale journey + another fresh journey that references the
    // stale one as a prerequisite (FK pointing the OTHER way — sibling Assoc).
    await db.run(INSERT.into(LearningJourneys).entries([
      { ID: STALE_ID,       slug: 'stale-journey',     title: 'Stale', lastSeenAt: STALE_DATE },
      { ID: REFERENCING_ID, slug: 'referencing-journey', title: 'Refs', lastSeenAt: FRESH_DATE },
    ]));
    await db.run(INSERT.into(LearningJourneyPrerequisites).entries([{
      ID: PREREQ_PREREQ_SIDE,
      journey_ID: REFERENCING_ID,
      prerequisite_ID: STALE_ID,
      reason: 'depends-on-stale', confidence: 0.7,
    }]));

    await runGcExternalContent();

    // The stale journey is gone; the OTHER (fresh) journey is intact; the
    // dangling prereq edge pointing at the deleted journey has been swept.
    const staleSurvives = await SELECT.from(LearningJourneys).where({ ID: STALE_ID });
    expect(staleSurvives).toHaveLength(0);
    const refsSurvives = await SELECT.from(LearningJourneys).where({ ID: REFERENCING_ID });
    expect(refsSurvives).toHaveLength(1);
    const dangling = await SELECT.from(LearningJourneyPrerequisites)
      .where({ prerequisite_ID: STALE_ID });
    expect(dangling).toHaveLength(0);
  });

  it('does NOT delete fresh rows or their dependent links', async () => {
    await db.run(INSERT.into(LearningJourneys).entries([{
      ID: FRESH_ID, slug: 'fresh-journey', title: 'Fresh', lastSeenAt: FRESH_DATE,
    }]));
    await db.run(INSERT.into(LearningJourneyConceptLinks).entries([{
      ID: LINK_ID, journey_ID: FRESH_ID, concept_ID: CONCEPT_ID,
      predicate: 'covers', confidence: 0.9,
    }]));

    await runGcExternalContent();

    const survives = await SELECT.from(LearningJourneys).where({ ID: FRESH_ID });
    expect(survives).toHaveLength(1);
    const links = await SELECT.from(LearningJourneyConceptLinks).where({ journey_ID: FRESH_ID });
    expect(links).toHaveLength(1);
  });
});
