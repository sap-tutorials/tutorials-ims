// test/unit/kg-retire-orphans-job.test.js
// #1115: nightly retirement of truly-orphaned concepts.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { runRetireOrphans, readAgeDays, isEnabled } from '../../srv/jobs/kg-retire-orphans-job.js';

const NS = 'com.sap.developers.ims';

function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('runRetireOrphans (#1115)', () => {
  beforeAll(async () => { await cds.deploy(cds.env.roots).to('sqlite::memory:'); });

  beforeEach(async () => {
    const { Concepts, TutorialConceptLinks, ConceptEdges } = cds.entities(NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(ConceptEdges);
    await DELETE.from(Concepts);
    delete process.env.KG_RETIRE_ORPHANS_ENABLED;
    delete process.env.KG_RETIRE_ORPHANS_AGE_DAYS;
  });

  it('retires an ACTIVE, old, zero-link concept', async () => {
    const { Concepts } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000001', slug: 'orphan', name: 'Orphan',
      status: 'ACTIVE', publishedAt: daysAgoIso(20), firstSeenAt: daysAgoIso(20),
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(1);
    const [c] = await SELECT.from(Concepts).where({ ID: 'o0000000-0000-0000-0000-000000000001' });
    expect(c.status).toBe('RETIRED');
  });

  it('does NOT retire a concept younger than the age threshold', async () => {
    const { Concepts } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000002', slug: 'young', name: 'Young',
      status: 'ACTIVE', firstSeenAt: daysAgoIso(5),
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(0);
    const [c] = await SELECT.from(Concepts).where({ ID: 'o0000000-0000-0000-0000-000000000002' });
    expect(c.status).toBe('ACTIVE');
  });

  it('does NOT retire a concept with a teaches link', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000003', slug: 'linked', name: 'Linked',
      status: 'ACTIVE', firstSeenAt: daysAgoIso(20),
    });
    await INSERT.into(Tutorials).entries({ ID: 't1', slug: 'tut1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(TutorialConceptLinks).entries({
      ID: 'l1', tutorial_ID: 't1', concept_ID: 'o0000000-0000-0000-0000-000000000003', predicate: 'teaches',
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(0);
  });

  it('does NOT retire a concept with an ACTIVE concept-edge (as source or target)', async () => {
    const { Concepts, ConceptEdges } = cds.entities(NS);
    await INSERT.into(Concepts).entries([
      { ID: 'src', slug: 'src-c', name: 'Src', status: 'ACTIVE', firstSeenAt: daysAgoIso(20) },
      { ID: 'tgt', slug: 'tgt-c', name: 'Tgt', status: 'ACTIVE', firstSeenAt: daysAgoIso(20) },
    ]);
    await INSERT.into(ConceptEdges).entries({
      ID: 'edge1', source_ID: 'src', target_ID: 'tgt', predicate: 'requires', status: 'ACTIVE',
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(0);
  });

  it('honors KG_RETIRE_ORPHANS_ENABLED=false', async () => {
    const { Concepts } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000009', slug: 'skip', name: 'Skip',
      status: 'ACTIVE', firstSeenAt: daysAgoIso(20),
    });
    process.env.KG_RETIRE_ORPHANS_ENABLED = 'false';
    const res = await runRetireOrphans();
    expect(res.reason).toBe('disabled');
    expect(res.retired).toBe(0);
  });
});

describe('readAgeDays guard (#1115)', () => {
  afterEach(() => { delete process.env.KG_RETIRE_ORPHANS_AGE_DAYS; });
  it('falls back to 14 when the env value is 0 (would otherwise retire everything)', () => {
    process.env.KG_RETIRE_ORPHANS_AGE_DAYS = '0';
    expect(readAgeDays()).toBe(14);
  });
  it('honors a positive override', () => {
    process.env.KG_RETIRE_ORPHANS_AGE_DAYS = '30';
    expect(readAgeDays()).toBe(30);
  });
});
