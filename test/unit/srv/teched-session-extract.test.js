// test/unit/srv/teched-session-extract.test.js
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConceptsFromTechEdSession } from '../../../srv/lib/teched-session-extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Reuse the community-event verdict fixture — the covers-schema shape is shared.
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'community-event-llm-extract.json'), 'utf8'));

// Stub the REAL defaultCallModel RETURN SHAPE (see community-event-extract.test.js).
// The TechEd extractor was cloned from community-event-extract and inherited the
// same callModel-contract bug; this asserts the fix on the clone too.
const stubCallModel = () => vi.fn(async () => ({
  verdict: fixture.verdict,
  promptTokens: fixture.tokenUsage.prompt,
  completionTokens: fixture.tokenUsage.completion,
  modelName: 'anthropic--claude-4.6-sonnet',
}));

const sessionRow = {
  title: 'Extending SAP with CAP and Generative AI',
  description: 'Learn to build AI-powered services on BTP with the CAP model.',
  track: 'Application Development & Integration',
  speakerNames: 'Jane Doe, John Smith',
};

describe('extractConceptsFromTechEdSession', () => {
  it('returns concepts from the verdict of a real defaultCallModel-shaped response', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromTechEdSession({ session: sessionRow, nearestConcepts: [], callModel });
    const slugs = result.concepts.map(c => c.slug);
    expect(result.concepts.length).toBeGreaterThan(0);
    expect(slugs).toContain('cap-cds-modeling');
    expect(slugs).toContain('generative-ai-hub');
    expect(slugs).toContain('cap-service-handlers');
  });

  it('invokes callModel with the { system, user, schema } contract', async () => {
    const callModel = stubCallModel();
    await extractConceptsFromTechEdSession({ session: sessionRow, nearestConcepts: [], callModel });
    const arg = callModel.mock.calls[0][0];
    expect(typeof arg.user).toBe('string');
    expect(arg.user).toContain('Session title:');
    expect(arg.schema).toBeDefined();
    expect(arg.schema.properties.concepts).toBeDefined();
    expect(arg.messages).toBeUndefined();
  });

  it('renders track and speakers into the prompt', async () => {
    const callModel = stubCallModel();
    await extractConceptsFromTechEdSession({ session: sessionRow, nearestConcepts: [], callModel });
    const user = callModel.mock.calls[0][0].user;
    expect(user).toContain('Track: Application Development & Integration');
    expect(user).toContain('Speaker(s): Jane Doe, John Smith');
  });

  it('filters concepts below 0.7 confidence and short names', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromTechEdSession({ session: sessionRow, nearestConcepts: [], callModel });
    const slugs = result.concepts.map(c => c.slug);
    expect(slugs).not.toContain('low-conf');
    expect(slugs).not.toContain('x');
  });

  it('caps at 6 concepts', async () => {
    const many = { concepts: Array.from({ length: 10 }, (_, i) => ({ slug: `c${i}`, name: `Concept ${i}`, description: 'ok', confidence: 0.9 })) };
    const callModel = vi.fn(async () => ({ verdict: many, promptTokens: 100, completionTokens: 50 }));
    const result = await extractConceptsFromTechEdSession({ session: sessionRow, nearestConcepts: [], callModel });
    expect(result.concepts.length).toBeLessThanOrEqual(6);
  });

  it('passes K=15 registry hints to the LLM prompt', async () => {
    const callModel = stubCallModel();
    const nearestConcepts = Array.from({ length: 15 }, (_, i) => ({ slug: `k${i}`, name: `K ${i}` }));
    await extractConceptsFromTechEdSession({ session: sessionRow, nearestConcepts, callModel });
    const promptStr = JSON.stringify(callModel.mock.calls[0][0]);
    expect(promptStr).toContain('k0');
    expect(promptStr).toContain('k14');
  });

  it('surfaces token usage on the result', async () => {
    const callModel = stubCallModel();
    const result = await extractConceptsFromTechEdSession({ session: sessionRow, nearestConcepts: [], callModel });
    expect(result.promptTokens).toBe(fixture.tokenUsage.prompt);
    expect(result.completionTokens).toBe(fixture.tokenUsage.completion);
  });
});
