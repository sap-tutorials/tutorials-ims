import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { renderConceptsIntoSession } from '../../srv/lib/publish-concepts.js';

// Task 3 of docs/superpowers/plans/2026-07-08-concepts-scale.md (#1327).
// POST /content/publish/render-concepts orchestration. Renders each concept
// BODY via renderConceptDetail, composes into the __shell__ chrome via
// composeShell, appends concept-<slug> full-doc BLOBs to an open publish
// session. Delta-skips unchanged concepts by the stored (full-doc) hash.
//
// buildConceptsPayload injected so unit tests need no HANA. `shell` is the
// parsed { before, after } halves the real path gets from shellLoader.

const SHELL = { before: '<html><body><header>SAP</header><main>', after: '</main><footer>x</footer></body></html>' };

function makeConcept(slug, name, teaches = []) {
  return {
    slug, name, description: `${name} desc`,
    teaches, requires: [], requiredBy: [], relatedTo: [],
    learningJourneys: [], blogPosts: [], discoveryMissions: [], videos: [],
    apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
  };
}

// Recompute the exact stored hash the way the server does: sha256 of the
// decompressed full document = composeShell(shell, body, meta). We approximate
// composeShell here only to derive priorHashes for the "unchanged" concept;
// the module owns the real compose. Instead we capture what the module appends
// and read hashes back from there for the changed set, and for the skip case
// we prime priorHashes from a first dry run.

function captureHelpers() {
  const calls = [];
  return {
    calls,
    appendToSession: async ({ sessionId, files }) => {
      calls.push({ sessionId, files });
      return { appended: Object.keys(files).length };
    },
  };
}

async function firstPassHashes(concepts) {
  // Run once with empty priorHashes to learn each concept's stored hash.
  const helpers = captureHelpers();
  await renderConceptsIntoSession({
    db: {}, sessionId: 's0', helpers, priorHashes: {}, shell: SHELL,
    deps: { buildConceptsPayload: async () => ({ concepts }) },
  });
  const hashes = {};
  for (const call of helpers.calls) {
    for (const [slug, b64] of Object.entries(call.files)) {
      hashes[slug] = createHash('sha256').update(gunzipSync(Buffer.from(b64, 'base64'))).digest('hex');
    }
  }
  return hashes;
}

describe('renderConceptsIntoSession', () => {
  it('appends concept-<slug> full-doc BLOBs for all concepts on a fresh session', async () => {
    const concepts = [makeConcept('cap', 'CAP'), makeConcept('hana', 'HANA'), makeConcept('abap', 'ABAP')];
    const helpers = captureHelpers();
    const result = await renderConceptsIntoSession({
      db: {}, sessionId: 's1', helpers, priorHashes: {}, shell: SHELL,
      deps: { buildConceptsPayload: async () => ({ concepts }) },
    });
    expect(result.conceptsSeen).toBe(3);
    expect(result.conceptsChanged).toBe(3);
    expect(result.conceptsSkipped).toBe(0);

    const allFiles = Object.assign({}, ...helpers.calls.map(c => c.files));
    expect(Object.keys(allFiles).sort()).toEqual(['concept-abap', 'concept-cap', 'concept-hana']);
    // each value is base64(gzip(full doc)) — full doc has the shell chrome
    const doc = gunzipSync(Buffer.from(allFiles['concept-cap'], 'base64')).toString('utf-8');
    expect(doc).toContain('<header>SAP</header>');
    expect(doc).toContain('<article class="concept-page"');
    expect(doc).toContain('<h1 class="concept-page__title">CAP</h1>');
  });

  it('delta-skips concepts whose stored hash is unchanged', async () => {
    const concepts = [makeConcept('cap', 'CAP'), makeConcept('hana', 'HANA'), makeConcept('abap', 'ABAP')];
    const prior = await firstPassHashes(concepts);
    // Mark only 'cap' as unchanged; drop the others from priorHashes so they re-render.
    const priorHashes = { 'concept-cap': prior['concept-cap'] };

    const helpers = captureHelpers();
    const result = await renderConceptsIntoSession({
      db: {}, sessionId: 's2', helpers, priorHashes, shell: SHELL,
      deps: { buildConceptsPayload: async () => ({ concepts }) },
    });
    expect(result.conceptsSeen).toBe(3);
    expect(result.conceptsSkipped).toBe(1);
    expect(result.conceptsChanged).toBe(2);

    const allFiles = Object.assign({}, ...helpers.calls.map(c => c.files));
    expect(allFiles).not.toHaveProperty('concept-cap');   // skipped
    expect(allFiles).toHaveProperty('concept-hana');
    expect(allFiles).toHaveProperty('concept-abap');
  });

  it('batches appends at 20 concepts per call', async () => {
    const concepts = Array.from({ length: 21 }, (_, i) => makeConcept(`c${i}`, `Concept ${i}`));
    const helpers = captureHelpers();
    const result = await renderConceptsIntoSession({
      db: {}, sessionId: 's3', helpers, priorHashes: {}, shell: SHELL,
      deps: { buildConceptsPayload: async () => ({ concepts }) },
    });
    expect(result.conceptsChanged).toBe(21);
    // 21 concepts → 2 append calls (20 + 1)
    expect(helpers.calls.length).toBe(2);
    expect(Object.keys(helpers.calls[0].files).length).toBe(20);
    expect(Object.keys(helpers.calls[1].files).length).toBe(1);
  });

  it('returns durationMs and zero-appends cleanly for an empty corpus', async () => {
    const helpers = captureHelpers();
    const result = await renderConceptsIntoSession({
      db: {}, sessionId: 's4', helpers, priorHashes: {}, shell: SHELL,
      deps: { buildConceptsPayload: async () => ({ concepts: [] }) },
    });
    expect(result.conceptsSeen).toBe(0);
    expect(result.conceptsChanged).toBe(0);
    expect(helpers.calls.length).toBe(0);
    expect(typeof result.durationMs).toBe('number');
  });

  it('throws when the shell is missing (sidecar not published)', async () => {
    const helpers = captureHelpers();
    await expect(renderConceptsIntoSession({
      db: {}, sessionId: 's5', helpers, priorHashes: {}, shell: null,
      deps: { buildConceptsPayload: async () => ({ concepts: [makeConcept('cap', 'CAP')] }) },
    })).rejects.toThrow(/shell/i);
  });

  it('skips a single concept whose render throws, keeps the rest (under 5%)', async () => {
    // 25 concepts; poison one so its render throws. 1/25 = 4% < 5% → tolerated.
    const concepts = Array.from({ length: 25 }, (_, i) => makeConcept(`c${i}`, `Concept ${i}`));
    concepts[3].name = null; // renderConceptDetail throws on missing name
    const helpers = captureHelpers();
    const result = await renderConceptsIntoSession({
      db: {}, sessionId: 's6', helpers, priorHashes: {}, shell: SHELL,
      deps: { buildConceptsPayload: async () => ({ concepts }) },
    });
    expect(result.conceptsSeen).toBe(25);
    expect(result.conceptsChanged).toBe(24);
    expect(result.conceptsErrored).toBe(1);
  });

  it('aborts (throws) when more than 5% of concepts error', async () => {
    // 10 concepts, poison 2 → 20% > 5% → abort.
    const concepts = Array.from({ length: 10 }, (_, i) => makeConcept(`c${i}`, `Concept ${i}`));
    concepts[1].name = null;
    concepts[7].name = null;
    const helpers = captureHelpers();
    await expect(renderConceptsIntoSession({
      db: {}, sessionId: 's7', helpers, priorHashes: {}, shell: SHELL,
      deps: { buildConceptsPayload: async () => ({ concepts }) },
    })).rejects.toThrow(/error rate|too many/i);
  });
});
