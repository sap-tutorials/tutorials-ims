import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

describe('buildTopicsGalleryPayload', () => {
  let db, build;
  beforeAll(async () => {
    await project;
    db = await cds.connect.to('db');
    build = await import('../../../srv/lib/build-topics-gallery.js');
    const { TopicClusters, KgCommunity, Concepts } = cds.entities(NS);
    await INSERT.into(TopicClusters).entries([
      { slug: 'hana', label: 'HANA', curatedLabel: null, fingerprint: 'FP1', previousFingerprints: '', status: 'ACTIVE', hidden: false, memberCount: 2, tutorialCount: 5, computedAt: new Date().toISOString() },
      { slug: 'hidden-one', label: 'Hidden', fingerprint: 'FP2', previousFingerprints: '', status: 'ACTIVE', hidden: true, memberCount: 1, tutorialCount: 1, computedAt: new Date().toISOString() },
    ]);
    await INSERT.into(Concepts).entries([
      { ID: cds.utils.uuid(), slug: 'hana-sql', name: 'HANA SQL', status: 'ACTIVE' },
    ]);
    await INSERT.into(KgCommunity).entries([
      { communityId: 1, vertexKey: 'concept:hana-sql', vertexType: 'concept', slug: 'hana-sql', detectedAt: new Date().toISOString(), communityFingerprint: 'FP1' },
    ]);
  });

  it('returns ACTIVE non-hidden gallery cards with top concepts', async () => {
    const payload = await build.buildTopicsGalleryPayload(db);
    expect(payload.error).toBeNull();
    const slugs = payload.gallery.map((c) => c.slug);
    expect(slugs).toContain('hana');
    expect(slugs).not.toContain('hidden-one'); // hidden excluded
    const hana = payload.gallery.find((c) => c.slug === 'hana');
    expect(hana.topConcepts.map((x) => x.slug)).toContain('hana-sql');
    expect(payload.clusters.hana).toBeTruthy();
    expect(payload.clusters.hana.concepts.map((x) => x.slug)).toContain('hana-sql');
  });
});
