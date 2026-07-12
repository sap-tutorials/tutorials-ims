// test/unit/kg-phase4-reactivation.test.js
//
// #1115 final-review fix: Phase 4 fetchers must flip RETIRED concepts back to
// ACTIVE when resolveConceptCandidates returns action='reactivated'.
//
// Representative fetcher: fetch-blog-posts-job.js (runFetchBlogPosts).
// DI seams: deps.embed, deps.extractFn, deps.budgetOverride, deps.sinceIsoOverride.
// searchBlogPosts (Khoros client) is mocked via vi.mock.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

// Mock the Khoros client BEFORE importing the job. vi.mock is hoisted.
vi.mock('../../srv/lib/khoros-blogs-client.js', () => ({
  searchBlogPosts: vi.fn(),
}));

// After vi.mock, import the mock so we can configure return values.
const { searchBlogPosts } = await import('../../srv/lib/khoros-blogs-client.js');
const { runFetchBlogPosts } = await import('../../srv/jobs/fetch-blog-posts-job.js');

const NS_KG = 'com.sap.developers.ims';
const NS_EXT = 'com.sap.developers.ims.external';

describe('Phase-4 reactivation — fetch-blog-posts-job (#1115)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  beforeEach(async () => {
    // Seed a KnowledgeGraphSettings row so resolveKnowledgeGraphSettings doesn't throw.
    const { KnowledgeGraphSettings } = cds.entities(NS_KG);
    await DELETE.from(KnowledgeGraphSettings);
    await INSERT.into(KnowledgeGraphSettings).entries({
      enabled: true,
      extractBuildCap: 200,
      mergeSimThresholdExtract: 0.85,
    });
    // Set env so chat-settings-resolver doesn't throw.
    process.env.CHAT_DEPLOYMENT_ID = 'test-deployment';
    process.env.EMBEDDING_DEPLOYMENT_ID = 'test-embedding';
  });

  it('flips a RETIRED concept to ACTIVE and inserts a BlogPostConceptLink', async () => {
    const { Concepts } = cds.entities(NS_KG);
    const { BlogPosts, BlogPostConceptLinks } = cds.entities(NS_EXT);

    // Clean slate.
    await DELETE.from(BlogPostConceptLinks);
    await DELETE.from(BlogPosts);
    await DELETE.from(Concepts);

    // Seed a RETIRED concept with slug 'widget-basics'.
    const RETIRED_ID = 'c1115000-0000-0000-0000-000000000001';
    await INSERT.into(Concepts).entries({
      ID: RETIRED_ID,
      slug: 'widget-basics',
      name: 'Widget Basics',
      status: 'RETIRED',
      embedding: Buffer.alloc(1536 * 4),
      extractionCount: 0,
    });

    // Seed one BlogPost row so the MAX-or-abort gate passes.
    await INSERT.into(BlogPosts).entries({
      slug: 'bp-seed-000',
      title: 'Seed post',
      excerpt: '',
      url: 'https://example.com',
      khorosMessageId: 'seed-000',
      postedAt: '2024-01-01T00:00:00.000Z',
      authorLogin: 'seed',
      authorName: 'Seed',
      authorAvatarUrl: '',
      sourceId: 'seed-000',
      contentHash: 'seedhash',
      lastSeenAt: new Date().toISOString(),
    });

    // Mock Khoros to return one NEW post whose extraction will re-propose 'widget-basics'.
    searchBlogPosts.mockResolvedValue({
      posts: [
        {
          message_id: 'bp-test-001',
          subject: 'Post about Widget Basics',
          body: 'Widget basics are fundamental to building good apps.',
          post_time: '2026-07-12T10:00:00.000Z',
          view_href: 'https://community.sap.com/post/1',
          author: {
            login: 'alice',
            first_name: 'Alice',
            last_name: 'Smith',
            avatar: { profile: '' },
          },
        },
      ],
    });

    // Injected extractor: re-proposes the RETIRED concept's slug.
    const extractFn = async () => ({
      discusses: [{ slug: 'widget-basics', name: 'Widget Basics', confidence: 0.92 }],
      tokenUsage: { prompt: 0, completion: 0 },
    });

    // Injected embedder: returns zero vector (no similarity match needed since slug is exact).
    const embed = async () => [new Float32Array(1536).fill(0.0)];

    const summary = await runFetchBlogPosts({
      embed,
      extractFn,
      budgetOverride: 5,
      sinceIsoOverride: '2020-01-01T00:00:00.000Z',
    });

    // Job should have extracted exactly 1 post and written 1 link.
    expect(summary.errors).toBe(0);
    expect(summary.extracted).toBe(1);
    expect(summary.discussesWritten).toBe(1);

    // The RETIRED concept must now be ACTIVE.
    const [concept] = await SELECT.from(Concepts).where({ ID: RETIRED_ID });
    expect(concept.status).toBe('ACTIVE');

    // A BlogPostConceptLink row must exist referencing the reactivated concept.
    const links = await SELECT.from(BlogPostConceptLinks).where({ concept_ID: RETIRED_ID });
    expect(links.length).toBe(1);
    expect(links[0].predicate).toBe('discusses');
  });
});
