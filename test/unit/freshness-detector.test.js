// test/unit/freshness-detector.test.js
// Task 5: Detection engine unit tests — uses globalThis.__FRESHNESS_TEST_IMPL__
// hook to inject canned LLM responses without a live AI Core connection.

import { describe, it, expect, afterEach } from 'vitest';
import cds from '@sap/cds';

// Module-level bootstrap — mirrors freshness-grounding.test.js pattern.
// NOT cds.test(process.cwd()), per the MEMORY.md unit-test bootstrap note.
cds.test('serve', '--project', '.', '--in-memory');

describe('detectFreshness', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });
  afterEach(() => { delete globalThis.__FRESHNESS_TEST_IMPL__; });

  it('uses the test-impl hook and returns findings + cost', async () => {
    const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo', title: 'Demo', legacyId: 1 });
    // Adapted from brief: Steps uses stepOrder (not number) and description (not content).
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, stepOrder: 1, description: '```JavaScript\nrequire("node-fetch");\n```' });

    globalThis.__FRESHNESS_TEST_IMPL__ = async ({ blocks }) => ({
      promptTokens: 100, completionTokens: 50, modelName: 'anthropic--claude-4.6-sonnet',
      findings: [{ category: 'obsolete-dep', severity: 'High', confidence: 'High',
        stepRef: blocks[0].stepRef, codeBlockIndex: 0, lang: 'JavaScript',
        evidence: 'require("node-fetch")', summary: 'node-fetch obsolete',
        suggestedFix: 'use native fetch', groundingSource: 'https://x' }],
    });

    const { detectFreshness } = await import('../../srv/lib/freshness-detector.js');
    const res = await detectFreshness({ db, tutorialId: tid });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].category).toBe('obsolete-dep');
    expect(res.costCents).toBeGreaterThan(0);
  });

  it('fails open (returns empty findings) when the impl throws', async () => {
    const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo2', title: 'D2', legacyId: 2 });
    // Adapted from brief: Steps uses stepOrder (not number) and description (not content).
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, stepOrder: 1, description: '```js\nx\n```' });
    globalThis.__FRESHNESS_TEST_IMPL__ = async () => { throw new Error('LLM down'); };
    const { detectFreshness } = await import('../../srv/lib/freshness-detector.js');
    const res = await detectFreshness({ db, tutorialId: tid });
    expect(res.findings).toEqual([]);
  });
});
