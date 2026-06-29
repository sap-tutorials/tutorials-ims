// test/unit/srv/video-extract.test.js
//
// Phase 4.4 (#447) PR-2: tests for LLM extraction adapter on YouTube videos.
//
// Mirrors test/unit/srv/discovery-mission-extract.test.js with two
// substitutions: mission → video, usesServices → featuresService.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractConceptsFromVideo } from '../../../srv/lib/video-extract.js';

const FIXTURE = JSON.parse(readFileSync(
  join(import.meta.dirname, '__fixtures__/video-llm-extract.json'),
  'utf8',
));

const video = {
  slug: 'vd-dQw4w9WgXcQ',
  title: 'Get Started with SAP Build Apps — Developer News',
  description: 'In this episode we cover SAP Build Apps, SAP Integration Suite, and HANA Cloud.',
  publishedAt: '2026-06-01T10:00:00Z',
  channelTitle: 'SAP Developers',
};

const nearestConcepts = [
  { slug: 'cap-service-handlers', name: 'CAP service handlers', description: 'Event handlers' },
  { slug: 'cds-modeling', name: 'CDS modeling', description: 'Defining entities' },
];

describe('extractConceptsFromVideo', () => {
  it('applies confidence floor 0.6 for teaches (filters low-conf)', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromVideo({
      callModel, video, nearestConcepts,
    });
    const slugs = result.teaches.map(t => t.slug);
    expect(slugs).not.toContain('low-confidence-concept');
  });

  it('drops teaches missing the name field', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromVideo({
      callModel, video, nearestConcepts,
    });
    expect(result.teaches.some(t => t.slug === 'no-name')).toBe(false);
  });

  it('applies confidence floor 0.7 for featuresService (higher than teaches)', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromVideo({
      callModel, video, nearestConcepts,
    });
    const names = result.featuresService.map(s => s.name);
    expect(names).not.toContain('weak-service');
  });

  it('drops featuresService with name length < 2 chars', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromVideo({
      callModel, video, nearestConcepts,
    });
    expect(result.featuresService.some(s => s.name === 'X')).toBe(false);
  });

  it('caps teaches at 8 sorted by descending confidence', async () => {
    const verdict = {
      teaches: Array.from({ length: 12 }, (_, i) => ({
        slug: `concept-${i}`, name: `Concept ${i}`, confidence: 0.6 + i * 0.01,
      })),
      featuresService: [],
    };
    const callModel = vi.fn().mockResolvedValue({ verdict });
    const result = await extractConceptsFromVideo({
      callModel, video, nearestConcepts,
    });
    expect(result.teaches.length).toBeLessThanOrEqual(8);
    expect(result.teaches[0].confidence).toBeGreaterThan(result.teaches[7].confidence);
  });

  it('caps featuresService at 5 sorted by descending confidence', async () => {
    const verdict = {
      teaches: [],
      featuresService: Array.from({ length: 8 }, (_, i) => ({
        name: `Service ${i}`, confidence: 0.7 + i * 0.01,
      })),
    };
    const callModel = vi.fn().mockResolvedValue({ verdict });
    const result = await extractConceptsFromVideo({
      callModel, video, nearestConcepts,
    });
    expect(result.featuresService.length).toBeLessThanOrEqual(5);
  });

  it('emits 4 valid teaches + 3 valid services from the fixture', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromVideo({
      callModel, video, nearestConcepts,
    });
    expect(result.teaches).toHaveLength(4);
    expect(result.featuresService).toHaveLength(3);
  });
});
