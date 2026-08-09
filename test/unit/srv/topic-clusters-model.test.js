import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

describe('TopicClusters model', () => {
  it('compiles and exposes stable-slug key + fingerprint fields', async () => {
    const model = await cds.load(['db/knowledge-graph.cds', 'db/knowledge-graph-communities.cds', 'db/knowledge-graph-topic-clusters.cds']);
    const e = model.definitions['com.sap.developers.ims.TopicClusters'];
    expect(e).toBeTruthy();
    expect(e.elements.slug.key).toBe(true);
    expect(e.elements.fingerprint.length).toBe(64);
    expect(e.elements.status).toBeTruthy();
    expect(e.elements.curatedLabel).toBeTruthy();
    expect(e.elements.hidden).toBeTruthy();
    expect(e.elements.rationale).toBeTruthy();
  });
});
