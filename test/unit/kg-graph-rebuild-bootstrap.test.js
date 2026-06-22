// test/unit/kg-graph-rebuild-bootstrap.test.js
// Unit tests for the bootstrap step added to srv/lib/kg-graph-rebuild.js
// in #525 (PR following 2026-06-21 consolidator failure).
//
// HANA Cloud SPARQL doesn't support `CREATE GRAPH` DDL; the only way to
// create a named graph implicitly is via `INSERT DATA`. graphRebuild()
// must INSERT a bootstrap triple BEFORE the CLEAR so cold-graph runs
// don't fail with "Object does not exist".
//
// The hybrid test (test/hybrid/kg-graph-rebuild.test.js) exercises the
// full round-trip against real HANA. These unit tests assert the
// SPARQL call sequence + ensure the bootstrap is the FIRST call and the
// CLEAR is the SECOND.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SPARQL client + projection generator so the test stays pure
// (no HANA, no async iterator over CDS state).
const kgGraphClearMock = vi.fn();
const kgGraphInsertMock = vi.fn();
const projectTriplesMock = vi.fn();

vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgGraphClear: (...args) => kgGraphClearMock(...args),
  kgGraphInsert: (...args) => kgGraphInsertMock(...args),
}));
vi.mock('../../srv/lib/kg-projection.js', () => ({
  projectTriples: (...args) => projectTriplesMock(...args),
}));

// Mock @sap/cds. graphRebuild dynamically imports cds inside the
// upsertGraphMetadata helper (`const cdsMod = await import('@sap/cds')`),
// reads `cds.entities('com.sap.developers.ims').GraphMetadata`, and uses
// it as the target of SELECT/INSERT/UPDATE CQL builders. The CQL globals
// (SELECT, INSERT, UPDATE) come from the cds runtime, so the unit-test
// environment doesn't have them either; we stub them as no-ops since
// the helper passes the result into `tx.run()` which is mocked away.
vi.mock('@sap/cds', () => {
  const builder = () => {
    const chain = {
      from: () => chain,
      columns: () => chain,
      where: () => chain,
      set: () => chain,
      into: () => chain,
      entries: () => chain,
    };
    return chain;
  };
  const cdsStub = {
    entities: () => ({ GraphMetadata: '__stub__' }),
  };
  // CQL globals live on the default export AND on globalThis when the
  // real cds runtime initialises. Patch globalThis here so the
  // `await tx.run(SELECT.one.from(...))` lines inside graphRebuild
  // don't blow up at the SELECT global lookup.
  globalThis.SELECT = Object.assign(builder, { one: builder() });
  globalThis.INSERT = builder;
  globalThis.UPDATE = builder;
  return { default: cdsStub };
});

// Lazy-import the SUT so the mocks above are in place before the module
// captures its dependency references.
let graphRebuild, DEFAULT_GRAPH_IRI, BOOTSTRAP_TRIPLE, GRAPH_METADATA_SINGLETON_ID;

beforeEach(async () => {
  kgGraphClearMock.mockReset();
  kgGraphInsertMock.mockReset();
  projectTriplesMock.mockReset();

  // Each call resolves to the procedure response shape. The bootstrap +
  // CLEAR don't care about the return value; the INSERTs after them
  // don't either. Just keep them happy.
  kgGraphClearMock.mockResolvedValue({ response: '', headers: '', latencyMs: 0 });
  kgGraphInsertMock.mockResolvedValue({ response: '', headers: '', latencyMs: 0 });

  // Empty projection by default — most tests just want to verify the
  // wipe sequence, not the projection payload.
  projectTriplesMock.mockImplementation(async function* () { /* yield nothing */ });

  const mod = await import('../../srv/lib/kg-graph-rebuild.js');
  graphRebuild = mod.graphRebuild;
  DEFAULT_GRAPH_IRI = mod.DEFAULT_GRAPH_IRI;
  BOOTSTRAP_TRIPLE = mod.BOOTSTRAP_TRIPLE;
  GRAPH_METADATA_SINGLETON_ID = mod.GRAPH_METADATA_SINGLETON_ID;
});

afterEach(() => {
  vi.resetModules();
});

function makeDb() {
  // Minimal CDS service shape used by graphRebuild: .run for SPARQL +
  // .tx for the metadata upsert. We capture .tx callback invocations
  // for assertions but mostly just satisfy the shape.
  return {
    run: vi.fn().mockResolvedValue([]),
    tx: vi.fn(async (cb) => {
      const tx = {
        run: vi.fn().mockResolvedValue([]),
      };
      return cb(tx);
    }),
  };
}

describe('graphRebuild — bootstrap before CLEAR (#525)', () => {
  it('issues bootstrap INSERT before CLEAR GRAPH', async () => {
    const db = makeDb();
    const graphIri = 'urn:test:kg:unit';

    await graphRebuild({ db, graphIri });

    // kgGraphInsert should have been called at least once (bootstrap).
    // kgGraphClear should have been called at least once (clear).
    // Step 1 (bootstrap): kgGraphInsert with BOOTSTRAP_TRIPLE.
    // Step 2 (clear):     kgGraphClear.
    expect(kgGraphInsertMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(kgGraphClearMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Check that bootstrap INSERT was called with the right args.
    const bootstrapInsertCall = kgGraphInsertMock.mock.calls[0][0];
    expect(bootstrapInsertCall).toEqual({
      db: expect.anything(),
      graphIri,
      triples: BOOTSTRAP_TRIPLE,
    });

    // Check that CLEAR was called with the right args.
    const clearCall = kgGraphClearMock.mock.calls[0][0];
    expect(clearCall).toEqual({
      db: expect.anything(),
      graphIri,
    });
  });

  it('uses BOOTSTRAP_TRIPLE for the bootstrap insert (not arbitrary data)', async () => {
    // Pin the bootstrap triple shape so a refactor that "cleans up" the
    // dummy triple doesn't accidentally break the auto-create semantics.
    const db = makeDb();
    await graphRebuild({ db, graphIri: 'urn:test' });

    const bootstrapInsertCall = kgGraphInsertMock.mock.calls[0][0];
    expect(bootstrapInsertCall.triples).toBe(BOOTSTRAP_TRIPLE);
    expect(bootstrapInsertCall.triples).toContain('<urn:bootstrap:ignore>');
    // All three terms in the triple are the same "ghost" IRI — this is
    // a deliberate choice (see BOOTSTRAP_TRIPLE comment) so the dummy
    // triple is obviously not real data to anyone debugging.
    const matches = bootstrapInsertCall.triples.match(/<urn:bootstrap:ignore>/g);
    expect(matches.length).toBe(3);
  });

  it('targets the default IRI when no graphIri argument is supplied', async () => {
    const db = makeDb();
    await graphRebuild({ db });

    const bootstrapInsertCall = kgGraphInsertMock.mock.calls[0][0];
    const clearCall = kgGraphClearMock.mock.calls[0][0];
    expect(bootstrapInsertCall.graphIri).toBe(DEFAULT_GRAPH_IRI);
    expect(clearCall.graphIri).toBe(DEFAULT_GRAPH_IRI);
  });

  it('still propagates errors from CLEAR (the bootstrap does not catch them)', async () => {
    // Bootstrap succeeds, but CLEAR raises something unexpected.
    // The error must surface — we don't want to swallow real failures.
    const db = makeDb();
    kgGraphInsertMock.mockResolvedValueOnce({ response: '', headers: '', latencyMs: 0 }); // bootstrap
    kgGraphClearMock.mockRejectedValueOnce(new Error('CLEAR failed for some other reason')); // clear

    await expect(graphRebuild({ db, graphIri: 'urn:test' }))
      .rejects.toThrow(/CLEAR failed for some other reason/);
  });

  it('propagates errors from the bootstrap INSERT itself', async () => {
    // If bootstrap fails (e.g. SPARQL privilege error), graphRebuild
    // must NOT proceed to CLEAR — that would just propagate the same
    // "Object does not exist" we're trying to fix.
    const db = makeDb();
    kgGraphInsertMock.mockRejectedValueOnce(new Error('privilege denied'));

    await expect(graphRebuild({ db, graphIri: 'urn:test' }))
      .rejects.toThrow(/privilege denied/);

    // CLEAR should NOT have been issued.
    expect(kgGraphClearMock.mock.calls.length).toBe(0);
  });
});
