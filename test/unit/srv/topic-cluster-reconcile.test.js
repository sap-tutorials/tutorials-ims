import { describe, it, expect } from 'vitest';
import { slugify, jaccard, reconcile } from '../../../srv/lib/topic-cluster-reconcile.js';

describe('slugify', () => {
  it('lowercases, hyphenates, strips punctuation', () => {
    expect(slugify('RAP & Clean Core Development')).toBe('rap-clean-core-development');
    expect(slugify('SAP HANA Cloud Data Management')).toBe('sap-hana-cloud-data-management');
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets, 0 for disjoint', () => {
    expect(jaccard(['a','b'], ['a','b'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
  });
  it('computes intersection/union', () => {
    expect(jaccard(['a','b','c'], ['b','c','d'])).toBeCloseTo(2/4);
  });
});

describe('reconcile', () => {
  it('keeps slug and rolls fingerprint when a drifted community matches by overlap', () => {
    const existing = [{ slug: 'hana-cloud', fingerprint: 'OLD', previousFingerprints: '', status: 'ACTIVE', memberSlugs: ['t1','t2','t3'] }];
    const communities = [{ fingerprint: 'NEW', label: 'HANA Cloud', memberSlugs: ['t1','t2','t4'], memberCount: 3, tutorialCount: 3 }];
    const { upserts, retired } = reconcile({ existing, communities, threshold: 0.4 });
    expect(retired).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].slug).toBe('hana-cloud');
    expect(upserts[0].fingerprint).toBe('NEW');
    expect(upserts[0].previousFingerprints).toBe('OLD');
  });

  it('mints a new slug for a genuinely new community', () => {
    const existing = [];
    const communities = [{ fingerprint: 'F1', label: 'ABAP Cloud', memberSlugs: ['a'], memberCount: 1, tutorialCount: 1 }];
    const { upserts } = reconcile({ existing, communities, threshold: 0.5 });
    expect(upserts[0].slug).toBe('abap-cloud');
    expect(upserts[0].previousFingerprints).toBe('');
  });

  it('retires an existing cluster with no matching community', () => {
    const existing = [{ slug: 'gone', fingerprint: 'X', previousFingerprints: '', status: 'ACTIVE', memberSlugs: ['z'] }];
    const communities = [{ fingerprint: 'F', label: 'New', memberSlugs: ['a','b'], memberCount: 2, tutorialCount: 2 }];
    const { upserts, retired } = reconcile({ existing, communities, threshold: 0.5 });
    expect(retired).toContain('gone');
    expect(upserts.map(u => u.slug)).toContain('new');
  });

  it('dedupes minted slugs with a numeric suffix', () => {
    const communities = [
      { fingerprint: 'A', label: 'SAP Build', memberSlugs: ['a'], memberCount: 1, tutorialCount: 1 },
      { fingerprint: 'B', label: 'SAP Build', memberSlugs: ['b'], memberCount: 1, tutorialCount: 1 },
    ];
    const { upserts } = reconcile({ existing: [], communities, threshold: 0.5 });
    const slugs = upserts.map(u => u.slug).sort();
    expect(slugs).toEqual(['sap-build', 'sap-build-2']);
  });

  it('prevents double-match: higher-Jaccard community keeps existing slug, second mints new', () => {
    const existing = [{ slug: 'data-platform', fingerprint: 'X', previousFingerprints: '', status: 'ACTIVE', memberSlugs: ['t1','t2','t3'] }];
    const communities = [
      { fingerprint: 'A', label: 'Data Platform', memberSlugs: ['t1','t2','t3','t4'], memberCount: 4, tutorialCount: 4 },
      { fingerprint: 'B', label: 'Data Analytics', memberSlugs: ['t1','t2'], memberCount: 2, tutorialCount: 2 },
    ];
    const { upserts, retired } = reconcile({ existing, communities, threshold: 0.4 });
    expect(retired).toEqual([]);
    expect(upserts).toHaveLength(2);
    const keptSlug = upserts.find(u => u.slug === 'data-platform');
    const mintedSlug = upserts.find(u => u.slug === 'data-analytics');
    expect(keptSlug).toBeDefined();
    expect(keptSlug.fingerprint).toBe('A');
    expect(mintedSlug).toBeDefined();
    expect(mintedSlug.fingerprint).toBe('B');
  });

  it('chains multi-generation fingerprint history', () => {
    const existing = [{ slug: 'data-stack', fingerprint: 'FP2', previousFingerprints: 'FP1', status: 'ACTIVE', memberSlugs: ['t1','t2'] }];
    const communities = [{ fingerprint: 'FP3', label: 'Data Stack', memberSlugs: ['t1','t2','t3'], memberCount: 3, tutorialCount: 3 }];
    const { upserts } = reconcile({ existing, communities, threshold: 0.4 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].slug).toBe('data-stack');
    expect(upserts[0].fingerprint).toBe('FP3');
    expect(upserts[0].previousFingerprints).toBe('FP1\nFP2');
  });

  // --- I1 regression test ---
  it('I1: minted slug avoids a retired slug so INSERT batch has unique PKs', () => {
    // Scenario: 'hana-cloud' is ACTIVE last night; tonight its community
    // has drifted past the Jaccard threshold (or gone entirely) → it retires.
    // A brand-new community whose label also slugifies to 'hana-cloud' arrives.
    // Without the fix mintSlug would produce 'hana-cloud' → duplicate PK → crash.
    const existing = [
      { slug: 'hana-cloud', fingerprint: 'OLD-FP', previousFingerprints: '', status: 'ACTIVE', memberSlugs: ['old-t1'] },
    ];
    // New community with completely different members (Jaccard=0 → no match → mint)
    const communities = [
      { fingerprint: 'NEW-FP', label: 'HANA Cloud', memberSlugs: ['new-t1', 'new-t2'], memberCount: 2, tutorialCount: 2 },
    ];
    const { upserts, retired } = reconcile({ existing, communities, threshold: 0.5 });

    // The old slug must be retired
    expect(retired).toContain('hana-cloud');

    // The new community must get a DIFFERENT slug (suffixed)
    expect(upserts).toHaveLength(1);
    expect(upserts[0].slug).not.toBe('hana-cloud');
    expect(upserts[0].slug).toMatch(/^hana-cloud-\d+$/);

    // No slug appears in both upserts and retired → no duplicate PK
    const upsertSlugs = new Set(upserts.map((u) => u.slug));
    for (const s of retired) {
      expect(upsertSlugs.has(s)).toBe(false);
    }
  });
});
