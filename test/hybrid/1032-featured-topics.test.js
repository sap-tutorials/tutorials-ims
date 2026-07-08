// test/hybrid/1032-featured-topics.test.js
//
// Plan: docs/superpowers/plans/2026-07-06-1032-featured-missions-carousel.md (task 11)
//
// Verifies the featured-topics carousel end-to-end against real HANA (DEV space):
//   1. AdminService.recomputeFeaturedTopics (SuperAdmin action) materialises a
//      FeaturedTopicsSnapshot from an editorial HomepageFeaturedTopics row.
//   2. HomepageService.featuredTopics() returns the snapshot via /homepage/featuredTopics()
//      with ETag + 304 support.
//   3. Slug canonical-form invariant: all slugs in the snapshot are lowercase.
//
// Runs against real HANA.  All writes are gated by ALLOW_HYBRID_WRITES=true and
// use a __TEST__ prefix to prevent production contamination.  afterAll cleans
// up in FK dependency order.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__ft-1032-';

const SUPERADMIN_AUTH = { auth: { username: 'superadmin', password: 'superadmin' } };

describe.runIf(isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true')(
  'featured-topics carousel end-to-end (Task 11) [hybrid]',
  () => {
    const cleanup = { concepts: [], featured: [], tutorials: [], snapshot: [] };
    let seededConceptSlug;
    let seededConceptId;

    beforeAll(async () => {
      const db = await cds.connect.to('db');
      const isHana =
        db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      if (!isHana) {
        throw new Error(
          '1032-featured-topics.test.js must run against HANA. ' +
            'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
        );
      }

      // Seed a Concept + HomepageFeaturedTopics editorial row so that
      // recomputeSnapshot has at least one editorial slot to materialise.
      const { Concepts, HomepageFeaturedTopics } = cds.entities(NS);

      seededConceptId = cds.utils.uuid();
      seededConceptSlug = (TEST_PREFIX + 'concept-' + seededConceptId.slice(0, 8)).toLowerCase();

      cleanup.concepts.push(seededConceptId);

      await cds.tx(async (tx) => {
        await tx.run(INSERT.into(Concepts).entries({
          ID: seededConceptId,
          slug: seededConceptSlug,
          name: TEST_PREFIX + 'Concept',
          status: 'ACTIVE',
          publishedAt: new Date().toISOString(),
        }));
      });

      const ftId = cds.utils.uuid();
      cleanup.featured.push(ftId);

      await cds.tx(async (tx) => {
        await tx.run(INSERT.into(HomepageFeaturedTopics).entries({
          ID: ftId,
          concept_ID: seededConceptId,
          displayTitle: TEST_PREFIX + 'Display Title',
          sortOrder: 1,
          isActive: true,
          // missionSlugs: empty — the carousel renders 0 mission cards, which is valid;
          // the slot still appears with the correct conceptSlug.
          missionSlugs: [],
        }));
      });
    }, 60_000);

    afterAll(async () => {
      const { Concepts, HomepageFeaturedTopics, FeaturedTopicsSnapshot } = cds.entities(NS);
      // FK order: HomepageFeaturedTopics → Concepts; FeaturedTopicsSnapshot is key-only.
      for (const id of cleanup.featured) {
        await cds.tx(async (tx) => tx.run(DELETE.from(HomepageFeaturedTopics).where({ ID: id })));
      }
      for (const id of cleanup.concepts) {
        await cds.tx(async (tx) => tx.run(DELETE.from(Concepts).where({ ID: id })));
      }
      // Best-effort: delete test slots from the snapshot table.
      // (The next nightly job or recompute call will overwrite them anyway.)
      await cds.tx(async (tx) =>
        tx.run(DELETE.from(FeaturedTopicsSnapshot).where({ conceptSlug: seededConceptSlug }))
      );
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 1 — recomputeFeaturedTopics materialises the seeded editorial row
    // -------------------------------------------------------------------------
    it('Test 1 — recomputeFeaturedTopics returns count ≥ 1 after seeding an editorial row', async () => {
      const app = cds.test;
      // POST /admin/recomputeFeaturedTopics  (SuperAdmin-gated unbound action)
      const res = await app.post(
        '/admin/recomputeFeaturedTopics',
        {},
        SUPERADMIN_AUTH
      );
      expect(res.status).toBeLessThan(300);
      expect(typeof res.data.count).toBe('number');
      expect(res.data.count).toBeGreaterThanOrEqual(1);
      expect(res.data.computedAt).toBeTruthy();
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 2 — /homepage/featuredTopics() returns the snapshot
    // -------------------------------------------------------------------------
    it('Test 2 — /homepage/featuredTopics() returns 200 with snapshot + etag after recompute', async () => {
      const app = cds.test;
      const res = await app.get('/homepage/featuredTopics()');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('snapshot');
      expect(res.data).toHaveProperty('etag');
      expect(Array.isArray(res.data.snapshot)).toBe(true);
      // The seeded editorial row must be present somewhere in the snapshot.
      const found = res.data.snapshot.find((s) => s.conceptSlug === seededConceptSlug);
      expect(found).toBeDefined();
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 3 — Slug canonical-form: all conceptSlugs and mission slugs are lowercase
    // -------------------------------------------------------------------------
    it('Test 3 — all slugs in snapshot are lowercase canonical', async () => {
      const app = cds.test;
      const res = await app.get('/homepage/featuredTopics()');
      expect(res.status).toBe(200);
      for (const slide of res.data.snapshot || []) {
        expect(slide.conceptSlug).toBe(slide.conceptSlug.toLowerCase());
        for (const m of slide.missions || []) {
          expect(m.slug).toBe(m.slug.toLowerCase());
        }
      }
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 4 — ETag + 304 round-trip
    // -------------------------------------------------------------------------
    it('Test 4 — /homepage/featuredTopics() honors If-None-Match with 304', async () => {
      const app = cds.test;
      const first = await app.get('/homepage/featuredTopics()');
      expect(first.status).toBe(200);
      const etag = first.headers.etag;
      expect(etag).toBeTruthy();

      const second = await app
        .get('/homepage/featuredTopics()', { headers: { 'If-None-Match': etag } })
        .catch((err) => err.response);
      expect(second.status).toBe(304);
    }, 60_000);
  }
);
