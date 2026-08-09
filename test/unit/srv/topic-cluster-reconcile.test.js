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
});
