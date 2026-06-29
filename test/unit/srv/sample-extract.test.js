import { describe, it, expect, vi } from 'vitest';
import { extractConceptsFromSample } from '../../../srv/lib/sample-extract.js';
import llmFixture from './__fixtures__/sample-llm-extract.json' assert { type: 'json' };

describe('sample-extract', () => {
  const sampleInput = {
    title: 'cloud-cap-samples',
    description: 'Samples for CAP — CDS modeling, service handlers, OData v4...',
    language: 'JavaScript',
    topics: ['cap', 'cds'],
    registry: [
      { slug: 'cap-service-handlers', name: 'CAP service handlers' },
      { slug: 'cap-cds-modeling', name: 'CAP CDS modeling' },
    ],
  };

  it('extracts concepts above floor 0.7 with valid names', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromSample({ ...sampleInput, callModel });
    expect(result.concepts).toHaveLength(2);
    expect(result.concepts.map(c => c.slug)).toEqual(['cap-service-handlers', 'cap-cds-modeling']);
  });

  it('rejects concepts below floor 0.7', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromSample({ ...sampleInput, callModel });
    expect(result.concepts.find(c => c.slug === 'low-confidence-concept')).toBeUndefined();
  });

  it('rejects concepts with name length < 2', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromSample({ ...sampleInput, callModel });
    expect(result.concepts.find(c => c.slug === 'x')).toBeUndefined();
  });

  it('caps at 6 concepts when LLM returns more', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      slug: `slug-${i}`, name: `Concept ${i}`, confidence: 0.9,
    }));
    const callModel = vi.fn().mockResolvedValue({
      verdict: { embodies: eight },
      tokenUsage: { prompt: 100, completion: 10 },
    });
    const result = await extractConceptsFromSample({ ...sampleInput, callModel });
    expect(result.concepts).toHaveLength(6);
  });

  it('returns token usage', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromSample({ ...sampleInput, callModel });
    expect(result.promptTokens).toBe(2400);
    expect(result.completionTokens).toBe(220);
  });
});
