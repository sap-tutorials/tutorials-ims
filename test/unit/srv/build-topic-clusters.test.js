// test/unit/srv/build-topic-clusters.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

// Seed a controlled fixture graph: 8 labeled communities of varying sizes,
// one unlabeled community, one mixed-case member slug, one INACTIVE tutorial,
// one member whose slug does not resolve to any Tutorials row.
beforeAll(async () => {
  await project; // ensure server up
  const db = await cds.connect.to('db');
  const { KgCommunity, KgCommunityLabel, Tutorials } = cds.entities(NS);

  // Helper: create a community fingerprint with `n` tutorial members
  // slugged clu<c>-t<i>, plus matching ACTIVE Tutorials rows.
  const communities = [];
  const tutorials = [];
  const labels = [];
  // 7 labeled communities sized 6,5,5,4,4,3,3  → all qualify (>=3)
  const sizes = [6, 5, 5, 4, 4, 3, 3];
  sizes.forEach((n, c) => {
    const fp = `fp-${c}`.padEnd(8, '0');
    labels.push({ communityFingerprint: fp, label: `Cluster ${c}`, rationale: `why ${c}`, memberSlugsHash: `h${c}`, labeledAt: new Date().toISOString(), model: 'test' });
    for (let i = 0; i < n; i++) {
      const slug = `clu${c}-t${i}`;
      communities.push({ communityId: c, vertexKey: `t:${slug}`, vertexType: 'tutorial', slug, communityFingerprint: fp, detectedAt: new Date().toISOString() });
      tutorials.push({ ID: cds.utils.uuid(), slug, title: `Z Cluster ${c} Tut ${i}`, status: 'ACTIVE' });
    }
  });

  // Labeled community that only has 2 resolvable tutorials → must be dropped by the >=3 gate.
  const fpThin = 'fp-thin0';
  labels.push({ communityFingerprint: fpThin, label: 'Thin Cluster', rationale: 'thin', memberSlugsHash: 'ht', labeledAt: new Date().toISOString(), model: 'test' });
  ['thin-a', 'thin-b'].forEach((slug) => {
    communities.push({ communityId: 90, vertexKey: `t:${slug}`, vertexType: 'tutorial', slug, communityFingerprint: fpThin, detectedAt: new Date().toISOString() });
    tutorials.push({ ID: cds.utils.uuid(), slug, title: `Thin ${slug}`, status: 'ACTIVE' });
  });

  // Unlabeled community (3 tutorials) → must NOT appear (no label row).
  const fpUnlabeled = 'fp-unl00';
  for (let i = 0; i < 3; i++) {
    const slug = `unl-t${i}`;
    communities.push({ communityId: 91, vertexKey: `t:${slug}`, vertexType: 'tutorial', slug, communityFingerprint: fpUnlabeled, detectedAt: new Date().toISOString() });
    tutorials.push({ ID: cds.utils.uuid(), slug, title: `Unlabeled ${i}`, status: 'ACTIVE' });
  }

  // Community with a mixed-case member slug + an INACTIVE tutorial + an
  // unresolvable member. Labeled, has 3 ACTIVE resolvable → qualifies at exactly 3.
  const fpEdge = 'fp-edge0';
  labels.push({ communityFingerprint: fpEdge, label: 'Edge Cluster', rationale: 'edge', memberSlugsHash: 'he', labeledAt: new Date().toISOString(), model: 'test' });
  // mixed-case member; Tutorials row is stored lowercase
  communities.push({ communityId: 92, vertexKey: 't:Edge-Mixed', vertexType: 'tutorial', slug: 'Edge-Mixed', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-mixed', title: 'A Edge Mixed', status: 'ACTIVE' });
  communities.push({ communityId: 92, vertexKey: 't:edge-active2', vertexType: 'tutorial', slug: 'edge-active2', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-active2', title: 'B Edge Active', status: 'ACTIVE' });
  communities.push({ communityId: 92, vertexKey: 't:edge-null', vertexType: 'tutorial', slug: 'edge-null', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-null', title: 'C Edge Null Status', status: null });
  communities.push({ communityId: 92, vertexKey: 't:edge-inactive', vertexType: 'tutorial', slug: 'edge-inactive', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  tutorials.push({ ID: cds.utils.uuid(), slug: 'edge-inactive', title: 'D Edge Inactive', status: 'INACTIVE' });
  communities.push({ communityId: 92, vertexKey: 't:edge-ghost', vertexType: 'tutorial', slug: 'edge-ghost', communityFingerprint: fpEdge, detectedAt: new Date().toISOString() });
  // no Tutorials row for edge-ghost

  await db.run(INSERT.into(Tutorials).entries(tutorials));
  await db.run(INSERT.into(KgCommunity).entries(communities));
  await db.run(INSERT.into(KgCommunityLabel).entries(labels));
});

describe('build-topic-clusters read model (#1170)', () => {
  it('returns top-6 qualifying labeled clusters, ranked by tutorialCount desc', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    expect(clusters.length).toBe(6);
    const counts = clusters.map(c => c.tutorialCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a)); // descending
    expect(counts[0]).toBe(6);
  });

  it('excludes unlabeled communities', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    const titles = clusters.flatMap(c => c.tutorials.map(t => t.title));
    expect(titles.some(t => t.startsWith('Unlabeled'))).toBe(false);
  });

  it('drops labeled clusters with fewer than 3 resolvable live tutorials', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    expect(clusters.find(c => c.label === 'Thin Cluster')).toBeUndefined();
  });

  it('caps member tutorials at 4 per card, sorted title ASC, with correct url', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    const biggest = clusters[0]; // tutorialCount 6
    expect(biggest.tutorials.length).toBe(4);
    const titles = biggest.tutorials.map(t => t.title);
    expect(titles).toEqual([...titles].sort());
    expect(biggest.tutorials[0].url).toBe(`/tutorials/${biggest.tutorials[0].slug}`);
  });

  it('joins slugs case-insensitively and excludes INACTIVE / unresolvable, keeps status NULL', async () => {
    const { buildTopicClustersPayload } = await import('../../../srv/lib/build-topic-clusters.js');
    const db = await cds.connect.to('db');
    const { clusters } = await buildTopicClustersPayload(db);
    const edge = clusters.find(c => c.label === 'Edge Cluster');
    expect(edge).toBeDefined();
    const slugs = edge.tutorials.map(t => t.slug).sort();
    // mixed-case 'Edge-Mixed' resolves to lowercased 'edge-mixed';
    // edge-active2 + edge-null (NULL status) included; edge-inactive + edge-ghost excluded.
    expect(slugs).toEqual(['edge-active2', 'edge-mixed', 'edge-null']);
  });

  it('handler responds 200 with clusters + Cache-Control', async () => {
    const res = await project.get('/build/topic-clusters');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('clusters');
    expect(res.data).toHaveProperty('buildAt');
    expect(res.headers['cache-control']).toContain('max-age=60');
  });
});
