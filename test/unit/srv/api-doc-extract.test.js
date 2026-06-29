import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractConceptsFromApiDoc } from '../../../srv/lib/api-doc-extract.js';

const llmFixture = JSON.parse(readFileSync(
  join(import.meta.dirname, '__fixtures__/api-doc-llm-extract.json'),
  'utf8',
));

describe('api-doc-extract', () => {
  const sampleInput = {
    title: 'SAP CAP CQN Reference',
    description: 'Canonical reference for SAP CAP\'s Core Query Notation.',
    category: 'CAP',
    apiType: 'reference',
    registry: [
      { slug: 'cap-cqn', name: 'CAP Core Query Notation' },
      { slug: 'cap-cds', name: 'CAP CDS Modeling' },
    ],
  };

  it('extracts concepts above floor 0.7', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromApiDoc({ ...sampleInput, callModel });
    expect(result.concepts).toHaveLength(3);     // 5 - 1 low-conf - 1 no-name = 3
    expect(result.concepts.map(c => c.slug)).toEqual(['cap-cqn', 'cap-cds', 'odata-v4']);
  });

  it('rejects concepts below floor 0.7', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromApiDoc({ ...sampleInput, callModel });
    expect(result.concepts.find(c => c.slug === 'low-confidence')).toBeUndefined();
  });

  it('rejects concepts missing required name', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromApiDoc({ ...sampleInput, callModel });
    expect(result.concepts.find(c => c.slug === 'no-name')).toBeUndefined();
  });

  it('rejects concepts with name length < 2', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: { officialReferenceFor: [{ slug: 'x', name: 'X', confidence: 0.95 }] },
      tokenUsage: { prompt: 100, completion: 10 },
    });
    const result = await extractConceptsFromApiDoc({ ...sampleInput, callModel });
    expect(result.concepts).toHaveLength(0);
  });

  it('caps at 6 concepts when LLM returns more', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      slug: `slug-${i}`, name: `Concept ${i}`, confidence: 0.9,
    }));
    const callModel = vi.fn().mockResolvedValue({
      verdict: { officialReferenceFor: eight },
      tokenUsage: { prompt: 100, completion: 10 },
    });
    const result = await extractConceptsFromApiDoc({ ...sampleInput, callModel });
    expect(result.concepts).toHaveLength(6);
  });

  it('returns token usage from the LLM call', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromApiDoc({ ...sampleInput, callModel });
    expect(result.promptTokens).toBe(2400);
    expect(result.completionTokens).toBe(280);
  });
});
