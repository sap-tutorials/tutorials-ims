// test/lib/ai-challenge-spec.test.js
//
// RESEARCH SPIKE (#2362) — proves the json-render challenge generator:
// generation from a fake model, catalog enforcement, cross-field validation,
// and the anti-leak contract (reference answers never ship in the public spec).
import { describe, it, expect } from 'vitest';
import { generateChallengeSpec, CATALOG } from '../../srv/lib/ai-challenge-spec.js';

// Fake callModel: returns whatever nodes the test hands it as a forced tool call.
function fakeModel(nodes) {
  return async () => ({
    toolCalls: [{ arguments: JSON.stringify({ nodes }) }],
    modelName: 'fake',
    promptTokens: 1,
    completionTokens: 1,
  });
}

const base = { stepBody: 'Create a CAP service with a Books entity.', stepNumber: 2, slug: 's' };

describe('ai-challenge-spec', () => {
  it('emits a public spec of catalog nodes with stable ids', async () => {
    const res = await generateChallengeSpec({
      ...base,
      deps: { callModel: fakeModel([
        { type: 'heading', text: 'Check your understanding' },
        { type: 'prose', text: 'A short scenario about CAP services.' },
        { type: 'mcq', prompt: 'Which file defines a CAP entity?', options: ['a.cds', 'b.js', 'c.json', 'd.yaml'], answerIndex: 0 },
      ]) },
    });
    expect(res.errorReason).toBeUndefined();
    expect(res.spec.nodes.map((n) => n.type)).toEqual(['heading', 'prose', 'mcq']);
    expect(res.spec.nodes.every((n) => n.id.startsWith('challenge-2-'))).toBe(true);
    // Every emitted type is in the catalog.
    expect(res.spec.nodes.every((n) => CATALOG[n.type])).toBe(true);
  });

  it('ANTI-LEAK: freeText reference answer is stripped from the public spec', async () => {
    const res = await generateChallengeSpec({
      ...base,
      deps: { callModel: fakeModel([
        { type: 'freeText', prompt: 'Explain what a CAP service exposes.', reference: 'It exposes entities and actions over OData.' },
      ]) },
    });
    const publicJson = JSON.stringify(res.spec);
    expect(publicJson).not.toContain('OData'); // reference text absent from public spec
    expect(res.spec.nodes[0]).not.toHaveProperty('reference');
    expect(res.spec.nodes[0].aiGraded).toBe(true);
    // ...but it IS returned separately for the server-only sidecar.
    expect(res.referenceAnswers).toEqual([
      { nodeId: 'challenge-2-1', reference: 'It exposes entities and actions over OData.' },
    ]);
  });

  it('rejects an unknown node type (catalog guard)', async () => {
    const res = await generateChallengeSpec({
      ...base,
      deps: { callModel: fakeModel([{ type: 'iframe', text: '<script>' }]) },
    });
    expect(res.spec).toBeNull();
    expect(res.errorReason).toBe('unknown_node_type');
  });

  it('rejects an mcq whose answerIndex is out of range', async () => {
    const res = await generateChallengeSpec({
      ...base,
      deps: { callModel: fakeModel([
        { type: 'mcq', prompt: 'Pick one', options: ['a', 'b', 'c', 'd'], answerIndex: 9 },
      ]) },
    });
    expect(res.errorReason).toBe('mcq_answer_out_of_range');
  });

  it('rejects a leak where the prompt contains the correct answer', async () => {
    const res = await generateChallengeSpec({
      ...base,
      deps: { callModel: fakeModel([
        { type: 'mcq', prompt: 'The answer is a.cds — which file?', options: ['a.cds', 'b', 'c', 'd'], answerIndex: 0 },
      ]) },
    });
    expect(res.errorReason).toBe('leak_detected');
  });

  it('fails soft on an upstream model error', async () => {
    const res = await generateChallengeSpec({
      ...base,
      deps: { callModel: async () => { throw new Error('boom'); } },
    });
    expect(res.spec).toBeNull();
    expect(res.errorReason).toBe('upstream');
  });
});
