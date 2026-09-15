// test/unit/srv/devtoberfest-session-extract.test.js
import { describe, it, expect, vi } from 'vitest';
import { extractConceptsFromDevtoberfestSession } from '../../../srv/lib/devtoberfest-session-extract.js';

const session = {
  title: 'Build AI services using SAP CAP',
  description: 'Hands-on session covering CAP and the SAP Generative AI Hub.',
  speakerNames: 'Ada Lovelace, Alan Turing',
  activityTaskSlug: 'cap-genai-hub',
};

// A verdict mixing valid + should-be-filtered concepts.
const verdict = {
  concepts: [
    { slug: 'sap-cap', name: 'SAP CAP', description: 'CAP framework', confidence: 0.95 },
    { slug: 'gen-ai-hub', name: 'Generative AI Hub', description: 'AI Hub', confidence: 0.82 },
    { slug: 'low-conf', name: 'Low Confidence', description: 'drop me', confidence: 0.4 },
    { slug: 'x', name: 'x', description: 'too short', confidence: 0.9 },
  ],
};

// Stub the REAL defaultCallModel RETURN SHAPE (srv/lib/code-check-llm.js):
//   { verdict, promptTokens, completionTokens, modelName }
// NOT a fabricated Anthropic `{ content:[...], usage:{...} }` shape. This clone
// inherited the same callModel-contract bug (silent 0 concepts in prod); the
// stub must match what defaultCallModel actually returns.
const stubCallModel = () => vi.fn(async () => ({
  verdict,
  promptTokens: 120,
  completionTokens: 40,
  modelName: 'anthropic--claude-4.6-sonnet',
}));

describe('extractConceptsFromDevtoberfestSession', () => {
  it('keeps valid concepts and lowercases slugs (real defaultCallModel shape)', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    // FAILS pre-fix: old extractor read response.content (undefined) → [].
    expect(result.concepts.map((c) => c.slug)).toEqual(['sap-cap', 'gen-ai-hub']);
  });

  it('invokes callModel with the { system, user, schema } contract', async () => {
    const callModel = stubCallModel();
    await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    const arg = callModel.mock.calls[0][0];
    expect(typeof arg.user).toBe('string');
    expect(arg.user).toContain('Session title:');
    expect(arg.schema).toBeDefined();
    expect(arg.schema.properties.concepts).toBeDefined();
    expect(arg.messages).toBeUndefined();
  });

  it('filters concepts below 0.7 confidence', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.concepts.map((c) => c.slug)).not.toContain('low-conf');
  });

  it('filters concepts with names shorter than 2 chars', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.concepts.map((c) => c.slug)).not.toContain('x');
  });

  it('caps at 6 concepts', async () => {
    const many = { concepts: Array.from({ length: 10 }, (_, i) => ({ slug: `c${i}`, name: `Concept ${i}`, description: 'ok', confidence: 0.9 })) };
    const callModel = vi.fn(async () => ({ verdict: many, promptTokens: 100, completionTokens: 50 }));
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.concepts.length).toBeLessThanOrEqual(6);
  });

  it('includes speaker + linked tutorial in the prompt and passes K=15 hints', async () => {
    const callModel = stubCallModel();
    const nearestConcepts = Array.from({ length: 15 }, (_, i) => ({ slug: `k${i}`, name: `K ${i}` }));
    await extractConceptsFromDevtoberfestSession({ session, nearestConcepts, callModel });
    const promptStr = JSON.stringify(callModel.mock.calls[0][0]);
    expect(promptStr).toContain('Ada Lovelace');
    expect(promptStr).toContain('cap-genai-hub');
    expect(promptStr).toContain('k0');
    expect(promptStr).toContain('k14');
  });

  it('surfaces token usage on the result', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.promptTokens).toBe(120);
    expect(result.completionTokens).toBe(40);
  });

  it('returns empty when the verdict carries no concepts array', async () => {
    const callModel = vi.fn(async () => ({ verdict: {}, promptTokens: 0, completionTokens: 0 }));
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.concepts).toEqual([]);
  });

  it('throws loudly if handed a legacy raw-chat-completion shape (contract tripwire)', async () => {
    // Regression guard: the exact broken shape that shipped 0 concepts.
    const callModel = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }], usage: {} }));
    await expect(
      extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel })
    ).rejects.toThrow(/raw chat completion/);
  });
});
