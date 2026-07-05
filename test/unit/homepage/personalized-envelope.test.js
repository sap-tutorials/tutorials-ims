// test/unit/homepage/personalized-envelope.test.js
import { describe, it, expect } from 'vitest';
import { buildEnvelope, hashEnvelope } from '../../../srv/lib/homepage/personalized-envelope.js';

const dev = { role: 'developer', deployment: 'cloud', cloud: 'aws' };
const shelves = [
  { ID: 's1', verb: 'BUILD',     shelf: 'START_HERE', sortOrder: 100, title: 'S1', personaTags: ['role:developer'], personaWeight: 10 },
  { ID: 's2', verb: 'BUILD',     shelf: 'START_HERE', sortOrder: 50,  title: 'S2' },
  { ID: 's3', verb: 'LEARN',     shelf: 'REFERENCE',  sortOrder: 100, title: 'S3', personaHidden: ['role:developer'] },
];
const forYouCandidates = [
  { ID: 'f1', kind: 'tutorial', targetSlug: 't1', title: 'T1', personaTags: ['role:developer'], personaWeight: 5, sortOrder: 100 },
  { ID: 'f2', kind: 'tutorial', targetSlug: 't2', title: 'T2', personaTags: ['role:developer'], personaWeight: 3, sortOrder: 100 },
  { ID: 'f3', kind: 'tutorial', targetSlug: 't3', title: 'T3', personaTags: ['role:developer'], personaWeight: 1, sortOrder: 100 },
];

describe('buildEnvelope', () => {
  it('has all top-level fields', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates, teaserSlugs: [] });
    for (const k of ['profile','verbOrder','forYou','teaserOrder','shelfOverrides','videoFilterTags','rssFilterTags']) {
      expect(env[k]).toBeDefined();
    }
    expect(env.verbOrder).toHaveLength(6);
  });

  it('includes hidden shelf IDs per verb', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(env.shelfOverrides.learn?.hidden).toContain('s3');
  });

  it('produces reorder list when persona-weighted entry outranks static sortOrder', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    // Build verb: s1 (weight 10, sort 100) beats s2 (sort 50, no weight) despite sortOrder.
    expect(env.shelfOverrides.build?.reorder).toEqual(['s1', 's2']);
  });

  it('drops For-you when fewer than 3 candidates match', () => {
    const two = forYouCandidates.slice(0, 2);
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: two, teaserSlugs: [] });
    expect(env.forYou).toEqual([]);
  });

  it('videoFilterTags include cloud and btp when profile has cloud', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(env.videoFilterTags).toEqual(expect.arrayContaining(['aws', 'btp']));
  });

  it('rssFilterTags include role and cloud derivatives', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(env.rssFilterTags).toEqual(expect.arrayContaining(['btp-development']));
  });
});

describe('hashEnvelope', () => {
  it('is stable for identical input', () => {
    const a = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    const b = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(hashEnvelope(a)).toBe(hashEnvelope(b));
  });

  it('differs when profile differs', () => {
    const a = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    const other = { role: 'student', deployment: null, cloud: null };
    const b = buildEnvelope({ profile: other, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(hashEnvelope(a)).not.toBe(hashEnvelope(b));
  });
});
