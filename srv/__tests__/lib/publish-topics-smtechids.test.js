// srv/__tests__/lib/publish-topics-smtechids.test.js
import { describe, it, expect } from 'vitest';
import { renderTopicsIntoSession } from '../../lib/publish-topics.js';

// Minimal shell with a description meta anchor so composeShell can insert.
const shell = {
  before: '<head><meta name="description" content="x"></head>',
  after: '</body>',
};

function makeDeps(topic) {
  return {
    loadLiveTags: async () => [{ slug: topic.slug, label: topic.label, facet: 'software-product', segments: ['sap-hana'] }],
    loadTopicCorpus: async () => ({ live: [{ slug: topic.slug, label: topic.label, facet: 'software-product', segments: ['sap-hana'] }] }),
    buildTopicDetailPayload: async () => topic,
  };
}

describe('publish-topics sm_tech_ids', () => {
  it('emits sm_tech_ids for a product-tag topic', async () => {
    const captured = {};
    const helpers = { appendToSession: async ({ files }) => Object.assign(captured, files) };
    await renderTopicsIntoSession({
      db: {}, sessionId: 's', helpers, priorHashes: {}, shell,
      deps: makeDeps({ slug: 'sap-hana', label: 'SAP HANA', tutorials: [], concepts: [], smTechIds: ['7355001'] }),
    });
    const blob = Buffer.from(captured['topic-sap-hana'], 'base64');
    const { gunzipSync } = await import('node:zlib');
    const html = gunzipSync(blob).toString('utf-8');
    expect(html).toContain('<meta name="sm_tech_ids" content="en-US,7355001">');
  });

  it('emits no sm_tech_ids for a non-product topic', async () => {
    const captured = {};
    const helpers = { appendToSession: async ({ files }) => Object.assign(captured, files) };
    await renderTopicsIntoSession({
      db: {}, sessionId: 's', helpers, priorHashes: {}, shell,
      deps: makeDeps({ slug: 'some-topic', label: 'Some Topic', tutorials: [], concepts: [], smTechIds: [] }),
    });
    const blob = Buffer.from(captured['topic-some-topic'], 'base64');
    const { gunzipSync } = await import('node:zlib');
    const html = gunzipSync(blob).toString('utf-8');
    expect(html).not.toContain('sm_tech_ids');
  });
});
