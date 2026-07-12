// test/unit/srv/kg-merge-on-write.test.js
//
// Unit tests for the shared merge-on-write helper used by both
// extract-concepts-job.js (tutorial cron) and fetch-learning-journeys-job.js
// (journey cron, #707).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  loadConceptRegistry,
  findBestMatch,
  resolveConceptCandidates,
} from '../../../srv/lib/kg-merge-on-write.js';

// 4-element vectors for compact fixtures.
function vec(...nums) {
  const f = new Float32Array(nums);
  return f;
}

function buf(...nums) {
  const f = vec(...nums);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

describe('findBestMatch', () => {
  it('returns the highest-cosine match', () => {
    const registry = new Map([
      ['id-a', vec(1, 0, 0, 0)],
      ['id-b', vec(0, 1, 0, 0)],
      ['id-c', vec(0.99, 0.01, 0, 0)],
    ]);
    const candidate = vec(1, 0, 0, 0);
    const { conceptId, sim } = findBestMatch(candidate, registry);
    // id-a is perfectly aligned → sim 1.0.
    expect(conceptId).toBe('id-a');
    expect(sim).toBeCloseTo(1.0, 4);
  });

  it('skips entries with mismatched vector length', () => {
    const registry = new Map([
      ['short', vec(1, 0)],  // length 2
      ['long', vec(1, 0, 0, 0)],  // length 4
    ]);
    const candidate = vec(1, 0, 0, 0);
    const { conceptId } = findBestMatch(candidate, registry);
    expect(conceptId).toBe('long');
  });

  it('returns {null, 0} for an empty registry', () => {
    const { conceptId, sim } = findBestMatch(vec(1, 0, 0, 0), new Map());
    expect(conceptId).toBeNull();
    expect(sim).toBe(0);
  });
});

describe('resolveConceptCandidates', () => {
  const registry = {
    bySlug: new Map([
      ['cap-handlers', { ID: 'concept-known', slug: 'cap-handlers', name: 'CAP handlers' }],
    ]),
    embeddings: new Map([
      ['concept-known', vec(1, 0, 0, 0)],
    ]),
  };

  it('returns action=exact when the slug is already in the registry', async () => {
    const result = await resolveConceptCandidates({
      candidates: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      registry,
      embed: vi.fn(),  // should NOT be called
      embeddingModel: 'test-model',
      mergeThreshold: 0.85,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      slug: 'cap-handlers',
      conceptId: 'concept-known',
      action: 'exact',
    });
    expect(result.pendingMints).toHaveLength(0);
    expect(result.counters).toEqual({ merged: 0, minted: 0, skippedNoEmbed: 0, reactivated: 0 });
  });

  it('returns action=merged when embedded candidate is near a registry concept', async () => {
    // Candidate vector close to (1, 0, 0, 0) → cosine ≈ 0.9985 > 0.85 threshold.
    const embed = vi.fn().mockResolvedValue([vec(0.95, 0.05, 0, 0)]);
    const result = await resolveConceptCandidates({
      candidates: [{ slug: 'cap-event-handlers', name: 'CAP event handlers', confidence: 0.8 }],
      registry,
      embed,
      embeddingModel: 'test-model',
      mergeThreshold: 0.85,
    });

    expect(embed).toHaveBeenCalledWith(['CAP event handlers'], 'test-model');
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      slug: 'cap-event-handlers',
      conceptId: 'concept-known',  // merged into the existing concept
      action: 'merged',
    });
    expect(result.pendingMints).toHaveLength(0);
    expect(result.counters.merged).toBe(1);
  });

  it('returns action=minted with a pending mint when no near-dup is found', async () => {
    // Orthogonal embedding → cosine 0 < 0.85 → mint.
    const embed = vi.fn().mockResolvedValue([vec(0, 0, 1, 0)]);
    const result = await resolveConceptCandidates({
      candidates: [{ slug: 'odata-v4', name: 'OData v4', confidence: 0.7 }],
      registry,
      embed,
      embeddingModel: 'test-model',
      mergeThreshold: 0.85,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].action).toBe('minted');
    expect(result.pendingMints).toHaveLength(1);
    expect(result.pendingMints[0]).toMatchObject({
      slug: 'odata-v4',
      name: 'OData v4',
    });
    // pendingMints[0].ID matches resolved[0].conceptId (caller chains them).
    expect(result.pendingMints[0].ID).toBe(result.resolved[0].conceptId);
    expect(Buffer.isBuffer(result.pendingMints[0].embeddingBuf)).toBe(true);
    expect(result.counters.minted).toBe(1);
  });

  it('deduplicates pending mints when the same slug appears twice in one call', async () => {
    const embed = vi.fn().mockResolvedValue([vec(0, 0, 1, 0)]);
    const result = await resolveConceptCandidates({
      candidates: [
        { slug: 'rap', name: 'RAP', confidence: 0.7 },
        { slug: 'rap', name: 'RAP', confidence: 0.8 },  // dup
      ],
      registry,
      embed,
      embeddingModel: 'test-model',
      mergeThreshold: 0.85,
    });

    // 2 resolved rows, BOTH pointing at the same conceptId.
    expect(result.resolved).toHaveLength(2);
    expect(result.resolved[0].conceptId).toBe(result.resolved[1].conceptId);
    // Only 1 pendingMint — the helper didn't mint twice.
    expect(result.pendingMints).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.counters.minted).toBe(1);  // only one fresh mint
  });

  it('skips candidates without a name (cannot embed)', async () => {
    const embed = vi.fn();
    const log = { warn: vi.fn() };
    const result = await resolveConceptCandidates({
      candidates: [{ slug: 'no-name-slug', confidence: 0.9 }],
      registry,
      embed,
      embeddingModel: 'test-model',
      mergeThreshold: 0.85,
      log,
    });

    expect(embed).not.toHaveBeenCalled();
    expect(result.resolved).toHaveLength(0);
    expect(result.counters.skippedNoEmbed).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no-name-slug'));
  });

  it('skips candidates whose embed call rejects', async () => {
    const embed = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    const log = { warn: vi.fn() };
    const result = await resolveConceptCandidates({
      candidates: [{ slug: 'flaky', name: 'Flaky', confidence: 0.9 }],
      registry,
      embed,
      embeddingModel: 'test-model',
      mergeThreshold: 0.85,
      log,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.counters.skippedNoEmbed).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('quota exceeded'));
  });
});

describe('loadConceptRegistry (sqlite path)', () => {
  beforeAll(async () => {
    const schemaRoots = [
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ];
    await cds.deploy(schemaRoots).to('sqlite::memory:');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries([
      {
        slug: 'cap-handlers',
        name: 'CAP handlers',
        description: 'desc',
        embedding: buf(1, 0, 0, 0),
        status: 'ACTIVE',
        publishedAt: now,
        publishedBy: 'admin@sap.com',
      },
      {
        slug: 'odata',
        name: 'OData',
        description: 'desc',
        embedding: buf(0, 1, 0, 0),
        status: 'ACTIVE',
        publishedAt: now,
        publishedBy: 'admin@sap.com',
      },
      {
        slug: 'vetoed-concept',
        name: 'Vetoed',
        description: 'desc',
        embedding: buf(0, 0, 1, 0),
        status: 'VETOED',
        publishedAt: now,
        publishedBy: 'admin@sap.com',
      },
    ]);
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  it('loads only ACTIVE concepts with both metadata and embeddings', async () => {
    const registry = await loadConceptRegistry(cds.db);
    // ACTIVE concepts only — vetoed is excluded.
    expect(registry.bySlug.has('cap-handlers')).toBe(true);
    expect(registry.bySlug.has('odata')).toBe(true);
    expect(registry.bySlug.has('vetoed-concept')).toBe(false);
    expect(registry.bySlug.size).toBe(2);

    // Embeddings keyed by ID, not slug.
    const capId = registry.bySlug.get('cap-handlers').ID;
    expect(registry.embeddings.has(capId)).toBe(true);
    const v = registry.embeddings.get(capId);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(4);
    expect(v[0]).toBeCloseTo(1, 5);
  });
});

describe('loadConceptRegistry retiredBySlug (#1115)', () => {
  beforeAll(async () => {
    const schemaRoots = [
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ];
    await cds.deploy(schemaRoots).to('sqlite::memory:');
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  it('loads RETIRED concepts into retiredBySlug, not bySlug', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Concepts);
    await INSERT.into(Concepts).entries([
      { ID: 'a0000000-0000-0000-0000-000000000001', slug: 'active-one', name: 'Active One', status: 'ACTIVE' },
      { ID: 'a0000000-0000-0000-0000-000000000002', slug: 'retired-one', name: 'Retired One', status: 'RETIRED' },
    ]);
    const db = await cds.connect.to('db');
    const reg = await loadConceptRegistry(db);
    expect(reg.bySlug.has('active-one')).toBe(true);
    expect(reg.bySlug.has('retired-one')).toBe(false);
    expect(reg.retiredBySlug.has('retired-one')).toBe(true);
    expect(reg.retiredBySlug.get('retired-one').ID).toBe('a0000000-0000-0000-0000-000000000002');
  });
});

describe('resolveConceptCandidates reactivation (#1115)', () => {
  it('resolves a retired slug to reactivated action, not a mint', async () => {
    const registry = {
      bySlug: new Map(),
      embeddings: new Map(),
      retiredBySlug: new Map([
        ['dormant-concept', { ID: 'r0000000-0000-0000-0000-000000000009', slug: 'dormant-concept', name: 'Dormant Concept' }],
      ]),
    };
    const embed = async () => [new Float32Array(1536).fill(0.1)];
    const result = await resolveConceptCandidates({
      candidates: [{ slug: 'dormant-concept', name: 'Dormant Concept', confidence: 0.9 }],
      registry,
      embed,
      embeddingModel: 'text-embedding-3-small',
      mergeThreshold: 0.85,
    });
    expect(result.pendingMints).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].action).toBe('reactivated');
    expect(result.resolved[0].conceptId).toBe('r0000000-0000-0000-0000-000000000009');
    expect(result.counters.reactivated).toBe(1);
  });
});
