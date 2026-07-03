// test/unit/srv/community-event-extract.test.js
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConceptsFromCommunityEvent } from '../../../srv/lib/community-event-extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'community-event-llm-extract.json'), 'utf8'));

const stubCallModel = () => vi.fn(async () => ({
  content: [{ type: 'text', text: JSON.stringify(fixture.verdict) }],
  usage: { input_tokens: fixture.tokenUsage.prompt, output_tokens: fixture.tokenUsage.completion },
}));

const eventRow = {
  title: 'Build AI services using SAP CAP (Bengaluru, India)',
  description: 'Hands-on codejam covering CAP and Gen-AI Hub.',
  eventType: 'codejam',
  location: 'Bengaluru, India',
  scope: 'local',
  startDate: '2027-01-15',
  url: 'https://community.sap.com/t5/sap-codejam/...',
};

describe('extractConceptsFromCommunityEvent', () => {
  it('filters concepts below 0.7 confidence', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts: [], callModel });
    expect(result.concepts.map(c => c.slug)).not.toContain('low-conf');
  });

  it('filters concepts with names shorter than 2 chars', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts: [], callModel });
    expect(result.concepts.map(c => c.slug)).not.toContain('x');
  });

  it('caps at 6 concepts', async () => {
    // Build a verdict with 10 valid concepts
    const many = { concepts: Array.from({ length: 10 }, (_, i) => ({ slug: `c${i}`, name: `Concept ${i}`, description: 'ok', confidence: 0.9 })) };
    const callModel = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(many) }], usage: { input_tokens: 100, output_tokens: 50 } }));
    const result = await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts: [], callModel });
    expect(result.concepts.length).toBeLessThanOrEqual(6);
  });

  it('passes K=15 registry hints to the LLM prompt', async () => {
    const callModel = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(fixture.verdict) }], usage: { input_tokens: 100, output_tokens: 50 } }));
    const nearestConcepts = Array.from({ length: 15 }, (_, i) => ({ slug: `k${i}`, name: `K ${i}` }));
    await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts, callModel });
    const promptStr = JSON.stringify(callModel.mock.calls[0][0]);
    expect(promptStr).toContain('k0');
    expect(promptStr).toContain('k14');
  });

  it('surfaces token usage on the result', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts: [], callModel });
    expect(result.promptTokens).toBe(fixture.tokenUsage.prompt);
    expect(result.completionTokens).toBe(fixture.tokenUsage.completion);
  });
});
