import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractConceptsFromDiscoveryMission } from '../../../srv/lib/discovery-mission-extract.js';

const FIXTURE = JSON.parse(readFileSync(
  join(import.meta.dirname, '__fixtures__/discovery-mission-llm-extract.json'),
  'utf8',
));

const mission = {
  slug: 'dm-3019',
  title: 'Get Started with SAP BTP Enterprise Account',
  description: 'Set up enterprise account, configure subaccounts, entitle services.',
  effortLevel: 2,
  categorySlug: 'onboard',
};

const nearestConcepts = [
  { slug: 'cap-service-handlers', name: 'CAP service handlers', description: 'Event handlers' },
  { slug: 'cds-modeling', name: 'CDS modeling', description: 'Defining entities' },
];

describe('extractConceptsFromDiscoveryMission', () => {
  it('applies confidence floor 0.6 for teaches (filters low-conf)', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromDiscoveryMission({
      callModel, mission, nearestConcepts,
    });
    const slugs = result.teaches.map(t => t.slug);
    expect(slugs).not.toContain('low-confidence-concept');
  });

  it('drops teaches missing the name field', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromDiscoveryMission({
      callModel, mission, nearestConcepts,
    });
    expect(result.teaches.some(t => t.slug === 'no-name')).toBe(false);
  });

  it('applies confidence floor 0.7 for usesServices (higher than teaches)', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromDiscoveryMission({
      callModel, mission, nearestConcepts,
    });
    const names = result.usesServices.map(s => s.name);
    expect(names).not.toContain('weak-service');
  });

  it('drops usesServices with name length < 2 chars', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromDiscoveryMission({
      callModel, mission, nearestConcepts,
    });
    expect(result.usesServices.some(s => s.name === 'X')).toBe(false);
  });

  it('caps teaches at 8 sorted by descending confidence', async () => {
    const verdict = {
      teaches: Array.from({ length: 12 }, (_, i) => ({
        slug: `concept-${i}`, name: `Concept ${i}`, confidence: 0.6 + i * 0.01,
      })),
      usesServices: [],
    };
    const callModel = vi.fn().mockResolvedValue({ verdict });
    const result = await extractConceptsFromDiscoveryMission({
      callModel, mission, nearestConcepts,
    });
    expect(result.teaches.length).toBeLessThanOrEqual(8);
    expect(result.teaches[0].confidence).toBeGreaterThan(result.teaches[7].confidence);
  });

  it('caps usesServices at 5 sorted by descending confidence', async () => {
    const verdict = {
      teaches: [],
      usesServices: Array.from({ length: 8 }, (_, i) => ({
        name: `Service ${i}`, confidence: 0.7 + i * 0.01,
      })),
    };
    const callModel = vi.fn().mockResolvedValue({ verdict });
    const result = await extractConceptsFromDiscoveryMission({
      callModel, mission, nearestConcepts,
    });
    expect(result.usesServices.length).toBeLessThanOrEqual(5);
  });

  it('emits 4 valid teaches + 3 valid services from the fixture', async () => {
    const callModel = vi.fn().mockResolvedValue(FIXTURE);
    const result = await extractConceptsFromDiscoveryMission({
      callModel, mission, nearestConcepts,
    });
    expect(result.teaches).toHaveLength(4);
    expect(result.usesServices).toHaveLength(3);
  });
});
