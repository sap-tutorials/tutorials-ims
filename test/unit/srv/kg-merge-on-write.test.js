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
  insertMintedConcept,
  vectorToJsonLiteral,
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

describe('vectorToJsonLiteral (#1123)', () => {
  it('serializes a Float32Array to a JSON array literal at full precision', () => {
    const v = vec(0.1, 0.2, 0.3, 0.4);
    const s = vectorToJsonLiteral(v);
    // Parseable back to an array; not lossy-rounded to 6 decimals.
    const parsed = JSON.parse(s);
    expect(parsed).toHaveLength(4);
    // Float32(0.1) is 0.10000000149011612 — full precision is preserved
    // (the old backfill used toFixed(6) which would have dropped these digits).
    expect(parsed[0]).toBeCloseTo(0.1, 6);
    expect(String(parsed[0]).length).toBeGreaterThan('0.100000'.length);
  });
});

describe('insertMintedConcept (#1123, sqlite path)', () => {
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

  it('populates BOTH embedding (BLOB) and embeddingVec at mint time', async () => {
    const id = cds.utils.uuid();
    const embeddingVec = vec(0.5, 0.5, 0.5, 0.5);
    await insertMintedConcept({
      db: cds.db,
      entry: {
        ID: id,
        slug: 'mint-1123',
        name: 'Mint 1123',
        embeddingBuf: buf(0.5, 0.5, 0.5, 0.5),
        embeddingVec,
        lastSeenAt: new Date().toISOString(),
      },
    });

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const [row] = await cds.db.run(
      `SELECT ID, embedding, embeddingVec, status, extractionCount, firstSeenAt, createdAt
       FROM com_sap_developers_ims_Concepts WHERE ID = ?`,
      [id],
    );
    expect(row.embedding, 'BLOB column filled').toBeTruthy();
    expect(row.embeddingVec ?? row.EMBEDDINGVEC, 'vector column filled at mint time').toBeTruthy();
    // Managed/default fields survived the INSERT (helper uses CQL, not raw SQL).
    expect(row.status ?? row.STATUS).toBe('ACTIVE');
    expect(row.extractionCount ?? row.EXTRACTIONCOUNT).toBe(0);
    expect(row.firstSeenAt ?? row.FIRSTSEENAT, '@cds.on.insert firstSeenAt set').toBeTruthy();
    expect(row.createdAt ?? row.CREATEDAT, 'managed createdAt set').toBeTruthy();

    // The stored vector string round-trips to the original values.
    const stored = JSON.parse(row.embeddingVec ?? row.EMBEDDINGVEC);
    expect(stored).toHaveLength(4);
    expect(stored[0]).toBeCloseTo(0.5, 5);
  });

  it('honors an explicit status/description/extractionCount override', async () => {
    const id = cds.utils.uuid();
    await insertMintedConcept({
      db: cds.db,
      entry: {
        ID: id,
        slug: 'mint-1123-override',
        name: 'Override',
        description: 'custom',
        embeddingBuf: buf(1, 0, 0, 0),
        embeddingVec: vec(1, 0, 0, 0),
        status: 'ACTIVE',
        extractionCount: 3,
        lastSeenAt: new Date().toISOString(),
      },
    });
    const [row] = await cds.db.run(
      `SELECT description, extractionCount FROM com_sap_developers_ims_Concepts WHERE ID = ?`,
      [id],
    );
    expect(row.description ?? row.DESCRIPTION).toBe('custom');
    expect(row.extractionCount ?? row.EXTRACTIONCOUNT).toBe(3);
  });
});

describe('insertMintedConcept ACTIVE-slug uniqueness guard (KG vertex-dup)', () => {
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

  it('reuses an existing ACTIVE row instead of inserting a second one', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Concepts);
    const existingId = 'c0000000-0000-0000-0000-00000000aaaa';
    await INSERT.into(Concepts).entries([
      { ID: existingId, slug: 'dup-guard', name: 'Existing', status: 'ACTIVE' },
    ]);

    // A sibling job (stale registry) tries to mint a fresh UUID for the same slug.
    const phantomId = cds.utils.uuid();
    const res = await insertMintedConcept({
      db: cds.db,
      entry: {
        ID: phantomId,
        slug: 'dup-guard',
        name: 'Would-be duplicate',
        embeddingBuf: buf(0, 1, 0, 0),
        embeddingVec: vec(0, 1, 0, 0),
        lastSeenAt: new Date().toISOString(),
      },
    });

    // Returns the persisted (existing) ID + 'reused' — never the phantom.
    expect(res.action).toBe('reused');
    expect(res.ID).toBe(existingId);

    // Still exactly ONE row for the slug; the phantom UUID was never inserted.
    const rows = await cds.db.run(
      `SELECT ID FROM com_sap_developers_ims_Concepts WHERE slug = ?`,
      ['dup-guard'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ID ?? rows[0].id).toBe(existingId);
  });

  it('reactivates a RETIRED row rather than minting when only a retired row exists', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Concepts);
    const retiredId = 'c0000000-0000-0000-0000-00000000bbbb';
    await INSERT.into(Concepts).entries([
      { ID: retiredId, slug: 'retired-guard', name: 'Dormant', status: 'RETIRED' },
    ]);

    const phantomId = cds.utils.uuid();
    const res = await insertMintedConcept({
      db: cds.db,
      entry: {
        ID: phantomId,
        slug: 'retired-guard',
        name: 'Re-proposed',
        embeddingBuf: buf(0, 0, 1, 0),
        embeddingVec: vec(0, 0, 1, 0),
        lastSeenAt: new Date().toISOString(),
      },
    });

    expect(res.action).toBe('reactivated');
    expect(res.ID).toBe(retiredId);

    const rows = await cds.db.run(
      `SELECT ID, status FROM com_sap_developers_ims_Concepts WHERE slug = ?`,
      ['retired-guard'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ID ?? rows[0].id).toBe(retiredId);
    expect(rows[0].status ?? rows[0].STATUS).toBe('ACTIVE');
  });

  it('mints a fresh row (action=minted) when no row exists for the slug', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Concepts);
    const id = cds.utils.uuid();
    const res = await insertMintedConcept({
      db: cds.db,
      entry: {
        ID: id,
        slug: 'novel-guard',
        name: 'Novel',
        embeddingBuf: buf(1, 0, 0, 0),
        embeddingVec: vec(1, 0, 0, 0),
        lastSeenAt: new Date().toISOString(),
      },
    });
    expect(res.action).toBe('minted');
    expect(res.ID).toBe(id);
  });
});
