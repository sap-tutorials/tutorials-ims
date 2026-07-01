import { describe, it, expect, vi } from 'vitest';
import {
  extractConceptsFromHelpDoc,
  KG_HELP_DOC_EXTRACT_SCHEMA,
} from '../../../srv/lib/help-doc-extract.js';
import llmFixture from './__fixtures__/help-doc-llm-extract.json' assert { type: 'json' };

describe('help-doc-extract', () => {
  const helpDoc = {
    title: 'Handlers',
    description: 'Register handlers that fire before/on/after CRUD ops. Section: before-create handlers...',
    source: 'cap-cloud-sap',
    product: 'cap',
    section: null,
    url: 'https://cap.cloud.sap/docs/node.js/handlers',
  };
  const nearestConcepts = [
    { slug: 'cap-service-handlers', name: 'CAP service handlers' },
    { slug: 'cap-cds-modeling', name: 'CAP CDS modeling' },
  ];

  it('extracts concepts above floor 0.7 with valid names', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts });
    expect(result.concepts).toHaveLength(3);
    expect(result.concepts.map(c => c.slug)).toEqual([
      'cap-service-handlers',
      'cap-cds-modeling',
      'cap-drafts',
    ]);
  });

  it('preserves anchor when non-null; passes null through unchanged', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts });
    const handlers = result.concepts.find(c => c.slug === 'cap-service-handlers');
    const modeling = result.concepts.find(c => c.slug === 'cap-cds-modeling');
    expect(handlers.anchor).toBe('before-create');
    expect(modeling.anchor).toBeNull();
  });

  it('rejects concepts below floor 0.7', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts });
    expect(result.concepts.find(c => c.slug === 'low-confidence-concept')).toBeUndefined();
  });

  it('rejects concepts with name length < 2', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts });
    expect(result.concepts.find(c => c.slug === 'x')).toBeUndefined();
  });

  it('caps at 8 concepts when LLM returns more', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      slug: `slug-${i}`,
      name: `Concept ${i}`,
      description: `desc ${i}`,
      confidence: 0.9,
      anchor: null,
    }));
    const callModel = vi.fn().mockResolvedValue({
      verdict: { concepts: ten },
      tokenUsage: { prompt: 100, completion: 10 },
    });
    const result = await extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts });
    expect(result.concepts).toHaveLength(8);
  });

  it('passes K=25 registry hint through the prompt', async () => {
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const bigRegistry = Array.from({ length: 40 }, (_, i) => ({ slug: `s${i}`, name: `N${i}` }));
    await extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts: bigRegistry });
    // Verify the prompt actually rendered 25 entries (K cap)
    const promptArg = callModel.mock.calls[0][0];
    const userPrompt = promptArg.user ?? promptArg.messages?.[1]?.content ?? '';
    const registryLines = userPrompt.split('\n').filter(l => l.trim().startsWith('- '));
    expect(registryLines.length).toBeLessThanOrEqual(25);
    expect(registryLines.length).toBeGreaterThanOrEqual(20);
  });
});

describe('KG_HELP_DOC_EXTRACT_SCHEMA', () => {
  it('declares optional anchor field (nullable string)', () => {
    const anchorSpec = KG_HELP_DOC_EXTRACT_SCHEMA.parameters.properties.concepts.items.properties.anchor;
    expect(anchorSpec).toBeDefined();
    // anchor may be null OR a slug-format string
    expect(anchorSpec.type).toEqual(['string', 'null']);
    expect(anchorSpec.pattern).toBe('^[a-z0-9-]+$');
  });

  it('caps concepts array at 8', () => {
    expect(KG_HELP_DOC_EXTRACT_SCHEMA.parameters.properties.concepts.maxItems).toBe(8);
  });

  it('enforces floor 0.7 on confidence', () => {
    const confSpec = KG_HELP_DOC_EXTRACT_SCHEMA.parameters.properties.concepts.items.properties.confidence;
    expect(confSpec.minimum).toBe(0.7);
  });
});
