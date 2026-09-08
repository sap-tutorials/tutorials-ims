// test/unit/semaphore-mapper.test.js
import { describe, it, expect } from 'vitest';
import { mapAllTerms, normalizeName, deriveTitlePath } from '../../srv/lib/semaphore-sync/mapper.js';

// Representative SES allterms.json fragment (shape per docs.progress.com ses-api).
const SAMPLE = {
  parameters: {},
  total: '3',
  terms: [
    {
      term: {
        name: 'SAP S/4HANA',
        id: '73554900100700000651',
        classes: ['http://sap/schema#SoftwareProduct'],
        paths: [{ name: 'Software Product', path: [{ name: 'Software Product' }] }],
      },
    },
    {
      // flattened variant (no { term } wrapper), interest-item class, string path nodes
      name: 'Retail',
      id: '73554900100700000652',
      classes: ['IndustryCluster'],
      paths: [{ path: ['Industry Cluster'] }],
    },
    {
      term: { name: 'License', id: '73554900100700000653', classes: [] },
    },
  ],
};

describe('semaphore mapper', () => {
  it('normalizeName lower-cases and reduces slash/colon separators', () => {
    expect(normalizeName('SAP S/4HANA')).toBe('sap s 4hana');
    expect(normalizeName('Software Product : SAP')).toBe('software product sap');
    expect(normalizeName(null)).toBe('');
  });

  it('deriveTitlePath builds ancestor : leaf and appends the leaf name', () => {
    expect(deriveTitlePath({ name: 'SAP S/4HANA', paths: [{ path: [{ name: 'Software Product' }] }] }))
      .toBe('Software Product : SAP S/4HANA');
    // no path → just the label
    expect(deriveTitlePath({ name: 'License', paths: [] })).toBe('License');
    // leaf already terminal → not duplicated
    expect(deriveTitlePath({ name: 'Retail', paths: [{ path: ['Industry Cluster', 'Retail'] }] }))
      .toBe('Industry Cluster : Retail');
  });

  it('maps terms to upsert rows keyed by semaphoreId', () => {
    const { rows, skipped } = mapAllTerms(SAMPLE, {
      interestItemClasses: ['IndustryCluster'],
    });
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(3);

    const s4 = rows.find((r) => r.semaphoreId === '73554900100700000651');
    expect(s4).toMatchObject({
      label: 'SAP S/4HANA',
      name: 'sap s 4hana',
      titlePath: 'Software Product : SAP S/4HANA',
      isActualTag: true,      // default when no actualTagClasses config
      isInterestItem: false,
    });

    const retail = rows.find((r) => r.semaphoreId === '73554900100700000652');
    expect(retail.isInterestItem).toBe(true); // class matched interestItemClasses
    expect(retail.titlePath).toBe('Industry Cluster : Retail');
  });

  it('honours actualTagClasses when supplied (opt-in classification)', () => {
    const { rows } = mapAllTerms(SAMPLE, {
      actualTagClasses: ['SoftwareProduct'], // short-name match against full URI
    });
    const s4 = rows.find((r) => r.semaphoreId === '73554900100700000651');
    const license = rows.find((r) => r.semaphoreId === '73554900100700000653');
    expect(s4.isActualTag).toBe(true);
    expect(license.isActualTag).toBe(false); // no matching class
  });

  it('skips terms missing id or name, and dedupes on semaphoreId', () => {
    const { rows, skipped } = mapAllTerms({
      terms: [
        { term: { name: 'No Id' } },
        { term: { id: 'x1' } },
        { term: { name: 'First', id: 'dup' } },
        { term: { name: 'Second', id: 'dup' } },
      ],
    });
    expect(skipped.map((s) => s.reason)).toEqual(['missing-id', 'missing-name']);
    const dup = rows.filter((r) => r.semaphoreId === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0].label).toBe('Second'); // last write wins
  });

  it('returns empty result for a malformed response', () => {
    expect(mapAllTerms(null)).toEqual({ rows: [], skipped: [] });
    expect(mapAllTerms({})).toEqual({ rows: [], skipped: [] });
  });
});
