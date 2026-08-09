// test/unit/srv/kg-topic-clusters-job.test.js
// Logic-level unit test for the nightly TopicClusters reconciliation job.
// Uses cds.test in-memory to load the model (so cds.entities(NS) resolves),
// then passes a fake db to _buildCommunitiesInput so no real DB is needed.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('runKgTopicClusters (logic)', () => {
  let job;
  beforeAll(async () => {
    await project;
    job = await import('../../../srv/jobs/kg-topic-clusters-job.js');
  });

  it('builds reconcile input: one community per labeled fingerprint with tutorial member slugs', async () => {
    // Fake db that returns canned rows based on which entity is queried.
    // _buildCommunitiesInput uses SELECT.from(entity) where entity comes from
    // cds.entities(NS) — the CQN ref[0] is the fully-qualified entity name,
    // e.g. 'com.sap.developers.ims.KgCommunityLabel'.
    const fakeDb = {
      run: async (q) => {
        const ref = q?.SELECT?.from?.ref?.[0] ?? '';
        if (ref.includes('KgCommunityLabel')) {
          return [{ communityFingerprint: 'FP1', label: 'HANA Cloud', rationale: 'r' }];
        }
        if (ref.includes('KgCommunitySummaryV')) {
          return [{ communityFingerprint: 'FP1', tutorialCount: 1 }];
        }
        if (ref.includes('KgCommunity')) {
          return [
            { communityFingerprint: 'FP1', vertexType: 'tutorial', slug: 'T1' },
            { communityFingerprint: 'FP1', vertexType: 'concept', slug: 'c1' },
          ];
        }
        if (ref.includes('TopicClusters')) {
          return [];
        }
        return [];
      },
    };

    const { communities, existing } = await job._buildCommunitiesInput(fakeDb);

    expect(existing).toEqual([]);
    expect(communities).toHaveLength(1);
    expect(communities[0].fingerprint).toBe('FP1');
    expect(communities[0].label).toBe('HANA Cloud');
    expect(communities[0].memberSlugs).toContain('t1'); // lowercased tutorial slug
    expect(communities[0].memberSlugs).not.toContain('c1'); // concept excluded from matching basis
  });

  it('excludes unlabeled fingerprints from communities', async () => {
    const fakeDb = {
      run: async (q) => {
        const ref = q?.SELECT?.from?.ref?.[0] ?? '';
        if (ref.includes('KgCommunityLabel')) {
          // FP2 is unlabeled (no row here)
          return [{ communityFingerprint: 'FP1', label: 'Cap Dev', rationale: '' }];
        }
        if (ref.includes('KgCommunitySummaryV')) {
          return [
            { communityFingerprint: 'FP1', tutorialCount: 2 },
            { communityFingerprint: 'FP2', tutorialCount: 3 },
          ];
        }
        if (ref.includes('KgCommunity')) {
          return [
            { communityFingerprint: 'FP1', vertexType: 'tutorial', slug: 'cap-t1' },
            { communityFingerprint: 'FP2', vertexType: 'tutorial', slug: 'btp-t1' },
          ];
        }
        if (ref.includes('TopicClusters')) return [];
        return [];
      },
    };

    const { communities } = await job._buildCommunitiesInput(fakeDb);
    expect(communities).toHaveLength(1);
    expect(communities[0].fingerprint).toBe('FP1');
  });

  it('maps existing TopicClusters with current-run member slugs for Jaccard scoring', async () => {
    const fakeDb = {
      run: async (q) => {
        const ref = q?.SELECT?.from?.ref?.[0] ?? '';
        if (ref.includes('KgCommunityLabel')) {
          return [{ communityFingerprint: 'FP-NEW', label: 'New Label', rationale: '' }];
        }
        if (ref.includes('KgCommunitySummaryV')) {
          return [{ communityFingerprint: 'FP-NEW', tutorialCount: 1 }];
        }
        if (ref.includes('KgCommunity')) {
          return [{ communityFingerprint: 'FP-NEW', vertexType: 'tutorial', slug: 'new-slug' }];
        }
        if (ref.includes('TopicClusters')) {
          // One existing row with OLD fingerprint that has no members in this run
          return [{ slug: 'old-topic', fingerprint: 'FP-OLD', previousFingerprints: '', status: 'ACTIVE', curatedLabel: null, hidden: false }];
        }
        return [];
      },
    };

    const { existing } = await job._buildCommunitiesInput(fakeDb);
    // Existing row's memberSlugs should be empty because FP-OLD is gone
    expect(existing).toHaveLength(1);
    expect(existing[0].slug).toBe('old-topic');
    expect(existing[0].memberSlugs).toEqual([]);
  });
});
