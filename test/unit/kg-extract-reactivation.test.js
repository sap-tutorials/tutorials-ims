// test/unit/kg-extract-reactivation.test.js
// #1115: a nightly extraction that re-proposes a RETIRED concept's slug
// must flip it back to ACTIVE inside the tx, not raise a UNIQUE violation.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { runExtractConcepts } from '../../srv/jobs/extract-concepts-job.js';
import { _resetCacheForTests as _resetSettingsCache } from '../../srv/lib/runtime-config/kg-settings.js';

const NS = 'com.sap.developers.ims';

describe('extract-concepts reactivation (#1115)', () => {
  beforeAll(async () => { await cds.deploy(cds.env.roots).to('sqlite::memory:'); });

  beforeEach(async () => {
    const { KnowledgeGraphSettings } = cds.entities(NS);
    await DELETE.from(KnowledgeGraphSettings);
    await INSERT.into(KnowledgeGraphSettings).entries({
      enabled: true,
      extractBuildCap: 200,
      mergeSimThresholdExtract: 0.85,
    });
    _resetSettingsCache();
    // Ensure resolveChatLlmSettings() does not throw (callModel is injected,
    // but the resolver runs before the LLM call and throws if no deploymentId).
    process.env.CHAT_DEPLOYMENT_ID = 'test-deployment';
  });

  it('flips a re-proposed RETIRED concept back to ACTIVE and links it', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks, TutorialBodyText } = cds.entities(NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);

    await INSERT.into(Tutorials).entries({
      ID: 't0000000-0000-0000-0000-000000000001', slug: 'demo-tut', title: 'Demo', status: 'ACTIVE',
    });
    await INSERT.into(TutorialBodyText).entries({ slug: 'demo-tut', bodyText: 'body about widgets' });
    await INSERT.into(Concepts).entries({
      ID: 'c0000000-0000-0000-0000-000000000001', slug: 'widget-basics', name: 'Widget Basics',
      status: 'RETIRED', embedding: Buffer.alloc(1536 * 4),
    });

    // Injected LLM extractor: callModel returns verdict shape for extractConceptsFromTutorial.
    // The function tolerates a flat verdict object (no `verdict` wrapper key needed).
    const callModel = async () => ({
      verdict: {
        teaches: [{ slug: 'widget-basics', name: 'Widget Basics', confidence: 0.95 }],
        extends: null,
        prerequisites: [],
      },
      promptTokens: 0,
      completionTokens: 0,
      modelName: 'test-model',
    });
    const embed = async () => [new Float32Array(1536).fill(0.1)];

    await runExtractConcepts({ callModel, embed });

    const [c] = await SELECT.from(Concepts).where({ slug: 'widget-basics' });
    expect(c.status).toBe('ACTIVE');
    const links = await SELECT.from(TutorialConceptLinks).where({ concept_ID: c.ID, predicate: 'teaches' });
    expect(links.length).toBe(1);
  });
});
