// test/unit/freshness-detector.test.js
// Task 5 fix: source markdown from getTutorialSource (ContentFiles.sourceContent)
// rather than Steps rows. vi.mock intercepts the content-store import.

import { describe, it, expect, afterEach, vi } from 'vitest';
import cds from '@sap/cds';

// Mock content-store so getTutorialSource returns canned markdown without
// needing a ContentFiles row or a live gzip/HANA setup.
vi.mock('../../srv/lib/content-store.js', () => ({
  getTutorialSource: vi.fn(async () => ({
    markdown: '```JavaScript\nrequire("node-fetch");\n```',
    sourceHash: 'x',
    contentHash: 'y',
  })),
}));

// Module-level bootstrap — mirrors freshness-grounding.test.js pattern.
// NOT cds.test(process.cwd()), per the MEMORY.md unit-test bootstrap note.
cds.test('serve', '--project', '.', '--in-memory');

describe('detectFreshness', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });
  afterEach(() => { delete globalThis.__FRESHNESS_TEST_IMPL__; });

  it('uses the test-impl hook and returns findings + cost', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo', title: 'Demo', legacyId: 1 });

    globalThis.__FRESHNESS_TEST_IMPL__ = async ({ blocks }) => ({
      promptTokens: 100, completionTokens: 50, modelName: 'anthropic--claude-4.6-sonnet',
      findings: [{ category: 'obsolete-dep', severity: 'High', confidence: 'High',
        stepRef: blocks[0].stepRef, codeBlockIndex: 0, lang: 'JavaScript',
        evidence: 'require("node-fetch")', summary: 'node-fetch obsolete',
        suggestedFix: 'use native fetch', groundingSource: 'https://x' }],
    });

    const { detectFreshness } = await import('../../srv/lib/freshness-detector.js');
    const res = await detectFreshness({ db, tutorialId: tid });
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].category).toBe('obsolete-dep');
    expect(res.costCents).toBeGreaterThan(0);
  });

  it('fails open (ok:false, empty findings) when the impl throws', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo2', title: 'D2', legacyId: 2 });
    globalThis.__FRESHNESS_TEST_IMPL__ = async () => { throw new Error('LLM down'); };
    const { detectFreshness } = await import('../../srv/lib/freshness-detector.js');
    const res = await detectFreshness({ db, tutorialId: tid });
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([]);
  });

  it('returns ok:true with empty findings when getTutorialSource returns null markdown', async () => {
    const { getTutorialSource } = await import('../../srv/lib/content-store.js');
    getTutorialSource.mockResolvedValueOnce({ markdown: null, sourceHash: null, contentHash: null });

    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo3', title: 'D3', legacyId: 3 });
    const { detectFreshness } = await import('../../srv/lib/freshness-detector.js');
    const res = await detectFreshness({ db, tutorialId: tid });
    // Legacy null markdown is a legitimate empty run, NOT a fault.
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
    expect(res.model).toBeNull();
  });
});
