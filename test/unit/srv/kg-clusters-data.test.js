// test/unit/srv/kg-clusters-data.test.js
//
// Unit test for buildClustersDataPayload.
// Mocks build-topics-gallery.js so no DB or CAP boot is needed.
//
// Asserts:
//   - One super-node per cluster (id = 'c:<slug>', type='cluster')
//   - node.size = memberCount of the cluster
//   - Inter-cluster edges are DEDUPED (hana↔cap pair appears exactly once)
//   - edge.weight matches the peer weight from the gallery mock
//
// Issue: topics-discovery SDD Task 8

import { describe, it, expect, vi } from 'vitest';
import { buildClustersDataPayload } from '../../../srv/lib/kg-clusters-data.js';

vi.mock('../../../srv/lib/build-topics-gallery.js', () => ({
  buildTopicsGalleryPayload: vi.fn(async () => ({
    gallery: [
      { slug: 'hana', label: 'HANA', memberCount: 10, tutorialCount: 5, topConcepts: [] },
      { slug: 'cap', label: 'CAP', memberCount: 8, tutorialCount: 4, topConcepts: [] },
    ],
    clusters: {
      hana: { slug: 'hana', label: 'HANA', memberCount: 10, tutorialCount: 5, peers: [{ slug: 'cap', label: 'CAP', weight: 3 }], concepts: [] },
      cap:  { slug: 'cap',  label: 'CAP',  memberCount: 8,  tutorialCount: 4, peers: [{ slug: 'hana', label: 'HANA', weight: 3 }], concepts: [] },
    },
    buildAt: 'now', error: null,
  })),
}));

describe('buildClustersDataPayload', () => {
  it('emits one super-node per cluster and deduped inter-cluster edges', async () => {
    const { nodes, edges } = await buildClustersDataPayload({});
    expect(nodes.map((n) => n.id).sort()).toEqual(['c:cap', 'c:hana']);
    expect(nodes.find((n) => n.id === 'c:hana').size).toBe(10);
    // hana<->cap appears once, not twice
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(3);
  });

  it('node type is cluster', async () => {
    const { nodes } = await buildClustersDataPayload({});
    expect(nodes.every((n) => n.type === 'cluster')).toBe(true);
  });

  it('edge uses s/o fields matching explore-data convention', async () => {
    const { edges } = await buildClustersDataPayload({});
    const e = edges[0];
    expect(e).toHaveProperty('s');
    expect(e).toHaveProperty('o');
    expect(e.s).toMatch(/^c:/);
    expect(e.o).toMatch(/^c:/);
  });

  it('generatedAt is an ISO string', async () => {
    const { generatedAt } = await buildClustersDataPayload({});
    expect(typeof generatedAt).toBe('string');
    expect(() => new Date(generatedAt)).not.toThrow();
  });
});
