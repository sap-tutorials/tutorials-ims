import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid test for the @assert.unique constraint on Concepts.slug
// (knowledge graph data model — issue #381, PR 2 of the KG plan).
//
// EXPECTED LIFECYCLE
//   - BEFORE PR 2's HDI deploy: this test FAILS at INSERT time because the
//     COM_SAP_DEVELOPERS_IMS_CONCEPTS table does not exist yet on the bound
//     HDI container. That is the proof we want — TDD red-before-green.
//   - AFTER PR 2 deploys to DEV: this test PASSES, proving CAP's
//     @assert.unique handler is actively enforcing slug uniqueness on real
//     HANA (not just local SQLite).
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-unique-slug.test.js
//
// SAFETY
//   - All inserted rows use the TEST_PREFIX `__TEST__kg-unique-slug-` and
//     are deleted in afterAll() via raw SQL with a LOWER(slug) LIKE match,
//     so cleanup is unambiguous and case-defensive.
//   - The hybrid project's _guard.js + ALLOW_HYBRID_WRITES gate keeps this
//     out of production. The beforeAll() guard below additionally hard-fails
//     if somehow run against SQLite, rather than silently passing on an
//     empty schema.

const TEST_PREFIX = `__TEST__kg-unique-slug-`;
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('Concepts.slug @assert.unique constraint (issue #381, KG PR 2)', () => {
  let db;
  let Concepts;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-unique-slug.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
    Concepts = cds.entities('com.sap.developers.ims').Concepts;
  });

  afterAll(async () => {
    // Cleanup ALL rows this run inserted, plus any stragglers from prior
    // runs that crashed before afterAll fired. The LIKE pattern is
    // lowercase because the LHS is forced lowercase via LOWER(); the JS
    // TEST_PREFIX above (`__TEST__kg-unique-slug-`) is mixed-case and
    // BOTH would match — LOWER() picks up either casing defensively.
    if (!db) return;
    await db.run(
      `DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
        WHERE LOWER("SLUG") LIKE '__test__kg-unique-slug-%'`
    );
  });

  it('inserts one Concept with a unique slug', async () => {
    const slug = `${TEST_PREFIX}${RUN_ID}-unique-1`;
    await INSERT.into(Concepts).entries({
      slug,
      name: 'KG unique slug — first row',
      description: 'TDD fixture for @assert.unique on Concepts.slug',
      status: 'ACTIVE'
    });
    const found = await SELECT.one.from(Concepts).where({ slug });
    expect(found).toBeTruthy();
    expect(found.slug).toBe(slug);
  });

  it('rejects a second Concept with the same slug', async () => {
    const slug = `${TEST_PREFIX}${RUN_ID}-dup`;
    // First insert seeds the row.
    await INSERT.into(Concepts).entries({
      slug,
      name: 'KG unique slug — seed for dup',
      description: 'first row of dup pair',
      status: 'ACTIVE'
    });
    // Second insert with the same slug must be rejected. CAP's
    // @assert.unique handler emits "...already exists..." (en-US, locale-
    // dependent) at the application layer; HANA's UNIQUE constraint emits
    // UNIQUE_CONSTRAINT_VIOLATION at the DB layer. Either path proves the
    // constraint is enforced — accept both.
    const dupInsert = INSERT.into(Concepts).entries({
      slug,
      name: 'KG unique slug — duplicate attempt',
      description: 'should be rejected',
      status: 'ACTIVE'
    });
    await expect(dupInsert).rejects.toThrow(/unique|already exists|duplicate|UNIQUE_CONSTRAINT_VIOLATION/i);
  });

  it('allows two Concepts with different slugs and otherwise-identical fields', async () => {
    // Proves the unique constraint is on slug ALONE — not name, description,
    // or any composite. Both rows survive into afterAll cleanup.
    const slugA = `${TEST_PREFIX}${RUN_ID}-twin-a`;
    const slugB = `${TEST_PREFIX}${RUN_ID}-twin-b`;
    const sharedFields = {
      name: 'KG unique slug — identical twin',
      description: 'same name + description, different slugs',
      status: 'ACTIVE'
    };
    await INSERT.into(Concepts).entries({ slug: slugA, ...sharedFields });
    await INSERT.into(Concepts).entries({ slug: slugB, ...sharedFields });
    const both = await SELECT.from(Concepts).where({ slug: { in: [slugA, slugB] } });
    expect(both).toHaveLength(2);
  });
});
