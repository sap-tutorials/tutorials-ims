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

  it('anchor is always null (Bug 5 workaround — see help-doc-extract.js comment)', async () => {
    // Claude 4.6 Sonnet refuses to call the tool when schema declares
    // anchor as `type: ['string', 'null']`. Anchor extraction removed
    // from schema + prompt; post-validation writes null unconditionally.
    // If future work reinstates anchor extraction (via sentinel string
    // or two-pass), update this test AND the schema simultaneously.
    const callModel = vi.fn().mockResolvedValue(llmFixture);
    const result = await extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts });
    for (const c of result.concepts) {
      expect(c.anchor).toBeNull();
    }
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
  // Schema is intentionally minimal per Bug 2 fix (2026-07-01): tight constraints
  // (slug pattern, name/desc length caps, confidence floor, anchor pattern) moved
  // into applyPostValidation because gpt-4o-mini structured-output was returning
  // empty tool calls when schema constraints rejected a single item. See
  // srv/lib/help-doc-extract.js comment block for rationale.

  it('schema does NOT declare anchor field (Bug 5 workaround)', () => {
    // Claude 4.6 Sonnet refuses to call the tool when a schema field uses
    // `type: ['string', 'null']`. Anchor removed from schema entirely;
    // cron writes null on HelpDocConceptLinks.anchor. Reinstate via a
    // Claude-friendly mechanism (sentinel string, or two-pass) when
    // anchor UX is a priority. See srv/lib/help-doc-extract.js comment.
    const props = KG_HELP_DOC_EXTRACT_SCHEMA.parameters.properties.concepts.items.properties;
    expect(props.anchor).toBeUndefined();
    // Sanity: the remaining fields are still there
    expect(props.slug).toBeDefined();
    expect(props.name).toBeDefined();
    expect(props.confidence).toBeDefined();
    expect(props.description).toBeDefined();
  });

  it('caps concepts array at 8 via post-validation (schema has no maxItems)', async () => {
    // Verify behavior end-to-end: LLM returns 10, filtered to 8.
    const ten = Array.from({ length: 10 }, (_, i) => ({
      slug: `slug-${i}`, name: `Concept ${i}`, description: 'x',
      confidence: 0.9, anchor: null,
    }));
    const callModel = vi.fn().mockResolvedValue({
      verdict: { concepts: ten },
      tokenUsage: { prompt: 100, completion: 10 },
    });
    const result = await extractConceptsFromHelpDoc({
      callModel,
      helpDoc: {
        title: 't', description: 'd', source: 'cap-cloud-sap',
        product: 'cap', section: null, url: 'https://x/y',
      },
      nearestConcepts: [],
    });
    expect(result.concepts).toHaveLength(8);
  });

  it('enforces floor 0.7 on confidence via post-validation (schema accepts 0-1)', async () => {
    // Confidence floor lives in post-validation. Schema accepts 0-1 broadly
    // (so a single-below-floor concept doesn't crash the tool call).
    const confSpec = KG_HELP_DOC_EXTRACT_SCHEMA.parameters.properties.concepts.items.properties.confidence;
    expect(confSpec.minimum).toBe(0);
    expect(confSpec.maximum).toBe(1);
    // End-to-end: a below-floor entry is dropped.
    const callModel = vi.fn().mockResolvedValue({
      verdict: { concepts: [
        { slug: 'below', name: 'Below', description: 'x', confidence: 0.5, anchor: null },
        { slug: 'above', name: 'Above', description: 'x', confidence: 0.85, anchor: null },
      ]},
      tokenUsage: { prompt: 100, completion: 10 },
    });
    const result = await extractConceptsFromHelpDoc({
      callModel,
      helpDoc: {
        title: 't', description: 'd', source: 'cap-cloud-sap',
        product: 'cap', section: null, url: 'https://x/y',
      },
      nearestConcepts: [],
    });
    expect(result.concepts.map(c => c.slug)).toEqual(['above']);
  });
});
