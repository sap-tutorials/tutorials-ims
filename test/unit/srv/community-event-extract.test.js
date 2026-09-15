// test/unit/srv/community-event-extract.test.js
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConceptsFromCommunityEvent } from '../../../srv/lib/community-event-extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'community-event-llm-extract.json'), 'utf8'));

// Stub the REAL defaultCallModel RETURN SHAPE (srv/lib/code-check-llm.js):
//   { verdict, promptTokens, completionTokens, modelName }
// NOT a fabricated Anthropic `{ content:[...], usage:{...} }` shape. The prod
// bug (community-event KG concepts = 0) shipped precisely because the earlier
// test stubbed the wrong boundary; this stub must match what defaultCallModel
// actually returns so the extractor is exercised against the real contract.
const stubCallModel = () => vi.fn(async () => ({
  verdict: fixture.verdict,
  promptTokens: fixture.tokenUsage.prompt,
  completionTokens: fixture.tokenUsage.completion,
  modelName: 'anthropic--claude-4.6-sonnet',
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
  // Crux regression: with the real defaultCallModel return shape, valid
  // concepts must actually come back. FAILS against the pre-fix extractor
  // (which read response.content off a shape that has none → concepts=[]).
  it('returns concepts from the verdict of a real defaultCallModel-shaped response', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts: [], callModel });
    const slugs = result.concepts.map(c => c.slug);
    expect(result.concepts.length).toBeGreaterThan(0);
    expect(slugs).toContain('cap-cds-modeling');
    expect(slugs).toContain('generative-ai-hub');
    expect(slugs).toContain('cap-service-handlers');
  });

  // Contract regression: callModel must be invoked with a `user` STRING and an
  // explicit `schema`, NOT a `messages` array. FAILS against the pre-fix code
  // (which passed { system, messages, max_tokens } and no schema).
  it('invokes callModel with the { system, user, schema } contract', async () => {
    const callModel = stubCallModel();
    await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts: [], callModel });
    const arg = callModel.mock.calls[0][0];
    expect(typeof arg.user).toBe('string');
    expect(arg.user).toContain('Event title:');
    expect(arg.schema).toBeDefined();
    expect(arg.schema.properties.concepts).toBeDefined();
    expect(arg.messages).toBeUndefined();
  });

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
    const callModel = vi.fn(async () => ({ verdict: many, promptTokens: 100, completionTokens: 50 }));
    const result = await extractConceptsFromCommunityEvent({ event: eventRow, nearestConcepts: [], callModel });
    expect(result.concepts.length).toBeLessThanOrEqual(6);
  });

  it('passes K=15 registry hints to the LLM prompt', async () => {
    const callModel = stubCallModel();
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
