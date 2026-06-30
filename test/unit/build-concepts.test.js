// test/unit/build-concepts.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /build/concepts', () => {
  beforeEach(async () => {
    const { Tutorials, Concepts, TutorialConceptLinks, ConceptEdges } =
      cds.entities('com.sap.developers.ims');
    // Reset state. Order matters: dependents before parents.
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(ConceptEdges);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);
  });

  it('skips link rows whose tutorial side is null (orphan-row defense)', async () => {
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // Seed: one valid tutorial + one published concept + two TCL rows.
    // The first link is valid; the second references a non-existent tutorial UUID
    // (simulating an orphan row that pre-dated the #787 schema cascade fix).
    const validTutorialId  = '00000000-0000-0000-0000-000000000787';
    const orphanTutorialId = '99999999-9999-9999-9999-999999999787'; // does NOT exist
    const conceptId        = '00000000-0000-0000-0000-000000000c87';
    const validLinkId      = '00000000-0000-0000-0000-000000000l01';
    const orphanLinkId     = '00000000-0000-0000-0000-000000000l02';

    await INSERT.into(Tutorials).entries([
      { ID: validTutorialId, slug: 'valid-tutorial', title: 'Valid Tutorial' },
    ]);
    await INSERT.into(Concepts).entries([
      {
        ID: conceptId,
        slug: 'cap',
        name: 'CAP',
        description: 'Service framework',
        status: 'ACTIVE',
        publishedAt: '2026-06-30T00:00:00.000Z',
      },
    ]);
    await INSERT.into(TutorialConceptLinks).entries([
      // Valid link: tutorial exists, will render in the payload.
      { ID: validLinkId,  tutorial_ID: validTutorialId,  concept_ID: conceptId, predicate: 'teaches' },
      // Orphan link: tutorial_ID points to a deleted-or-never-existed UUID.
      // Without the defensive guard at published-concepts-query.js:64, this
      // row joins to a null tutorial side and crashes .toLowerCase().
      { ID: orphanLinkId, tutorial_ID: orphanTutorialId, concept_ID: conceptId, predicate: 'teaches' },
    ]);

    const { data, status } = await project.axios.get('/build/concepts');
    expect(status).toBe(200);
    expect(data.concepts).toHaveLength(1);

    const cap = data.concepts[0];
    expect(cap.slug).toBe('cap');
    // Only the valid link survives the filter; the orphan is silently skipped.
    expect(cap.teaches).toHaveLength(1);
    expect(cap.teaches[0].slug).toBe('valid-tutorial');
  });
});
