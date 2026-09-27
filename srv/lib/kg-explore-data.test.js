// srv/lib/kg-explore-data.test.js
//
// Unit tests for buildExplorePayload rank stamping (Task 2 of #2517).
// Uses vi.doMock + vi.resetModules() to swap the kgQuery dependency per
// test — the same convention as test/unit/srv/kg-explore-data.test.js.
//
// Test-fixture notes:
//   - Subject IRI https://developers.sap.com/kg/tutorial/a → node id 't:a'
//   - Object  IRI https://developers.sap.com/kg/concept/b  → node id 'c:b'
//   - Predicate IRI can be any kg/ URI (e.g. …/predicate/teaches) — the
//     short-name parsing only strips the kg/ prefix; if the tail doesn't
//     match a known entity segment the row is kept as an edge.
//
// Run from repo root:
//   npx vitest run srv/lib/kg-explore-data.test.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

const KG = 'https://developers.sap.com/kg/';

// One-row fixture that yields tutorial node t:a and concept node c:b.
function oneRowResponse() {
  return JSON.stringify({
    results: {
      bindings: [
        {
          s: { value: `${KG}tutorial/a` },
          p: { value: `${KG}predicate/teaches` },
          o: { value: `${KG}concept/b` },
          sName: { value: 'A' },
          oName: { value: 'B' },
        },
      ],
    },
  });
}

describe('buildExplorePayload rank', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('omits rank when no rankMaps supplied', async () => {
    vi.doMock('./kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({ response: oneRowResponse() }),
    }));

    const { buildExplorePayload } = await import('./kg-explore-data.js');
    const payload = await buildExplorePayload({}, {});
    for (const n of payload.nodes) {
      expect(n).not.toHaveProperty('rank');
    }
  });

  it('stamps normalized rank per map when rankMaps supplied', async () => {
    vi.doMock('./kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({ response: oneRowResponse() }),
    }));

    const { buildExplorePayload } = await import('./kg-explore-data.js');
    const rankMaps = {
      tutorialRank: new Map([['a', 5], ['other', 10]]), // a normalizes to 0.5
      conceptRank:  new Map([['b', 4]]),                 // b is the max → 1
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
    vi.doMock('./kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({ response: oneRowResponse() }),
    }));

    const { buildExplorePayload } = await import('./kg-explore-data.js');
    const rankMaps = {
      tutorialRank: new Map(),
      conceptRank:  new Map(),
    };
    const payload = await buildExplorePayload({}, { rankMaps });
    for (const n of payload.nodes) {
      expect(n).not.toHaveProperty('rank');
    }
  });

  it('omits rank for a node whose slug is not in the map', async () => {
    vi.doMock('./kg-sparql-client.js', () => ({
      kgQuery: vi.fn().mockResolvedValue({ response: oneRowResponse() }),
    }));

    const { buildExplorePayload } = await import('./kg-explore-data.js');
    // Only concept b has a rank entry; tutorial a does not.
    const rankMaps = {
      tutorialRank: new Map(),
      conceptRank:  new Map([['b', 1]]),
    };
    const payload = await buildExplorePayload({}, { rankMaps });
    const a = payload.nodes.find((n) => n.id === 't:a');
    const b = payload.nodes.find((n) => n.id === 'c:b');
    expect(a).not.toHaveProperty('rank');
    expect(b.rank).toBeCloseTo(1, 5);
  });
});
