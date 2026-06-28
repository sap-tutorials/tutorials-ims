// test/unit/srv/blog-post-extract.test.js
//
// Phase 4.2 (#447): unit tests for the blog-post extraction adapter.
// Tests post-LLM validation rules: confidence floor 0.6, cap 6 covers,
// name-required (merge-on-write contract), body truncation to 8000 chars.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractConceptsFromBlogPost } from '../../../srv/lib/blog-post-extract.js';

const FIXTURE = JSON.parse(readFileSync(
  join(import.meta.dirname, '__fixtures__/blog-post-llm-extract.json'),
  'utf8',
));

const post = {
  slug: 'bp-13412493',
  title: 'CAP Service Handlers — A Practical Walkthrough',
  authorLogin: 'test.author.one',
  postedAt: '2026-05-15T09:32:11.000Z',
};
const body = '<p>In this post we explore CAP service handlers...</p>'.repeat(20);
const nearestConcepts = [
  { slug: 'cap-service-handlers', name: 'CAP service handlers', description: 'Event handlers in CAP' },
  { slug: 'cds-modeling', name: 'CDS modeling', description: 'Defining entities' },
];

describe('extractConceptsFromBlogPost', () => {
  it('applies confidence floor 0.6 (filters low-conf)', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromBlogPost({
      callModel, post, body, nearestConcepts,
    });
    const slugs = result.discusses.map(d => d.slug);
    expect(slugs).not.toContain('low-confidence-concept');
  });

  it('drops covers missing the name field (cannot embed without it)', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromBlogPost({
      callModel, post, body, nearestConcepts,
    });
    expect(result.discusses.some(d => d.slug === 'no-name')).toBe(false);
  });

  it('caps at 6 covers, sorted by descending confidence', async () => {
    const verdict = {
      discusses: Array.from({ length: 12 }, (_, i) => ({
        slug: `concept-${i}`, name: `Concept ${i}`, confidence: 0.6 + i * 0.01,
      })),
    };
    const callModel = vi.fn().mockResolvedValue({ verdict });
    const result = await extractConceptsFromBlogPost({
      callModel, post, body, nearestConcepts,
    });
    expect(result.discusses.length).toBeLessThanOrEqual(6);
    expect(result.discusses[0].confidence).toBeGreaterThan(result.discusses[5].confidence);
  });

  it('truncates body to 8000 chars in the LLM prompt', async () => {
    const longBody = 'x'.repeat(20000);
    let capturedUser;
    const callModel = vi.fn(async ({ user }) => {
      capturedUser = user;
      return FIXTURE;
    });
    await extractConceptsFromBlogPost({
      callModel, post, body: longBody, nearestConcepts,
    });
    // The 8000-char body cap should be reflected in the prompt length.
    expect(capturedUser.length).toBeLessThan(12000);  // 8000 + prompt scaffolding
  });

  it('emits 4 valid covers from the fixture (above-floor + named)', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromBlogPost({
      callModel, post, body, nearestConcepts,
    });
    expect(result.discusses).toHaveLength(4);
    expect(result.discusses.map(d => d.slug).sort()).toEqual([
      'another-valid', 'cap-service-handlers', 'cds-modeling', 'valid-novel',
    ]);
  });
});
