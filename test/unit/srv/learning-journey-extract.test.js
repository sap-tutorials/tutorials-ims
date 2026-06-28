// test/unit/srv/learning-journey-extract.test.js
//
// Phase 4.1 (#447): unit tests for the LLM extraction adapter.
// Tests post-LLM validation rules: confidence floors, length caps,
// slug-existence check, self-reference guard.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractConceptsFromLearningJourney } from '../../../srv/lib/learning-journey-extract.js';

const FIXTURE = JSON.parse(readFileSync(
  join(import.meta.dirname, '__fixtures__/learning-journey-llm-extract.json'),
  'utf8'
));

const journey = {
  slug: 'this-journey-self-reference',
  title: 'Test Journey',
  level: 'INTERMEDIATE',
  durationHours: '7.25',
  url: 'https://learning.sap.com/learning-journeys/test',
};

const body = 'A test journey body discussing CAP and CDS.';
const bodySource = 'readability';

const nearestConcepts = [
  { slug: 'cap-service-handlers', name: 'CAP service handlers', description: 'Event handlers in CAP' },
  { slug: 'cds-modeling', name: 'CDS modeling', description: 'Defining entities' },
  { slug: 'hana-cloud-integration', name: 'HANA Cloud integration', description: 'Cloud DB' },
  { slug: 'btp-deployment', name: 'BTP deployment', description: 'Deploy to BTP' },
];

const prereqCandidates = [
  { slug: 'btp-fundamentals', title: 'BTP Fundamentals', level: 'BEGINNER' },
  { slug: 'low-confidence-prereq', title: 'Low Confidence', level: 'BEGINNER' },
];

const existingJourneySlugs = new Set(['btp-fundamentals', 'cap-getting-started']);

describe('extractConceptsFromLearningJourney', () => {
  it('returns covers + journeyPrerequisites from LLM verdict', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromLearningJourney({
      callModel,
      journey,
      body,
      bodySource,
      nearestConcepts,
      prereqCandidates,
      existingJourneySlugs,
    });
    expect(result.covers.length).toBeGreaterThan(0);
    expect(result.journeyPrerequisites.length).toBeGreaterThan(0);
  });

  it('drops covers below 0.6 confidence', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromLearningJourney({
      callModel, journey, body, bodySource, nearestConcepts, prereqCandidates, existingJourneySlugs,
    });
    const slugs = result.covers.map(c => c.slug);
    expect(slugs).not.toContain('low-confidence-concept');  // 0.45 < 0.6
  });

  it('drops prerequisites below 0.7 confidence', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromLearningJourney({
      callModel, journey, body, bodySource, nearestConcepts, prereqCandidates, existingJourneySlugs,
    });
    const slugs = result.journeyPrerequisites.map(p => p.slug);
    expect(slugs).not.toContain('low-confidence-prereq');  // 0.55 < 0.7
  });

  it('drops prerequisites where slug does not exist in registry', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: {
        covers: [],
        journeyPrerequisites: [
          { slug: 'hallucinated-slug', reason: 'fake', confidence: 0.9 },
        ],
      },
    });
    const result = await extractConceptsFromLearningJourney({
      callModel, journey, body, bodySource, nearestConcepts, prereqCandidates, existingJourneySlugs,
    });
    expect(result.journeyPrerequisites).toHaveLength(0);
  });

  it('drops self-reference prerequisites', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromLearningJourney({
      callModel, journey, body, bodySource, nearestConcepts, prereqCandidates, existingJourneySlugs,
    });
    const slugs = result.journeyPrerequisites.map(p => p.slug);
    expect(slugs).not.toContain('this-journey-self-reference');
  });

  it('caps covers at 8 by descending confidence', async () => {
    const verdict = {
      covers: Array.from({ length: 20 }, (_, i) => ({
        slug: `concept-${i}`, confidence: 0.6 + i * 0.01,
      })),
      journeyPrerequisites: [],
    };
    const callModel = vi.fn().mockResolvedValue({ verdict });
    const result = await extractConceptsFromLearningJourney({
      callModel, journey, body, bodySource, nearestConcepts, prereqCandidates, existingJourneySlugs,
    });
    expect(result.covers.length).toBeLessThanOrEqual(8);
    // Highest confidence first
    expect(result.covers[0].confidence).toBeGreaterThan(result.covers[7].confidence);
  });
});
