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

// ────────────────────────────────────────────────────────────────────
// Rows 2/3/4: LearningJourneys → LearningJourneyConceptLinks
//                              + LearningJourneyPrerequisites (dual composition + negative)
// ────────────────────────────────────────────────────────────────────
describe.runIf(isSafeForWrites())('LearningJourney DELETE cascades correctly (with deliberate non-cascade on prerequisite side)', () => {
  // Two parent rows (A + B) because Prerequisites references LJ twice.
  const journeyIdA = '00000000-0000-0000-0000-789000000010';
  const journeyIdB = '00000000-0000-0000-0000-789000000011';
  const conceptId  = '00000000-0000-0000-0000-789000000012';
  const linkId     = '00000000-0000-0000-0000-789000000013';  // journey A → concept
  const prereqId1  = '00000000-0000-0000-0000-789000000014';  // A requires B (deleted via A)
  const prereqId2  = '00000000-0000-0000-0000-789000000015';  // A requires B (deleted via B — negative)

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    const {
      LearningJourneys, LearningJourneyConceptLinks, LearningJourneyPrerequisites,
    } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(LearningJourneyConceptLinks).where({ ID: linkId });
    await DELETE.from(LearningJourneyPrerequisites).where({ ID: prereqId1 });
    await DELETE.from(LearningJourneyPrerequisites).where({ ID: prereqId2 });
    await DELETE.from(Concepts).where({ ID: conceptId });
    await DELETE.from(LearningJourneys).where({ ID: journeyIdA });
    await DELETE.from(LearningJourneys).where({ ID: journeyIdB });
  });

  it('deletes LearningJourneyConceptLinks rows when the parent LearningJourney is deleted', async () => {
    const { LearningJourneys, LearningJourneyConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await INSERT.into(LearningJourneys).entries({
      ID: journeyIdA,
      slug: '__test__-789-lj-a',
      title: '__test__ Journey A',
    });
    await INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-lj',
      name: '__test__ Cascade Concept (lj)',
      status: 'ACTIVE',
    });
    await INSERT.into(LearningJourneyConceptLinks).entries({
      ID: linkId,
      journey_ID: journeyIdA,
      concept_ID: conceptId,
      predicate: 'covers',
    });

    await DELETE.from(LearningJourneys).where({ ID: journeyIdA });

    const orphan = await SELECT.one.from(LearningJourneyConceptLinks).where({ ID: linkId });
    expect(orphan).toBeUndefined();

    const concept = await SELECT.one.from(Concepts).where({ ID: conceptId });
    expect(concept).toBeDefined();
  });

  it('deletes LearningJourneyPrerequisites rows when the journey-side parent is deleted', async () => {
    const { LearningJourneys, LearningJourneyPrerequisites } =
      cds.entities('com.sap.developers.ims.external');

    // Fresh A + B (previous test deleted A).
    await INSERT.into(LearningJourneys).entries([
      { ID: journeyIdA, slug: '__test__-789-lj-a', title: '__test__ Journey A' },
      { ID: journeyIdB, slug: '__test__-789-lj-b', title: '__test__ Journey B' },
    ]);
    await INSERT.into(LearningJourneyPrerequisites).entries({
      ID: prereqId1,
      journey_ID: journeyIdA,
      prerequisite_ID: journeyIdB,
    });

    // Delete A (the composition parent). Cascade should fire.
    await DELETE.from(LearningJourneys).where({ ID: journeyIdA });

    const orphan = await SELECT.one.from(LearningJourneyPrerequisites).where({ ID: prereqId1 });
    expect(orphan).toBeUndefined();

    // B survives (it's on the non-composition prerequisite side).
    const survivorB = await SELECT.one.from(LearningJourneys).where({ ID: journeyIdB });
    expect(survivorB).toBeDefined();
    expect(survivorB.slug).toBe('__test__-789-lj-b');
  });

  it('does NOT cascade LearningJourneyPrerequisites when the prerequisite-side parent is deleted (documents GC-sweep asymmetry)', async () => {
    // This is the LOAD-BEARING NEGATIVE TEST for the audit.
    // Cascade fires on `journey` (composition), NOT on `prerequisite` (association).
    // Dangling-prereq rows are cleaned up by the GC sweep, NOT by DELETE cascade.
    // See db/external-content.cds:36-40 for the schema comment documenting this.
    // If a future PR "simplifies" LearningJourneyPrerequisites by adding a
    // Composition on the `prerequisite` side, this test will fail loudly.
    const { LearningJourneys, LearningJourneyPrerequisites } =
      cds.entities('com.sap.developers.ims.external');

    // Re-insert A; B still exists from previous test's survivor assertion.
    await INSERT.into(LearningJourneys).entries({
      ID: journeyIdA, slug: '__test__-789-lj-a', title: '__test__ Journey A',
    });
    await INSERT.into(LearningJourneyPrerequisites).entries({
      ID: prereqId2,
      journey_ID: journeyIdA,
      prerequisite_ID: journeyIdB,
    });

    // Delete B (the prerequisite side, NOT the journey side).
    await DELETE.from(LearningJourneys).where({ ID: journeyIdB });

    // Assert the prereq row SURVIVES — no cascade on this side.
    const stillThere = await SELECT.one.from(LearningJourneyPrerequisites).where({ ID: prereqId2 });
    expect(stillThere).toBeDefined();
    expect(stillThere.journey_ID).toBe(journeyIdA);
    expect(stillThere.prerequisite_ID).toBe(journeyIdB);

    // Assert A (the composition-side parent) SURVIVES — we deleted B, not A.
    const survivorA = await SELECT.one.from(LearningJourneys).where({ ID: journeyIdA });
    expect(survivorA).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Row 5: BlogPosts → BlogPostConceptLinks
// ────────────────────────────────────────────────────────────────────
describe.runIf(isSafeForWrites())('BlogPost DELETE cascades to BlogPostConceptLinks', () => {
  const postId    = '00000000-0000-0000-0000-789000000020';
  const conceptId = '00000000-0000-0000-0000-789000000021';
  const linkId    = '00000000-0000-0000-0000-789000000022';

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    const { BlogPosts, BlogPostConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BlogPostConceptLinks).where({ ID: linkId });
    await DELETE.from(Concepts).where({ ID: conceptId });
    await DELETE.from(BlogPosts).where({ ID: postId });
  });

  it('deletes BlogPostConceptLinks rows when the parent BlogPost is deleted', async () => {
    const { BlogPosts, BlogPostConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await INSERT.into(BlogPosts).entries({
      ID: postId,
      slug: '__test__-789-bp',
      title: '__test__ Blog Post 789',
    });
    await INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-bp',
      name: '__test__ Cascade Concept (bp)',
      status: 'ACTIVE',
    });
    await INSERT.into(BlogPostConceptLinks).entries({
      ID: linkId,
      post_ID: postId,
      concept_ID: conceptId,
      predicate: 'discusses',
    });

    await DELETE.from(BlogPosts).where({ ID: postId });

    const orphan = await SELECT.one.from(BlogPostConceptLinks).where({ ID: linkId });
    expect(orphan).toBeUndefined();
    const concept = await SELECT.one.from(Concepts).where({ ID: conceptId });
    expect(concept).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Rows 6/7: DiscoveryMissions → DiscoveryMissionConceptLinks + DiscoveryMissionServices
// ────────────────────────────────────────────────────────────────────
describe.runIf(isSafeForWrites())('DiscoveryMission DELETE cascades to concept-links AND services', () => {
  const missionId = '00000000-0000-0000-0000-789000000030';
  const conceptId = '00000000-0000-0000-0000-789000000031';
  const linkId    = '00000000-0000-0000-0000-789000000032';
  const serviceId = '00000000-0000-0000-0000-789000000033';

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    const {
      DiscoveryMissions, DiscoveryMissionConceptLinks, DiscoveryMissionServices,
    } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(DiscoveryMissionConceptLinks).where({ ID: linkId });
    await DELETE.from(DiscoveryMissionServices).where({ ID: serviceId });
    await DELETE.from(Concepts).where({ ID: conceptId });
    await DELETE.from(DiscoveryMissions).where({ ID: missionId });
  });

  it('deletes DiscoveryMissionConceptLinks rows when the parent DiscoveryMission is deleted', async () => {
    const { DiscoveryMissions, DiscoveryMissionConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await INSERT.into(DiscoveryMissions).entries({
      ID: missionId,
      slug: '__test__-789-dm',
      title: '__test__ Discovery Mission 789',
    });
    await INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-dm',
      name: '__test__ Cascade Concept (dm)',
      status: 'ACTIVE',
    });
    await INSERT.into(DiscoveryMissionConceptLinks).entries({
      ID: linkId,
      mission_ID: missionId,
      concept_ID: conceptId,
      predicate: 'teaches',
    });

    await DELETE.from(DiscoveryMissions).where({ ID: missionId });

    const orphan = await SELECT.one.from(DiscoveryMissionConceptLinks).where({ ID: linkId });
    expect(orphan).toBeUndefined();
    const concept = await SELECT.one.from(Concepts).where({ ID: conceptId });
    expect(concept).toBeDefined();
  });

  it('deletes DiscoveryMissionServices rows when the parent DiscoveryMission is deleted', async () => {
    // Secondary composition — free-form service names, no concept side.
    const { DiscoveryMissions, DiscoveryMissionServices } =
      cds.entities('com.sap.developers.ims.external');

    // Re-INSERT the mission (first `it` deleted it via cascade).
    await INSERT.into(DiscoveryMissions).entries({
      ID: missionId,
      slug: '__test__-789-dm',
      title: '__test__ Discovery Mission 789',
    });
    await INSERT.into(DiscoveryMissionServices).entries({
      ID: serviceId,
      mission_ID: missionId,
      serviceName: '__test__-789-btp-service',
    });

    await DELETE.from(DiscoveryMissions).where({ ID: missionId });

    const orphan = await SELECT.one.from(DiscoveryMissionServices).where({ ID: serviceId });
    expect(orphan).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Rows 8/9: Videos → VideoConceptLinks + VideoServices
// NOTE: Videos.description is LargeString (NCLOB). Never SELECT it
// alongside scalar metadata via CDS QL on HANA — LOB locators expire
// (see db/external-content.cds LOB-locator note).
// ────────────────────────────────────────────────────────────────────
describe.runIf(isSafeForWrites())('Video DELETE cascades to concept-links AND services', () => {
  const videoId   = '00000000-0000-0000-0000-789000000040';
  const conceptId = '00000000-0000-0000-0000-789000000041';
  const linkId    = '00000000-0000-0000-0000-789000000042';
  const serviceId = '00000000-0000-0000-0000-789000000043';

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    const {
      Videos, VideoConceptLinks, VideoServices,
    } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(VideoConceptLinks).where({ ID: linkId });
    await DELETE.from(VideoServices).where({ ID: serviceId });
    await DELETE.from(Concepts).where({ ID: conceptId });
    await DELETE.from(Videos).where({ ID: videoId });
  });

  it('deletes VideoConceptLinks rows when the parent Video is deleted', async () => {
    const { Videos, VideoConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Videos).entries({
      ID: videoId,
      slug: '__test__-789-vd',
      title: '__test__ Video 789',
    });
    await INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-vd',
      name: '__test__ Cascade Concept (vd)',
      status: 'ACTIVE',
    });
    await INSERT.into(VideoConceptLinks).entries({
      ID: linkId,
      video_ID: videoId,
      concept_ID: conceptId,
      predicate: 'teaches',
    });

    await DELETE.from(Videos).where({ ID: videoId });

    const orphan = await SELECT.one.from(VideoConceptLinks).where({ ID: linkId });
    expect(orphan).toBeUndefined();
    const concept = await SELECT.one.from(Concepts).where({ ID: conceptId });
    expect(concept).toBeDefined();
  });

  it('deletes VideoServices rows when the parent Video is deleted', async () => {
    const { Videos, VideoServices } =
      cds.entities('com.sap.developers.ims.external');

    // Re-INSERT the video (first `it` deleted it via cascade).
    await INSERT.into(Videos).entries({
      ID: videoId,
      slug: '__test__-789-vd',
      title: '__test__ Video 789',
    });
    await INSERT.into(VideoServices).entries({
      ID: serviceId,
      video_ID: videoId,
      serviceName: '__test__-789-btp-service',
    });

    await DELETE.from(Videos).where({ ID: videoId });

    const orphan = await SELECT.one.from(VideoServices).where({ ID: serviceId });
    expect(orphan).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Row 10: ApiDocs → ApiDocConceptLinks
// NOTE: ApiDocs.description is LargeString (NCLOB). Never SELECT it
// alongside scalar metadata (LOB-locator gotcha).
// ────────────────────────────────────────────────────────────────────
describe.runIf(isSafeForWrites())('ApiDoc DELETE cascades to ApiDocConceptLinks', () => {
  const apiDocId  = '00000000-0000-0000-0000-789000000050';
  const conceptId = '00000000-0000-0000-0000-789000000051';
  const linkId    = '00000000-0000-0000-0000-789000000052';

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    const { ApiDocs, ApiDocConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ApiDocConceptLinks).where({ ID: linkId });
    await DELETE.from(Concepts).where({ ID: conceptId });
    await DELETE.from(ApiDocs).where({ ID: apiDocId });
  });

  it('deletes ApiDocConceptLinks rows when the parent ApiDoc is deleted', async () => {
    const { ApiDocs, ApiDocConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await INSERT.into(ApiDocs).entries({
      ID: apiDocId,
      slug: '__test__-789-ad',
      title: '__test__ ApiDoc 789',
    });
    await INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-ad',
      name: '__test__ Cascade Concept (ad)',
      status: 'ACTIVE',
    });
    await INSERT.into(ApiDocConceptLinks).entries({
      ID: linkId,
      apiDoc_ID: apiDocId,
      concept_ID: conceptId,
      predicate: 'officialReferenceFor',
    });

    await DELETE.from(ApiDocs).where({ ID: apiDocId });

    const orphan = await SELECT.one.from(ApiDocConceptLinks).where({ ID: linkId });
    expect(orphan).toBeUndefined();
    const concept = await SELECT.one.from(Concepts).where({ ID: conceptId });
    expect(concept).toBeDefined();
  });
});
