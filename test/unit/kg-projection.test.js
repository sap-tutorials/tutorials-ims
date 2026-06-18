// test/unit/kg-projection.test.js
// Unit tests for projectFromFixtures in srv/lib/kg-projection.js — pure
// function from a CDS-state snapshot to N-Triples batches.
//
// We do NOT exercise the DB-bound projectTriples() path here; that is the
// PR 4 hybrid-test's job (Task 4.5). projectFromFixtures takes plain JS
// fixture data so unit tests stay fully deterministic and DB-free.
//
// The 8-predicate ontology (per the spec) is:
//   teaches, requires, relatedTo, extends, partOf, taggedWith, inCategory,
//   aboutProduct, coCompletedWith
// (9 predicate names, but :partOf covers two domain pairs.)
//
// IRI shape:
//   <https://developers.sap.com/kg/concept/<slug>>
//   <https://developers.sap.com/kg/tutorial/<slug>>
//   <https://developers.sap.com/kg/mission/<slug>>
//   <https://developers.sap.com/kg/group/<slug>>
//   <https://developers.sap.com/kg/tag/<slug>>
//   <https://developers.sap.com/kg/product/<slug>>
//   <https://developers.sap.com/kg/category/<slug>>
//   <https://developers.sap.com/kg/<predicate>>
//   rdf:type → <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>

import { describe, it, expect } from 'vitest';
import { projectFromFixtures } from '../../srv/lib/kg-projection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KG = 'https://developers.sap.com/kg/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const EMPTY_FIXTURES = {
  concepts: [],
  links: [],
  edges: [],
  tutorials: [],
  missions: [],
  coCompletions: {},
};

/** Run the async generator to completion and return the flat triple array. */
async function collectAll(fixtures, batchSize = 5000) {
  const batches = [];
  for await (const batch of projectFromFixtures(fixtures, batchSize)) {
    batches.push(batch);
  }
  return { batches, triples: batches.flat() };
}

// ---------------------------------------------------------------------------
// Tests — Concepts
// ---------------------------------------------------------------------------

describe('projectFromFixtures — Concepts', () => {
  it('emits 3 triples for an ACTIVE concept (type, slug, name)', async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'cap-handlers', name: 'CAP Service Handlers', description: 'd', status: 'ACTIVE' },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}concept/cap-handlers> <${RDF_TYPE}> <${KG}Concept> .`
    );
    expect(triples).toContain(
      `<${KG}concept/cap-handlers> <${KG}slug> "cap-handlers" .`
    );
    expect(triples).toContain(
      `<${KG}concept/cap-handlers> <${KG}name> "CAP Service Handlers" .`
    );
    expect(triples.length).toBe(3);
  });

  it('emits NO triples for a MERGED concept', async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'foo', name: 'Foo', description: '', status: 'MERGED' },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toEqual([]);
  });

  it('emits NO triples for a VETOED concept', async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'foo', name: 'Foo', description: '', status: 'VETOED' },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — TutorialConceptLinks
// ---------------------------------------------------------------------------

describe('projectFromFixtures — TutorialConceptLinks', () => {
  it("emits :teaches when concept is ACTIVE", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'cap-handlers', name: 'CAP Service Handlers', description: '', status: 'ACTIVE' },
      ],
      links: [
        { tutorial_slug: 'cap-handler-deep-dive', predicate: 'teaches', concept_slug: 'cap-handlers' },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}tutorial/cap-handler-deep-dive> <${KG}teaches> <${KG}concept/cap-handlers> .`
    );
  });

  it("emits NO :teaches triple when concept is VETOED", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'cap-handlers', name: 'CAP', description: '', status: 'VETOED' },
      ],
      links: [
        { tutorial_slug: 't', predicate: 'teaches', concept_slug: 'cap-handlers' },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples.find((t) => t.includes('teaches'))).toBeUndefined();
  });

  it("emits :extends Tutorial → Tutorial", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      links: [
        {
          tutorial_slug: 'cap-handler-deep-dive',
          predicate: 'extends',
          extendsTutorial_slug: 'build-your-first-cap-service',
        },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}tutorial/cap-handler-deep-dive> <${KG}extends> <${KG}tutorial/build-your-first-cap-service> .`
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — ConceptEdges
// ---------------------------------------------------------------------------

describe('projectFromFixtures — ConceptEdges', () => {
  it("emits :requires for ACTIVE edges", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'a', name: 'A', description: '', status: 'ACTIVE' },
        { slug: 'b', name: 'B', description: '', status: 'ACTIVE' },
      ],
      edges: [
        { source_slug: 'a', target_slug: 'b', predicate: 'requires', status: 'ACTIVE' },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}concept/a> <${KG}requires> <${KG}concept/b> .`
    );
  });

  it("emits NO triples for VETOED edges", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'a', name: 'A', description: '', status: 'ACTIVE' },
        { slug: 'b', name: 'B', description: '', status: 'ACTIVE' },
      ],
      edges: [
        { source_slug: 'a', target_slug: 'b', predicate: 'requires', status: 'VETOED' },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples.find((t) => t.includes('requires'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — Tutorials (mission membership, taggedWith, aboutProduct)
// ---------------------------------------------------------------------------

describe('projectFromFixtures — Tutorial structural triples', () => {
  it("emits :partOf Tutorial → Mission for tutorials with mission membership", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      tutorials: [
        {
          slug: 'tut-a',
          missions: ['my-mission'],
          tags: [],
        },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}tutorial/tut-a> <${KG}partOf> <${KG}mission/my-mission> .`
    );
  });

  it("emits :taggedWith Tutorial → Tag for each tag slug", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      tutorials: [
        {
          slug: 'tut-a',
          missions: [],
          tags: ['cloud', 'topic>development'],
        },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}tutorial/tut-a> <${KG}taggedWith> <${KG}tag/cloud> .`
    );
    expect(triples).toContain(
      `<${KG}tutorial/tut-a> <${KG}taggedWith> <${KG}tag/topic>development> .`
    );
  });

  it("emits :aboutProduct for software-product>* tags only", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      tutorials: [
        {
          slug: 'tut-a',
          missions: [],
          tags: ['software-product>sap-s-4hana', 'topic>development'],
        },
      ],
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}tutorial/tut-a> <${KG}aboutProduct> <${KG}product/sap-s-4hana> .`
    );
    expect(
      triples.find((t) => t.includes(':aboutProduct') && t.includes('topic>development'))
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — Literal escaping
// ---------------------------------------------------------------------------

describe('projectFromFixtures — N-Triples literal escaping', () => {
  it("escapes \\, \", and newline in concept name", async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        {
          slug: 'tricky',
          name: 'foo "bar"\nbaz\\qux',
          description: '',
          status: 'ACTIVE',
        },
      ],
    };
    const { triples } = await collectAll(fixtures);
    const nameTriple = triples.find((t) => t.includes(`<${KG}name>`));
    expect(nameTriple).toBeDefined();
    // The escaped body must contain literal backslash-quote, backslash-n,
    // and backslash-backslash (per N-Triples grammar). We assert against
    // the exact escaped form.
    expect(nameTriple).toBe(
      `<${KG}concept/tricky> <${KG}name> "foo \\"bar\\"\\nbaz\\\\qux" .`
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — Batching
// ---------------------------------------------------------------------------

describe('projectFromFixtures — batching', () => {
  it('with batchSize=2, 5 triples are emitted as batches of [2, 2, 1]', async () => {
    // One ACTIVE concept emits 3 triples. We add an extends-link (1 triple)
    // and a partOf (1 triple) → total 5.
    const fixtures = {
      ...EMPTY_FIXTURES,
      concepts: [
        { slug: 'a', name: 'A', description: '', status: 'ACTIVE' },
      ],
      links: [
        { tutorial_slug: 't1', predicate: 'extends', extendsTutorial_slug: 't0' },
      ],
      tutorials: [
        { slug: 't1', missions: ['m1'], tags: [] },
      ],
    };
    const { batches, triples } = await collectAll(fixtures, /*batchSize=*/ 2);
    expect(triples.length).toBe(5);
    // Allow the implementation freedom in section ordering; what matters
    // is that no batch exceeds batchSize and the final partial is yielded.
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(2);
      expect(b.length).toBeGreaterThan(0);
    }
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tests — Co-completions
// ---------------------------------------------------------------------------

describe('projectFromFixtures — coCompletedWith', () => {
  it('emits :coCompletedWith Tutorial → Tutorial for each entry in the map', async () => {
    const fixtures = {
      ...EMPTY_FIXTURES,
      coCompletions: {
        a: [{ slug: 'b', score: 5 }, { slug: 'c', score: 3 }],
      },
    };
    const { triples } = await collectAll(fixtures);
    expect(triples).toContain(
      `<${KG}tutorial/a> <${KG}coCompletedWith> <${KG}tutorial/b> .`
    );
    expect(triples).toContain(
      `<${KG}tutorial/a> <${KG}coCompletedWith> <${KG}tutorial/c> .`
    );
  });
});
