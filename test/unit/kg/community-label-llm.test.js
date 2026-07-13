import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatCompletion = vi.fn();
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: vi.fn().mockImplementation(function () {
    this.chatCompletion = chatCompletion;
  }),
}));
vi.mock('../../../srv/lib/chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: vi.fn().mockResolvedValue({ modelName: 'm1', deploymentId: 'd1' }),
}));

import { labelCommunityViaLlm } from '../../../srv/lib/kg/community-label-llm.js';

describe('labelCommunityViaLlm', () => {
  beforeEach(() => chatCompletion.mockReset());

  it('returns the forced tool-call label + rationale', async () => {
    chatCompletion.mockResolvedValue({
      getToolCalls: () => [{ function: { arguments: JSON.stringify({ label: 'SAP RAP & Fiori Elements', rationale: 'Clustered RAP + FE tutorials.' }) } }],
      getTokenUsage: () => null,
    });
    const out = await labelCommunityViaLlm({
      tutorialTitles: ['Build a RAP app', 'Create a Fiori Elements UI'],
      conceptNames: ['RAP', 'Fiori Elements'],
    });
    expect(out.label).toBe('SAP RAP & Fiori Elements');
    expect(out.rationale).toContain('RAP');
    expect(out.modelName).toBe('m1');
  });

  it('throws when the model returns no tool call', async () => {
    chatCompletion.mockResolvedValue({ getToolCalls: () => [] });
    await expect(labelCommunityViaLlm({ tutorialTitles: ['x'], conceptNames: [] }))
      .rejects.toThrow(/no tool call/i);
  });
});
