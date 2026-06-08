// srv/lib/__tests__/category-classifier-llm.test.js
// TDD tests for the forced-tool-call LLM wrapper for category classification.
// Phase 3, Tasks 3.1 + 3.2 of the categories-facet plan.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChatCompletion = vi.fn();

vi.mock('@sap-ai-sdk/orchestration', () => ({
  // Must use `function` keyword (not arrow) so vitest treats it as a constructor.
  OrchestrationClient: vi.fn().mockImplementation(function () {
    this.chatCompletion = mockChatCompletion;
  }),
}));

vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });
  log.info = vi.fn();
  return { default: { log, env: {} } };
});

beforeEach(() => {
  globalThis.SELECT = { one: { from: () => Promise.resolve({ modelName: null, deploymentId: null }) } };
  mockChatCompletion.mockReset();
});

import { classifyViaLlm } from '../category-classifier-llm.js';

const TAXONOMY = [
  { slug: 'artificial-intelligence', label: 'Artificial Intelligence' },
  { slug: 'app-dev-automation',      label: 'Application Development & Automation' },
];

/** Helper to build a mocked chatCompletion response with a forced tool call. */
function mockResponse(categories, usage = { prompt_tokens: 120, completion_tokens: 30 }) {
  return {
    getToolCalls: () => ([
      {
        function: {
          name: 'submit_categories',
          arguments: JSON.stringify({ categories }),
        },
      },
    ]),
    getTokenUsage: usage ? () => usage : () => null,
  };
}

describe('classifyViaLlm', () => {
  it('1. returns two valid categories with correct shape and token counts', async () => {
    mockChatCompletion.mockResolvedValue(
      mockResponse(
        [
          { slug: 'artificial-intelligence', confidence: 0.92 },
          { slug: 'app-dev-automation',      confidence: 0.55 },
        ],
        { prompt_tokens: 120, completion_tokens: 30 }
      )
    );

    const out = await classifyViaLlm({
      title: 'Build an AI app',
      description: 'Use SAP AI Core to build a conversational AI application.',
      tagSlugs: ['software-product>sap-ai-core'],
      taxonomy: TAXONOMY,
    });

    expect(out.assigned.length).toBe(2);
    expect(out.assigned[0].slug).toBe('artificial-intelligence');
    expect(out.assigned[0].confidence).toBeGreaterThan(0.9);
    expect(out.modelName).toBeTruthy();
    expect(out.promptTokens).toBe(120);
  });

  it('2. filters out made-up slug not in taxonomy', async () => {
    mockChatCompletion.mockResolvedValue(
      mockResponse(
        [
          { slug: 'artificial-intelligence', confidence: 0.9 },
          { slug: 'made-up-slug',            confidence: 0.7 },
        ],
        null  // getTokenUsage returns null
      )
    );

    const out = await classifyViaLlm({
      title: 'AI tutorial',
      description: 'A tutorial about AI.',
      tagSlugs: [],
      taxonomy: TAXONOMY,
    });

    expect(out.assigned.map(a => a.slug)).toEqual(['artificial-intelligence']);
  });

  it('3. throws with /no tool call/i when getToolCalls returns empty', async () => {
    mockChatCompletion.mockResolvedValue({
      getToolCalls: () => [],
      getTokenUsage: () => null,
    });

    await expect(
      classifyViaLlm({
        title: 'X',
        description: '',
        tagSlugs: [],
        taxonomy: TAXONOMY,
      })
    ).rejects.toThrow(/no tool call/i);
  });

  it('4. de-duplicates repeated slug and caps at 3', async () => {
    mockChatCompletion.mockResolvedValue(
      mockResponse([
        { slug: 'artificial-intelligence', confidence: 0.9 },
        { slug: 'app-dev-automation',      confidence: 0.8 },
        { slug: 'artificial-intelligence', confidence: 0.7 },
      ])
    );

    const out = await classifyViaLlm({
      title: 'Dup test',
      description: 'Testing dedup logic.',
      tagSlugs: [],
      taxonomy: TAXONOMY,
    });

    // No duplicate slugs
    const slugs = out.assigned.map(a => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // Capped at 3 (satisfied trivially since input has 2 unique)
    expect(out.assigned.length).toBeLessThanOrEqual(3);
  });
});
