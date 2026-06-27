// Hybrid HANA test for GET /api/advocates/:slug — seeds an advocate + linked
// user + one authored tutorial + one contributed tutorial on real HANA, hits
// the public endpoint, asserts the response shape, then cleans up.
//
// The unit suite (SQLite) at test/unit/advocates/advocate-single-route.test.js
// covers the route in-memory; this is the only place where the per-advocate
// authored/contributed-tutorial joins actually round-trip through HANA's
// SELECT ... WHERE ID IN (...) compile path against the FK columns the user
// link adds (Advocates.user_ID, Tutorials.author_ID, TutorialContributors.user_ID).
//
// Run with: ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/advocate-profile-route.test.js
// Requires: `cf login` to a HANA-bound CF space first.
//
// Spec: docs/superpowers/specs/2026-06-26-per-advocate-profile-pages-design.md

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { isSafeForWrites } from './_guard.js';

const allowWrites = isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true';

// Only boot the CAP server when this test will actually run — `cds.test('serve')`
// at import-time eagerly attaches the xsuaa auth middleware (configured in
// .cdsrc.json's [hybrid] profile), which crashes the whole suite when no xsuaa
// instance is bound (`cds bind` was not run for this project). Gating the
// `cds.test()` call keeps the test inert in environments that can't satisfy
// the binding, which is what `describe.runIf(...)` is for at the assertion
// layer but can't help at the module-init layer.
const project = allowWrites ? cds.test('serve', '--project', '.', '--profile', 'hybrid') : null;

const TEST_PREFIX = '__TEST__601_';
const NONCE = Date.now().toString(36);
const advocateSlug = `${TEST_PREFIX}profile-amer-${NONCE}`;
const userEmail = `${TEST_PREFIX}profile-user-${NONCE}@example.test`;
const authoredSlug = `${TEST_PREFIX}tut-authored-${NONCE}`;
const contribSlug = `${TEST_PREFIX}tut-contrib-${NONCE}`;

describe.runIf(allowWrites)(
  'GET /api/advocates/:slug (HANA)',
  () => {
    let advocateId, userId, authoredTutorialId, contribTutorialId;

    beforeAll(async () => {
      const db = await cds.connect.to('db');
      const { Advocates, Users, Tutorials, TutorialContributors } =
        cds.entities('com.sap.developers.ims');

      // Pre-allocate UUIDs so cleanup is deterministic even if a SELECT-back
      // fails. Users.uuid is @mandatory String(36) — must be a real UUID.
      userId = randomUUID();
      advocateId = randomUUID();
      authoredTutorialId = randomUUID();
      contribTutorialId = randomUUID();

      await db.run(INSERT.into(Users).entries({
        ID: userId,
        uuid: randomUUID(),
        email: userEmail,
        firstName: '__TEST__Author',
        lastName: 'For601',
        displayName: '__TEST__Author For601',
      }));

      await db.run(INSERT.into(Advocates).entries({
        ID: advocateId,
        slug: advocateSlug,
        firstName: '__TEST__Profile',
        lastName: 'Amer',
        region: 'AMERICAS',
        isActive: true,
        bio: 'Hybrid test bio',
        user_ID: userId,
      }));

      // Tutorials: slug + title are both @mandatory (via TaskBase).
      await db.run(INSERT.into(Tutorials).entries({
        ID: authoredTutorialId,
        slug: authoredSlug,
        title: '__TEST__ Authored Tutorial',
        author_ID: userId,
      }));

      await db.run(INSERT.into(Tutorials).entries({
        ID: contribTutorialId,
        slug: contribSlug,
        title: '__TEST__ Contributed Tutorial',
      }));

      await db.run(INSERT.into(TutorialContributors).entries({
        ID: randomUUID(),
        tutorial_ID: contribTutorialId,
        user_ID: userId,
      }));
    });

    afterAll(async () => {
      // Cleanup order: children → parents so FK constraints don't bite.
      // Wrapped per-statement so a single failure doesn't strand the rest.
      const db = await cds.connect.to('db');
      const { Advocates, Users, Tutorials, TutorialContributors } =
        cds.entities('com.sap.developers.ims');

      const safe = async (label, fn) => {
        try { await fn(); } catch (err) { console.warn(`cleanup ${label}:`, err.message); }
      };

      // TutorialContributors first (FK → Users + Tutorials).
      await safe('TutorialContributors', () =>
        db.run(DELETE.from(TutorialContributors).where({ user_ID: userId })));
      // Advocates next (FK → Users via user_ID).
      await safe('Advocates', () =>
        db.run(DELETE.from(Advocates).where({ ID: advocateId })));
      // Tutorials (FK → Users via author_ID).
      await safe('Tutorials', () =>
        db.run(DELETE.from(Tutorials).where({
          ID: { in: [authoredTutorialId, contribTutorialId] },
        })));
      // Users last.
      await safe('Users', () =>
        db.run(DELETE.from(Users).where({ ID: userId })));
    });

    it('returns the expected shape with email + authored + contributed tutorials', async () => {
      const res = await project.get('/api/advocates/' + advocateSlug);
      expect(res.status).toBe(200);
      expect(res.data.slug).toBe(advocateSlug);
      expect(res.data.email).toBe(userEmail);
      expect(res.data.authoredTutorials).toBeTruthy();
      expect(res.data.authoredTutorials).toHaveLength(1);
      expect(res.data.authoredTutorials[0].slug).toBe(authoredSlug);
      expect(res.data.contributedTutorials).toBeTruthy();
      expect(res.data.contributedTutorials).toHaveLength(1);
      expect(res.data.contributedTutorials[0].slug).toBe(contribSlug);
    });
  },
);
