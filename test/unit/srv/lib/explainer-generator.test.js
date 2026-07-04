import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// We mock the AI Core SDK at the module level so the unit test never
// hits real AI Core. The hybrid test exercises the real path.
// vi.hoisted is required because vi.mock is hoisted above imports —
// `vi.fn()` inside the factory must be created in a hoisted block too.
const { OrchestrationClientMock } = vi.hoisted(() => {
  const OrchestrationClientMock = vi.fn(function () {
    this.chatCompletion = vi.fn().mockResolvedValue({
      getContent: () => null,
      getToolCalls: () => [{
        function: {
          name: 'submit_explainer',
          arguments: JSON.stringify({
            tagline: 'Test tagline',
            whyItMatters: 'Test whyItMatters paragraph.',
          }),
        },
      }],
      getTokenUsage: () => ({ prompt_tokens: 200, completion_tokens: 100 }),
    });
  });
  return { OrchestrationClientMock };
});

vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: OrchestrationClientMock,
}));

// Task 4 rewired explainer-generator.js to use resolveChatLlmSettings()
// (parity with every other LLM call site). Mock the resolver at the module
// boundary so the test doesn't need CHAT_DEPLOYMENT_ID env-var setup.
vi.mock('../../../../srv/lib/chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: vi.fn(() => Promise.resolve({
    modelName: 'anthropic--claude-4.6-sonnet',
    deploymentId: 'test-deployment-id',
  })),
}));

import { generateExplainer } from '../../../../srv/lib/explainer-generator.js';

describe('srv/lib/explainer-generator.js', () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.AICORE_EXPLAINER_GENERATOR_DISABLED; });
  afterEach(() => { delete process.env.AICORE_EXPLAINER_GENERATOR_DISABLED; });

  it('generates a verb explainer and returns { tagline, whyItMatters, costCents }', async () => {
    const result = await generateExplainer({
      kind: 'verb',
      row: { verbKey: 'LEARN', label: 'Learn' },
    });
    expect(result).toMatchObject({
      tagline: 'Test tagline',
      whyItMatters: 'Test whyItMatters paragraph.',
    });
    expect(typeof result.costCents).toBe('number');
    expect(result.costCents).toBeGreaterThan(0);
  });

  it('generates a shelf explainer', async () => {
    const result = await generateExplainer({
      kind: 'shelf',
      row: { shelfKey: 'REFERENCE', label: 'Reference' },
    });
    expect(result.tagline).toBe('Test tagline');
  });

  it('generates a shelf-entry explainer with verb context', async () => {
    const result = await generateExplainer({
      kind: 'shelf-entry',
      row: { title: 'SAP Joule', url: 'https://help.sap.com/docs/joule', description: '' },
      context: { verbDefinition: { label: 'Extend with AI', tagline: 'Build AI into SAP apps' } },
    });
    expect(result.whyItMatters).toBe('Test whyItMatters paragraph.');
  });

  it('returns null when AICORE_EXPLAINER_GENERATOR_DISABLED=true', async () => {
    process.env.AICORE_EXPLAINER_GENERATOR_DISABLED = 'true';
    const result = await generateExplainer({
      kind: 'verb',
      row: { verbKey: 'LEARN', label: 'Learn' },
    });
    expect(result).toBeNull();
  });

  it('throws on unknown kind', async () => {
    await expect(
      generateExplainer({ kind: 'bogus', row: {} })
    ).rejects.toThrow(/unknown kind/i);
  });
});
