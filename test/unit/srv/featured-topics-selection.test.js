import { describe, it, expect } from 'vitest';
import { selectFeaturedTopics } from '../../../srv/lib/featured-topics-selection.js';

const NOW = new Date('2026-07-06T00:00:00Z');

function ranks(slugs) {
  return slugs.map((s, i) => ({ tutorialSlug: s, score: 100 - i }));
}

describe('selectFeaturedTopics', () => {
  it('places editorial first, KG fills the rest respecting community diversity', () => {
    const editorial = [
      { conceptId: 'e1', conceptSlug: 'cap', conceptName: 'CAP', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'CAP Framework', sortOrder: 10, validFrom: null, validUntil: null, missionSlugs: null, isActive: true, createdAt: NOW },
    ];
    const kgCandidates = [
      { conceptSlug: 'hana',      conceptName: 'HANA',      conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.9 },
      { conceptSlug: 'hana-perf', conceptName: 'HANA Perf', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.8 },
      { conceptSlug: 'abap',      conceptName: 'ABAP',      conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.7 },
    ];
    const communityByConcept = new Map([
      ['cap', 'c-cap'],
      ['hana', 'c-hana'],
      ['hana-perf', 'c-hana'],   // same community as hana — should be skipped
      ['abap', 'c-abap'],
    ]);
    const tutorialRanksByConcept = new Map([
      ['cap',  ranks(['cap-t1','cap-t2','cap-t3','cap-t4','cap-t5'])],
      ['hana', ranks(['h-t1','h-t2','h-t3','h-t4'])],
      ['abap', ranks(['a-t1','a-t2','a-t3','a-t4'])],
    ]);
    const tutorialsBySlug = new Set(['cap-t1','cap-t2','cap-t3','cap-t4','cap-t5','h-t1','h-t2','h-t3','h-t4','a-t1','a-t2','a-t3','a-t4']);

    const out = selectFeaturedTopics({ editorial, kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug, targetCount: 3, missionsPerSlide: 4, now: NOW });

    expect(out.map(s => s.conceptSlug)).toEqual(['cap', 'hana', 'abap']);
    expect(out[0].source).toBe('EDITORIAL');
    expect(out[1].source).toBe('KG');
    expect(out[0].displayTitle).toBe('CAP Framework');
    expect(out[0].missionSlugs).toEqual(['cap-t1','cap-t2','cap-t3','cap-t4']);
  });

  it('breaks sortOrder ties by createdAt ASC', () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    const editorial = [
      { conceptId: 'e2', conceptSlug: 'b', conceptName: 'B', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'B', sortOrder: 50, validFrom: null, validUntil: null, missionSlugs: null, isActive: true, createdAt: newer },
      { conceptId: 'e1', conceptSlug: 'a', conceptName: 'A', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'A', sortOrder: 50, validFrom: null, validUntil: null, missionSlugs: null, isActive: true, createdAt: older },
    ];
    const tutorialRanksByConcept = new Map([
      ['a', [{ tutorialSlug: 'a1', score: 1 }]],
      ['b', [{ tutorialSlug: 'b1', score: 1 }]],
    ]);
    const tutorialsBySlug = new Set(['a1', 'b1']);
    const out = selectFeaturedTopics({ editorial, kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out.map(s => s.conceptSlug)).toEqual(['a', 'b']);
  });

  it('honors editorial missionSlugs override when all slugs are active', () => {
    const editorial = [
      { conceptId: 'e1', conceptSlug: 'cap', conceptName: 'CAP', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: null, sortOrder: 10, validFrom: null, validUntil: null, missionSlugs: ['cap-t5','cap-t3'], isActive: true, createdAt: NOW },
    ];
    const tutorialRanksByConcept = new Map([['cap', ranks(['cap-t1','cap-t2'])]]);
    const tutorialsBySlug = new Set(['cap-t5','cap-t3','cap-t1','cap-t2']);
    const out = selectFeaturedTopics({ editorial, kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].missionSlugs).toEqual(['cap-t5','cap-t3']);
  });

  it('falls back to TutorialRank when editorial missionSlugs has any inactive slug', () => {
    const editorial = [
      { conceptId: 'e1', conceptSlug: 'cap', conceptName: 'CAP', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: null, sortOrder: 10, validFrom: null, validUntil: null, missionSlugs: ['cap-t5','gone'], isActive: true, createdAt: NOW },
    ];
    const tutorialRanksByConcept = new Map([['cap', ranks(['cap-t1','cap-t2','cap-t3','cap-t4'])]]);
    const tutorialsBySlug = new Set(['cap-t5','cap-t1','cap-t2','cap-t3','cap-t4']);
    const out = selectFeaturedTopics({ editorial, kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].missionSlugs).toEqual(['cap-t1','cap-t2','cap-t3','cap-t4']);
  });

  it('filters editorial by validity window and isActive', () => {
    const past = new Date('2026-01-01T00:00:00Z');
    const future = new Date('2027-01-01T00:00:00Z');
    const editorial = [
      { conceptId: 'e-inactive', conceptSlug: 'a', conceptName: 'A', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'A', sortOrder: 1, validFrom: null, validUntil: null, missionSlugs: null, isActive: false, createdAt: NOW },
      { conceptId: 'e-expired',  conceptSlug: 'b', conceptName: 'B', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'B', sortOrder: 2, validFrom: past, validUntil: past, missionSlugs: null, isActive: true, createdAt: NOW },
      { conceptId: 'e-future',   conceptSlug: 'c', conceptName: 'C', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'C', sortOrder: 3, validFrom: future, validUntil: null, missionSlugs: null, isActive: true, createdAt: NOW },
      { conceptId: 'e-ok',       conceptSlug: 'd', conceptName: 'D', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, displayTitle: 'D', sortOrder: 4, validFrom: null,   validUntil: null, missionSlugs: null, isActive: true, createdAt: NOW },
    ];
    const tutorialRanksByConcept = new Map([['d', ranks(['dt1','dt2','dt3','dt4'])]]);
    const tutorialsBySlug = new Set(['dt1','dt2','dt3','dt4']);
    const out = selectFeaturedTopics({ editorial, kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out.map(s => s.conceptSlug)).toEqual(['d']);
  });

  it('skips unpublished/vetoed concepts from KG candidates', () => {
    const kgCandidates = [
      { conceptSlug: 'ok',    conceptName: 'OK',    conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.9 },
      { conceptSlug: 'draft', conceptName: 'Draft', conceptStatus: 'ACTIVE', conceptPublishedAt: null, pagerankScore: 0.8 },
      { conceptSlug: 'veto',  conceptName: 'Veto',  conceptStatus: 'VETOED', conceptPublishedAt: NOW, pagerankScore: 0.7 },
    ];
    const tutorialRanksByConcept = new Map([['ok', ranks(['ok1','ok2','ok3','ok4'])]]);
    const tutorialsBySlug = new Set(['ok1','ok2','ok3','ok4']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out.map(s => s.conceptSlug)).toEqual(['ok']);
  });

  it('null communityFingerprint passes filter freely', () => {
    const kgCandidates = [
      { conceptSlug: 'a', conceptName: 'A', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.9 },
      { conceptSlug: 'b', conceptName: 'B', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 0.8 },
    ];
    const communityByConcept = new Map([['a', null], ['b', null]]);
    const tutorialRanksByConcept = new Map([['a', ranks(['a1','a2','a3','a4'])], ['b', ranks(['b1','b2','b3','b4'])]]);
    const tutorialsBySlug = new Set(['a1','a2','a3','a4','b1','b2','b3','b4']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug, targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out.map(s => s.conceptSlug)).toEqual(['a','b']);
  });

  it('truncates missionSlugs to missionsPerSlide', () => {
    const kgCandidates = [{ conceptSlug: 'a', conceptName: 'A', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 1 }];
    const tutorialRanksByConcept = new Map([['a', ranks(['a1','a2','a3','a4','a5','a6'])]]);
    const tutorialsBySlug = new Set(['a1','a2','a3','a4','a5','a6']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].missionSlugs).toEqual(['a1','a2','a3','a4']);
  });

  it('empty inputs → empty output, not throw', () => {
    const out = selectFeaturedTopics({ editorial: [], kgCandidates: [], communityByConcept: new Map(), tutorialRanksByConcept: new Map(), tutorialsBySlug: new Set(), targetCount: 8, missionsPerSlide: 4, now: NOW });
    expect(out).toEqual([]);
  });

  it('uses concept.name when displayTitle is null', () => {
    const kgCandidates = [{ conceptSlug: 'x', conceptName: 'X-Fallback', conceptStatus: 'ACTIVE', conceptPublishedAt: NOW, pagerankScore: 1 }];
    const tutorialRanksByConcept = new Map([['x', ranks(['x1'])]]);
    const tutorialsBySlug = new Set(['x1']);
    const out = selectFeaturedTopics({ editorial: [], kgCandidates, communityByConcept: new Map(), tutorialRanksByConcept, tutorialsBySlug, targetCount: 1, missionsPerSlide: 4, now: NOW });
    expect(out[0].displayTitle).toBe('X-Fallback');
  });
});
