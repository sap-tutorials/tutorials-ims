// test/unit/kg-extract.test.js
// Unit tests for extractConceptsFromTutorial in srv/lib/kg-extract.js.
// callModel is dependency-injected via vi.fn() — no real LLM call.

import { describe, it, expect, vi } from 'vitest';
import { extractConceptsFromTutorial } from '../../srv/lib/kg-extract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a well-shaped LLM response (the value the injected callModel resolves to).
 * Mirrors what srv/lib/code-check-llm.js's defaultCallModel returns:
 *   { verdict, promptTokens, completionTokens, modelName }
 * but here `verdict` is the kg-extract schema payload.
 */
function makeResponse(verdict, { promptTokens = 100, completionTokens = 50 } = {}) {
  return { verdict, promptTokens, completionTokens, modelName: 'test-model' };
}

const SAMPLE_GOOD_VERDICT = {
  teaches: [
    { slug: 'cap-handlers', name: 'CAP Service Handlers', confidence: 0.9 },
    { slug: 'custom-logic', name: 'Custom Logic Patterns', confidence: 0.85 },
    { slug: 'async-events', name: 'Async Event Handling', confidence: 0.7 },
  ],
  extends: 'build-your-first-cap-service',
  prerequisites: [
    { source: 'cap-handlers', target: 'cap-service-basics', confidence: 0.8, evidence: 'Builds on first service' },
    { source: 'custom-logic', target: 'cds-annotations', confidence: 0.78, evidence: 'Mentions @assert' },
  ],
};

const SAMPLE_REGISTRY = [
  { slug: 'cap-service-basics', name: 'CAP Service Basics', description: 'Building a first service' },
  { slug: 'cds-annotations', name: 'CDS Annotations', description: 'Annotation syntax' },
  { slug: 'cap-handlers', name: 'CAP Service Handlers', description: 'Handler patterns' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractConceptsFromTutorial — prompt assembly', () => {
  it('embeds every existing concept slug + name in the user prompt', async () => {
    const callModel = vi.fn().mockResolvedValue(makeResponse(SAMPLE_GOOD_VERDICT));

    await extractConceptsFromTutorial({
      tutorialSlug: 'cap-handler-deep-dive',
      tutorialTitle: 'CAP Handler Deep Dive',
      tutorialBody: '# Body\nSome markdown content.',
      registry: SAMPLE_REGISTRY,
      callModel,
    });

    expect(callModel).toHaveBeenCalledOnce();
    const callArg = callModel.mock.calls[0][0];

    expect(typeof callArg.system).toBe('string');
    expect(callArg.system).toMatch(/concept-extraction engine/i);
    expect(typeof callArg.user).toBe('string');

    // Every registry slug + name should appear in the user message
    for (const c of SAMPLE_REGISTRY) {
      expect(callArg.user).toContain(c.slug);
      expect(callArg.user).toContain(c.name);
    }

    // Tutorial title and body present
    expect(callArg.user).toContain('CAP Handler Deep Dive');
    expect(callArg.user).toContain('Some markdown content.');
  });

  it('passes a JSON schema with slug pattern + confidence bounds to callModel', async () => {
    const callModel = vi.fn().mockResolvedValue(makeResponse(SAMPLE_GOOD_VERDICT));

    await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    const callArg = callModel.mock.calls[0][0];
    expect(callArg.schema).toBeTruthy();
    const schemaStr = JSON.stringify(callArg.schema);
    // slug regex pattern present
    expect(schemaStr).toContain('^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$');
    // confidence bounds 0..1 — schema must reference both 0 and 1
    expect(schemaStr).toMatch(/"minimum"\s*:\s*0/);
    expect(schemaStr).toMatch(/"maximum"\s*:\s*1/);
    // top-level fields
    expect(schemaStr).toContain('teaches');
    expect(schemaStr).toContain('prerequisites');
    expect(schemaStr).toContain('extends');
  });

  it('works with an empty registry (no "use existing" bullets)', async () => {
    const callModel = vi.fn().mockResolvedValue(makeResponse(SAMPLE_GOOD_VERDICT));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(callModel).toHaveBeenCalledOnce();
    expect(result).toBeTruthy();
    expect(result.teaches.length).toBe(3); // all 3 teaches in SAMPLE_GOOD_VERDICT pass through
  });
});

describe('extractConceptsFromTutorial — return shape', () => {
  it('returns { teaches, extends, prerequisites, tokenUsage, warnings }', async () => {
    const callModel = vi.fn().mockResolvedValue(
      makeResponse(SAMPLE_GOOD_VERDICT, { promptTokens: 100, completionTokens: 50 })
    );

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: SAMPLE_REGISTRY,
      callModel,
    });

    expect(result).toEqual({
      teaches: expect.arrayContaining([
        expect.objectContaining({ slug: 'cap-handlers', name: 'CAP Service Handlers', confidence: 0.9 }),
      ]),
      extends: 'build-your-first-cap-service',
      prerequisites: expect.arrayContaining([
        expect.objectContaining({ source: 'cap-handlers', target: 'cap-service-basics' }),
      ]),
      tokenUsage: { prompt: 100, completion: 50 },
      warnings: expect.any(Array),
    });

    expect(result.teaches).toHaveLength(3);
    expect(result.prerequisites).toHaveLength(2);
  });

  it('returns { prompt: 0, completion: 0 } token usage when callModel omits usage', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: SAMPLE_GOOD_VERDICT,
      // no promptTokens / completionTokens fields
      modelName: 'test-model',
    });

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.tokenUsage).toEqual({ prompt: 0, completion: 0 });
  });
});

describe('extractConceptsFromTutorial — confidence filter', () => {
  it('drops teaches with confidence < 0.6 (silent — no warning)', async () => {
    const verdict = {
      teaches: [
        { slug: 'high-conf', name: 'High', confidence: 0.9 },
        { slug: 'low-conf', name: 'Low', confidence: 0.4 }, // dropped
        { slug: 'mid-conf', name: 'Mid', confidence: 0.65 },
        { slug: 'edge-conf', name: 'Edge', confidence: 0.6 }, // kept (>= 0.6)
      ],
      extends: null,
      prerequisites: [],
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    const slugs = result.teaches.map((t) => t.slug);
    expect(slugs).toContain('high-conf');
    expect(slugs).toContain('mid-conf');
    expect(slugs).toContain('edge-conf');
    expect(slugs).not.toContain('low-conf');
  });
});

describe('extractConceptsFromTutorial — slug-shape filter', () => {
  it('drops invalid slugs and pushes warnings for each', async () => {
    const verdict = {
      teaches: [
        { slug: 'good-slug', name: 'Good', confidence: 0.9 },
        { slug: 'INVALID UPPER', name: 'Bad upper', confidence: 0.9 }, // dropped + warned
        { slug: 'with spaces', name: 'Bad spaces', confidence: 0.9 }, // dropped + warned
        { slug: '-leading-hyphen', name: 'Bad lead', confidence: 0.9 }, // dropped + warned
        { slug: 'trailing-hyphen-', name: 'Bad trail', confidence: 0.9 }, // dropped + warned
        { slug: 'another-good', name: 'Good 2', confidence: 0.8 },
      ],
      extends: null,
      prerequisites: [],
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    const slugs = result.teaches.map((t) => t.slug);
    expect(slugs).toEqual(['good-slug', 'another-good']);

    // 4 warnings — one per invalid slug
    const slugWarns = result.warnings.filter((w) => /slug/i.test(w));
    expect(slugWarns.length).toBe(4);
  });
});

describe('extractConceptsFromTutorial — teaches.length bounds', () => {
  it('warns when teaches.length < 3 (does not throw)', async () => {
    const verdict = {
      teaches: [
        { slug: 'one', name: 'One', confidence: 0.9 },
        { slug: 'two', name: 'Two', confidence: 0.8 },
      ],
      extends: null,
      prerequisites: [],
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.teaches).toHaveLength(2);
    expect(result.warnings.some((w) => /teaches.*\b3\b.*\b7\b/.test(w))).toBe(true);
  });

  it('warns when teaches.length > 7 (does not throw, does not truncate)', async () => {
    const verdict = {
      teaches: Array.from({ length: 8 }, (_, i) => ({
        slug: `concept-${i}`,
        name: `Concept ${i}`,
        confidence: 0.8,
      })),
      extends: null,
      prerequisites: [],
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.teaches).toHaveLength(8);
    expect(result.warnings.some((w) => /teaches.*\b3\b.*\b7\b/.test(w))).toBe(true);
  });
});

describe('extractConceptsFromTutorial — prerequisites cap', () => {
  it('truncates prerequisites to top 4 (by confidence) with a warning', async () => {
    const verdict = {
      teaches: [
        { slug: 'a', name: 'A', confidence: 0.9 },
        { slug: 'b', name: 'B', confidence: 0.85 },
        { slug: 'c', name: 'C', confidence: 0.8 },
      ],
      extends: null,
      prerequisites: [
        { source: 'aa', target: 't1', confidence: 0.5, evidence: 'low' },
        { source: 'aa', target: 't2', confidence: 0.95, evidence: 'high' },
        { source: 'aa', target: 't3', confidence: 0.85, evidence: 'mid-high' },
        { source: 'aa', target: 't4', confidence: 0.7, evidence: 'mid' },
        { source: 'aa', target: 't5', confidence: 0.9, evidence: 'high2' },
      ],
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.prerequisites).toHaveLength(4);
    // The lowest-confidence prereq (0.5) must be the one dropped
    const targets = result.prerequisites.map((p) => p.target);
    expect(targets).not.toContain('t1');
    // Warning explains the truncation
    expect(result.warnings.some((w) => /prerequisites/i.test(w))).toBe(true);
  });

  it('does not warn when prerequisites.length <= 4', async () => {
    const verdict = {
      teaches: [
        { slug: 'a', name: 'A', confidence: 0.9 },
        { slug: 'b', name: 'B', confidence: 0.85 },
        { slug: 'c', name: 'C', confidence: 0.8 },
      ],
      extends: null,
      prerequisites: [
        { source: 'aa', target: 't1', confidence: 0.95, evidence: 'x' },
        { source: 'aa', target: 't2', confidence: 0.85, evidence: 'y' },
      ],
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.prerequisites).toHaveLength(2);
    expect(result.warnings.some((w) => /prerequisites/i.test(w))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callModel failure paths — graceful degradation, not throwing
// ---------------------------------------------------------------------------

describe('extractConceptsFromTutorial — callModel failure paths', () => {
  it('propagates the original error when callModel rejects (does not swallow)', async () => {
    const boom = new Error('LLM 503: rate-limited');
    const callModel = vi.fn().mockRejectedValue(boom);

    await expect(
      extractConceptsFromTutorial({
        tutorialSlug: 't-1',
        tutorialTitle: 'T1',
        tutorialBody: 'body',
        registry: [],
        callModel,
      })
    ).rejects.toThrow('LLM 503: rate-limited');
    expect(callModel).toHaveBeenCalledOnce();
  });

  it('resolves with empty teaches/prerequisites + warning when callModel returns null', async () => {
    const callModel = vi.fn().mockResolvedValue(null);

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.teaches).toEqual([]);
    expect(result.prerequisites).toEqual([]);
    expect(result.extends).toBeNull();
    expect(result.tokenUsage).toEqual({ prompt: 0, completion: 0 });
    // teaches.length=0 is outside [3,7] — that's the malformed-response signal
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /teaches/i.test(w))).toBe(true);
  });

  it('drops to empty teaches + warning when verdict.teaches is not an array', async () => {
    const verdict = {
      teaches: 'not an array',
      extends: null,
      prerequisites: [],
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.teaches).toEqual([]);
    expect(result.prerequisites).toEqual([]);
    // teaches.length=0 fires the bounds warning
    expect(result.warnings.some((w) => /teaches.*\b3\b.*\b7\b/.test(w))).toBe(true);
  });

  it('drops to empty prerequisites + warning when verdict.prerequisites is not an array', async () => {
    const verdict = {
      teaches: [],
      extends: null,
      prerequisites: 'not an array',
    };
    const callModel = vi.fn().mockResolvedValue(makeResponse(verdict));

    const result = await extractConceptsFromTutorial({
      tutorialSlug: 't-1',
      tutorialTitle: 'T1',
      tutorialBody: 'body',
      registry: [],
      callModel,
    });

    expect(result.teaches).toEqual([]);
    expect(result.prerequisites).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
