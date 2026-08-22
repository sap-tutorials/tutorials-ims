// test/unit/srv/build-topic-cluster-content.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const EXT = 'com.sap.developers.ims.external';
const FP = 'fp-multi0';

beforeAll(async () => {
  await project;
  const db = await cds.connect.to('db');
  const { KgCommunity, Tutorials, Missions, Concepts } = cds.entities(NS);
  const { BlogPosts, BlogPostConceptLinks } = cds.entities(EXT);
  const now = new Date().toISOString();

  // Direct members: 1 tutorial, 1 mission, plus 1 concept member.
  await db.run(INSERT.into(Tutorials).entries([{ ID: cds.utils.uuid(), slug: 'tut-a', title: 'Tut A', status: 'ACTIVE' }]));
  await db.run(INSERT.into(Missions).entries([{ ID: cds.utils.uuid(), slug: 'mis-a', title: 'Mission A', published: true }]));
  await db.run(INSERT.into(KgCommunity).entries([
    { communityId: 1, vertexKey: 'tutorial:tut-a', vertexType: 'tutorial', slug: 'tut-a', communityFingerprint: FP, detectedAt: now },
    { communityId: 1, vertexKey: 'mission:mis-a', vertexType: 'mission', slug: 'mis-a', communityFingerprint: FP, detectedAt: now },
    { communityId: 1, vertexKey: 'concept:cap-handlers', vertexType: 'concept', slug: 'cap-handlers', communityFingerprint: FP, detectedAt: now },
  ]));

  // Concept-hop: concept 'cap-handlers' → 1 recent blog post.
  const conceptId = cds.utils.uuid();
  await db.run(INSERT.into(Concepts).entries([{ ID: conceptId, slug: 'cap-handlers', name: 'CAP Handlers', status: 'ACTIVE' }]));
  const postId = cds.utils.uuid();
  await db.run(INSERT.into(BlogPosts).entries([{ ID: postId, slug: 'blog-1', title: 'A CAP Blog', url: 'https://community.sap.com/b/1', postedAt: now }]));
  await db.run(INSERT.into(BlogPostConceptLinks).entries([{ ID: cds.utils.uuid(), post_ID: postId, concept_ID: conceptId, predicate: 'discusses', confidence: 0.9 }]));
});

describe('resolveClusterContent', () => {
  it('resolves direct members (tutorial+mission) for the stable tier with correct hrefs', async () => {
    const { resolveClusterContent } = await import('../../../srv/lib/build-topic-cluster-content.js');
    const db = await cds.connect.to('db');
    const items = await resolveClusterContent(db, FP, { tiers: ['stable'], nowMs: Date.now() });
    const byKind = Object.fromEntries(items.map(i => [i.kind, i]));
    expect(byKind.tutorial.href).toBe('/tutorials/tut-a');
    expect(byKind.mission.href).toBe('/tutorials/mission-mis-a');
  });

  it('resolves concept-hop blog posts for the volatile tier', async () => {
    const { resolveClusterContent } = await import('../../../srv/lib/build-topic-cluster-content.js');
    const db = await cds.connect.to('db');
    const items = await resolveClusterContent(db, FP, { tiers: ['volatile'], nowMs: Date.now() });
    const blog = items.find(i => i.kind === 'blog-post');
    expect(blog).toBeDefined();
    expect(blog.href).toBe('https://community.sap.com/b/1');
    expect(blog.isNew).toBe(true);
  });

  it('fails open per type: a bad db yields [] not a throw', async () => {
    const { resolveClusterContent } = await import('../../../srv/lib/build-topic-cluster-content.js');
    const throwingDb = { run: async () => { throw new Error('boom'); } };
    const items = await resolveClusterContent(throwingDb, FP, { tiers: ['stable','volatile'], nowMs: Date.now() });
    expect(items).toEqual([]);
  });
});
