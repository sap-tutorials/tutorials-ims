import { describe, it, expect, beforeEach, vi } from 'vitest';

const seedMock = vi.fn();
const embedMock = vi.fn();
const keywordMock = vi.fn();
const llmMock = vi.fn();
const settingsMock = vi.fn();

vi.mock('../../srv/lib/relevance-seed-embeddings.js', () => ({
  getSeedEmbeddings: () => seedMock(),
}));
vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: (...a) => embedMock(...a),
}));
vi.mock('../../srv/lib/relevance-keyword-rules.js', () => ({
  classifyByKeywords: (...a) => keywordMock(...a),
}));
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: class {
    async chatCompletion(payload) { return llmMock(payload); }
  },
}));
vi.mock('../../srv/lib/chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: (...a) => settingsMock(...a),
}));

const { classify } = await import('../../srv/lib/relevance-classifier.js');

const RELEVANT_VEC = new Float32Array([1, 0, 0]);
const NOT_VEC     = new Float32Array([0, 1, 0]);
const ITEM_VEC    = new Float32Array([1, 0, 0]);
const AMBIG_VEC   = new Float32Array([0.5, 0.5, 0]);

describe('relevance-classifier', () => {
  beforeEach(() => {
    seedMock.mockReset(); embedMock.mockReset();
    keywordMock.mockReset(); llmMock.mockReset(); settingsMock.mockReset();
    seedMock.mockResolvedValue({ relevant: [RELEVANT_VEC], notRelevant: [NOT_VEC] });
    settingsMock.mockResolvedValue({ deploymentId: 'dep-1', modelName: 'gpt-4o-mini' });
  });

  it('high positive margin → verdict "relevant", source "embedding"', async () => {
    embedMock.mockResolvedValue([ITEM_VEC]);
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.verdict).toBe('relevant');
    expect(r.source).toBe('embedding');
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(llmMock).not.toHaveBeenCalled();
  });

  it('high negative margin → verdict "not-relevant", source "embedding"', async () => {
    embedMock.mockResolvedValue([new Float32Array([0, 1, 0])]);
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.verdict).toBe('not-relevant');
    expect(r.source).toBe('embedding');
  });

  it('mid-band margin → LLM fallback', async () => {
    embedMock.mockResolvedValue([AMBIG_VEC]);
    llmMock.mockResolvedValue({
      getContent: () => JSON.stringify({ verdict: 'relevant', reason: 'discusses new API' }),
    });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('llm');
    expect(r.verdict).toBe('relevant');
    expect(r.reason).toBe('discusses new API');
    expect(r.model).toBe('dep-1');
  });

  it('LLM error → keyword fallback', async () => {
    embedMock.mockResolvedValue([AMBIG_VEC]);
    llmMock.mockRejectedValue(new Error('AI Core 503'));
    keywordMock.mockReturnValue({ verdict: 'not-relevant', reason: 'no allowlist' });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
    expect(r.verdict).toBe('not-relevant');
  });

  it('empty seeds (both arrays) → keyword fallback', async () => {
    seedMock.mockResolvedValue({ relevant: [], notRelevant: [] });
    keywordMock.mockReturnValue({ verdict: 'relevant', reason: 'matched CAP' });
    const r = await classify({ title: 'CAP', description: null, sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
    expect(r.verdict).toBe('relevant');
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('embedding call fails → keyword fallback', async () => {
    embedMock.mockRejectedValue(new Error('AI Core down'));
    keywordMock.mockReturnValue({ verdict: 'not-relevant', reason: '' });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
  });

  it('LLM returns malformed JSON → keyword fallback', async () => {
    embedMock.mockResolvedValue([AMBIG_VEC]);
    llmMock.mockResolvedValue({ getContent: () => 'not valid json' });
    keywordMock.mockReturnValue({ verdict: 'not-relevant', reason: '' });
    const r = await classify({ title: 't', description: 'd', sourceType: 'sap-news' });
    expect(r.source).toBe('fallback-keyword');
  });
});
