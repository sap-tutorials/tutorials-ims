// test/unit/srv/kg-explore-data.test.js
//
// Unit tests for buildExplorePayload — the helper that converts the
// EXPLORE_GRAPH_BULK SPARQL result into the JSON shape consumed by the
// /graph/explore-data endpoint and the /explore/ Hugo page's inline
// hydration payload.
//
// We mock kgQuery() to avoid any DB dependency; the SPARQL response is
// a JSON string with results.bindings (see srv/knowledge-graph-service.js
// parseNeighborhoodSparqlResponse for the canonical shape).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Helper — build a SPARQL JSON response with bindings (var → IRI/literal).
function sparqlResponse(bindings) {
  return JSON.stringify({
    head: { vars: ['s', 'p', 'o', 'sName', 'oName'] },
    results: { bindings },
  });
}

// Build a SPARQL binding row from the (s, p, o, sName, oName) shape.
function row({ s, p, o, sName, oName }) {
  const r = {
    s: { type: 'uri', value: s },
    p: { type: 'uri', value: p },
    o: { type: 'uri', value: o },
  };
  if (sName !== undefined) r.sName = { type: 'literal', value: sName };
  if (oName !== undefined) r.oName = { type: 'literal', value: oName };
  return r;
}

const KG = 'https://developers.sap.com/kg/';

describe('buildExplorePayload', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('converts SPARQL bindings into {nodes, edges, generatedAt}', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({
            s: `${KG}tutorial/cap-handlers`,
            p: `${KG}teaches`,
            o: `${KG}concept/cap-handlers`,
            sName: 'CAP handlers',
            oName: 'CAP handlers',
          }),
          row({
            s: `${KG}tutorial/cap-handlers`,
            p: `${KG}partOf`,
            o: `${KG}mission/cap-quickstart`,
            sName: 'CAP handlers',
          }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({});

    expect(payload).toHaveProperty('nodes');
    expect(payload).toHaveProperty('edges');
    expect(payload).toHaveProperty('generatedAt');
    expect(payload.nodes).toHaveLength(3);
    expect(payload.edges).toHaveLength(2);

    const tutorialNode = payload.nodes.find((n) => n.type === 'tutorial');
    expect(tutorialNode.slug).toBe('cap-handlers');
    expect(tutorialNode.label).toBe('CAP handlers');

    const conceptNode = payload.nodes.find((n) => n.type === 'concept');
    expect(conceptNode.slug).toBe('cap-handlers');

    const missionNode = payload.nodes.find((n) => n.type === 'mission');
    expect(missionNode.slug).toBe('cap-quickstart');
    // No oName in the second row → label falls back to slug.
    expect(missionNode.label).toBe('cap-quickstart');

    expect(payload.edges.find((e) => e.p === 'teaches')).toBeTruthy();
    expect(payload.edges.find((e) => e.p === 'partOf')).toBeTruthy();
  });

  it('deduplicates nodes that appear in multiple edges', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({
            s: `${KG}tutorial/a`,
            p: `${KG}teaches`,
            o: `${KG}concept/x`,
            sName: 'A',
            oName: 'X',
          }),
          row({
            s: `${KG}tutorial/a`,
            p: `${KG}teaches`,
            o: `${KG}concept/y`,
            sName: 'A',
            oName: 'Y',
          }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({});

    expect(payload.nodes).toHaveLength(3); // A, X, Y — A appears in both edges.
    expect(payload.edges).toHaveLength(2);
  });

  it('produces stable node IDs from (type, slug)', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({
            s: `${KG}tutorial/cap`,
            p: `${KG}teaches`,
            o: `${KG}concept/cap`,
          }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({});

    const ids = payload.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['c:cap', 't:cap']);
  });

  it('returns an empty graph (zero nodes, zero edges) when SPARQL has no bindings', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({});
    expect(payload.nodes).toEqual([]);
    expect(payload.edges).toEqual([]);
    expect(typeof payload.generatedAt).toBe('string');
  });

  it('short-names predicate IRIs by stripping the kg: prefix', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({
            s: `${KG}tutorial/a`,
            p: `${KG}coCompletedWith`,
            o: `${KG}tutorial/b`,
          }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({});
    expect(payload.edges[0].p).toBe('coCompletedWith');
  });

  it('counts dropped bindings when SPARQL returns unrecognized IRIs', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          // Valid binding — kept.
          row({
            s: `${KG}tutorial/a`,
            p: `${KG}teaches`,
            o: `${KG}concept/x`,
          }),
          // Unparseable subject (unknown IRI prefix) — dropped + counted.
          row({
            s: 'https://example.org/unknown/foo',
            p: `${KG}teaches`,
            o: `${KG}concept/x`,
          }),
          // Unparseable object — dropped + counted.
          row({
            s: `${KG}tutorial/a`,
            p: `${KG}teaches`,
            o: 'https://example.org/unknown/bar',
          }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({});
    expect(payload.droppedBindings).toBe(2);
    expect(payload.edges).toHaveLength(1);
  });

  it('reports zero dropped bindings when every row parses cleanly', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({
            s: `${KG}tutorial/a`,
            p: `${KG}teaches`,
            o: `${KG}concept/x`,
          }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({});
    expect(payload.droppedBindings).toBe(0);
  });

  // --- rank stamping (#2517) ---

  it('omits rank on every node when no rankMaps supplied', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({ s: `${KG}tutorial/a`, p: `${KG}teaches`, o: `${KG}concept/b`, sName: 'A', oName: 'B' }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({}, {});
    for (const n of payload.nodes) {
      expect(n).not.toHaveProperty('rank');
    }
  });

  it('stamps max-normalized rank on tutorial and concept nodes when rankMaps supplied', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({ s: `${KG}tutorial/a`, p: `${KG}teaches`, o: `${KG}concept/b`, sName: 'A', oName: 'B' }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const rankMaps = {
      tutorialRank: new Map([['a', 5], ['other', 10]]), // a normalizes to 0.5 (max is 10)
      conceptRank:  new Map([['b', 4]]),                 // b is the only entry → max → 1
    };
    const payload = await buildExplorePayload({}, { rankMaps });
    const a = payload.nodes.find((n) => n.id === 't:a');
    const b = payload.nodes.find((n) => n.id === 'c:b');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.rank).toBeCloseTo(0.5, 5);
    expect(b.rank).toBeCloseTo(1, 5);
  });

  it('omits rank when rankMaps has empty maps', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({ s: `${KG}tutorial/a`, p: `${KG}teaches`, o: `${KG}concept/b`, sName: 'A', oName: 'B' }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const payload = await buildExplorePayload({}, { rankMaps: { tutorialRank: new Map(), conceptRank: new Map() } });
    for (const n of payload.nodes) {
      expect(n).not.toHaveProperty('rank');
    }
  });

  it('omits rank for a node whose slug is absent from its map', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          row({ s: `${KG}tutorial/a`, p: `${KG}teaches`, o: `${KG}concept/b`, sName: 'A', oName: 'B' }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    // Only concept b has a rank entry; tutorial a does not.
    const payload = await buildExplorePayload({}, { rankMaps: { tutorialRank: new Map(), conceptRank: new Map([['b', 1]]) } });
    const a = payload.nodes.find((n) => n.id === 't:a');
    const b = payload.nodes.find((n) => n.id === 'c:b');
    expect(a).not.toHaveProperty('rank');
    expect(b.rank).toBeCloseTo(1, 5);
  });

  it('never stamps rank on non-tutorial/non-concept nodes even when rankMaps supplied', async () => {
    vi.doMock('@tutorials/kg/kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({
        response: sparqlResponse([
          // tutorial → mission edge; mission has no rank map
          row({ s: `${KG}tutorial/a`, p: `${KG}partOf`, o: `${KG}mission/x`, sName: 'A', oName: 'X' }),
        ]),
      }),
    }));

    const { buildExplorePayload } = await import('../../../srv/lib/kg-explore-data.js');
    const rankMaps = {
      tutorialRank: new Map([['a', 1]]),
      conceptRank:  new Map(),
    };
    const payload = await buildExplorePayload({}, { rankMaps });
    const mission = payload.nodes.find((n) => n.type === 'mission');
    expect(mission).toBeTruthy();
    expect(mission).not.toHaveProperty('rank');
    // tutorial still gets its rank
    const tutorial = payload.nodes.find((n) => n.id === 't:a');
    expect(tutorial.rank).toBeCloseTo(1, 5);
  });
});
