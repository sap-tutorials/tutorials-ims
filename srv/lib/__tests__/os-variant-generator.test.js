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
  return { default: { log, env: {}, entities: undefined, connect: { to: () => Promise.resolve({ run: () => Promise.resolve([]) }) } } };
});

vi.mock('../chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: vi.fn(() => Promise.resolve({
    modelName: 'anthropic--claude-4.6-sonnet',
    deploymentId: 'test-deployment-id',
  })),
}));

const mockPersist = vi.fn();
vi.mock('../author-ai-persist.js', () => ({
  persistAuthorAiRequest: mockPersist,
}));

beforeEach(() => {
  mockChatCompletion.mockReset();
  mockPersist.mockReset();
});

const { generateOsVariants } = await import('../os-variant-generator.js');

describe('generateOsVariants', () => {
  it('returns one variant per requested target OS', async () => {
    mockChatCompletion.mockResolvedValueOnce({
      getContent: () => 'BLOCK FOR macOS\n===NEXT_VARIANT===\nBLOCK FOR Linux',
      getTokenUsage: () => ({ total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 }),
    });

    const result = await generateOsVariants({
      sourceMarkdown: 'Open PowerShell',
      sourceOS: 'Windows',
      targetOSes: ['macOS', 'Linux'],
      context: { tutorialSlug: 't', stepHeading: 's', surroundingMarkdown: '' },
      userId: 'user-1',
    });

    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]).toEqual({ os: 'macOS', markdown: 'BLOCK FOR macOS' });
    expect(result.variants[1]).toEqual({ os: 'Linux', markdown: 'BLOCK FOR Linux' });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.tokensUsed).toBe(100);
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      sourceOS: 'Windows',
      targetOSes: ['macOS', 'Linux'],
      variants: [
        { os: 'macOS', markdown: 'BLOCK FOR macOS' },
        { os: 'Linux', markdown: 'BLOCK FOR Linux' },
      ],
      errorCode: null,
    });
  });

  it('throws on mismatched block count', async () => {
    mockChatCompletion.mockResolvedValueOnce({
      getContent: () => 'ONLY ONE BLOCK',
      getTokenUsage: () => ({ total_tokens: 50 }),
    });

    await expect(generateOsVariants({
      sourceMarkdown: 'x', sourceOS: 'Windows', targetOSes: ['macOS', 'Linux'],
      context: {}, userId: 'u',
    })).rejects.toThrow(/expected 2/);

    // Persistence still happens on failure (audit row with errorCode populated)
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist.mock.calls[0][0].errorCode).toBeTruthy();
  });

  it('persists with errorCode on AI Core failure', async () => {
    mockChatCompletion.mockRejectedValueOnce(new Error('upstream 502'));
    await expect(generateOsVariants({
      sourceMarkdown: 'x', sourceOS: 'Windows', targetOSes: ['macOS'],
      context: {}, userId: 'u',
    })).rejects.toThrow(/upstream/);
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist.mock.calls[0][0].errorCode).toBeTruthy();
  });
});
