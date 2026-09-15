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

const stubCallModel = () => vi.fn(async () => ({
  content: [{ type: 'text', text: JSON.stringify(verdict) }],
  usage: { input_tokens: 120, output_tokens: 40 },
}));

describe('extractConceptsFromDevtoberfestSession', () => {
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

  it('keeps valid concepts and lowercases slugs', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.concepts.map((c) => c.slug)).toEqual(['sap-cap', 'gen-ai-hub']);
  });

  it('caps at 6 concepts', async () => {
    const many = { concepts: Array.from({ length: 10 }, (_, i) => ({ slug: `c${i}`, name: `Concept ${i}`, description: 'ok', confidence: 0.9 })) };
    const callModel = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(many) }], usage: { input_tokens: 100, output_tokens: 50 } }));
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.concepts.length).toBeLessThanOrEqual(6);
  });

  it('includes speaker + linked tutorial in the prompt and passes K=15 hints', async () => {
    const callModel = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(verdict) }], usage: { input_tokens: 100, output_tokens: 50 } }));
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

  it('returns empty on unparseable model output', async () => {
    const callModel = vi.fn(async () => ({ content: [{ type: 'text', text: 'not json' }], usage: {} }));
    const result = await extractConceptsFromDevtoberfestSession({ session, nearestConcepts: [], callModel });
    expect(result.concepts).toEqual([]);
  });
});
