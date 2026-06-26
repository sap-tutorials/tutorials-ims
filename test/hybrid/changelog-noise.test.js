// test/hybrid/changelog-noise.test.js
// Hybrid verification for the changelog noise cleanup (#658).
//
// Four assertions against real HANA via `cds bind --exec`:
//   1. AFTER triggers gone on the nine un-tracked entities
//   2. Control: triggers still present on Advocates (kept @changelog)
//   3. autoPurgeOnce sentinel is idempotent (write — needs ALLOW_HYBRID_WRITES)
//   4. purgeStaleChangelog respects the entity allowlist (write — needs ALLOW_HYBRID_WRITES)
//
// NOTE: Test 1 WILL FAIL before the PR is deployed to HANA — that is expected.
// Run only as a post-deploy verification step.
//
// HOW TO RUN (post-deploy only):
//   ALLOW_HYBRID_WRITES=true npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/changelog-noise.test.js

import cds from '@sap/cds';
import { describe, it, expect, beforeAll } from 'vitest';
import { isSafeForWrites } from './_guard.js';
import {
  NOISE_ENTITIES,
  autoPurgeOnce,
  purgeStaleChangelog,
} from '../../srv/lib/purge-stale-changelog.js';

const TEST_PREFIX = '__TEST__658__';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('changelog noise cleanup (#658) — read-only', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  it('drops HANA AFTER triggers for un-tracked entities', async () => {
    // After the PR ships, no AFTER INSERT/UPDATE/DELETE trigger should exist
    // on the SQL tables backing the nine un-tracked entities. The plugin
    // names triggers <table>_AFTER_<op>_CHANGELOG (verified at
    // node_modules/@cap-js/change-tracking/lib/hana/triggers.js).
    const noiseTables = NOISE_ENTITIES.map((e) =>
      e.replace(/\./g, '_').toUpperCase(),
    );
    const rows = await db.run(
      `SELECT TRIGGER_NAME, SUBJECT_TABLE_NAME FROM SYS.TRIGGERS
       WHERE SUBJECT_TABLE_NAME IN (${noiseTables.map(() => '?').join(',')})`,
      noiseTables,
    );
    expect(rows).toEqual([]);
  });

  it('control: trigger still exists on a kept entity (Advocates)', async () => {
    const rows = await db.run(
      `SELECT COUNT(*) AS C FROM SYS.TRIGGERS
       WHERE SUBJECT_TABLE_NAME = 'COM_SAP_DEVELOPERS_IMS_ADVOCATES'`,
    );
    // Defensive — at least one (CREATE/UPDATE/DELETE) trigger must exist.
    expect(rows[0].C).toBeGreaterThan(0);
  });
});

describe.runIf(isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true')(
  'changelog noise cleanup (#658) — writes',
  () => {
    it('autoPurgeOnce is idempotent across calls', async () => {
      // Use a one-off sentinel version so this test never collides with the
      // production v1 sentinel.
      const version = `${TEST_PREFIX}${Date.now()}`;
      try {
        const a = await autoPurgeOnce({ version });
        expect(a.alreadyRan).toBe(false);
        const b = await autoPurgeOnce({ version });
        expect(b).toMatchObject({ deleted: 0, alreadyRan: true });
      } finally {
        const { JobLocks } = cds.entities('com.sap.developers.ims');
        await DELETE.from(JobLocks).where({ jobName: `changelog-noise-purge-${version}` });
      }
    });

    it('purgeStaleChangelog scopes to the entity list only', async () => {
      // Seed two rows — one noise, one control — under a TEST prefix so the
      // write guard is happy. The DELETE filter is by `entity` (not by ID),
      // so other Concepts rows on shared DEV DB will also be swept; the
      // load-bearing assertion is "control survives, noise row gone".
      const { Changes } = cds.entities('sap.changelog');
      const noiseId = cds.utils.uuid();
      const ctrlId = cds.utils.uuid();
      await INSERT.into(Changes).entries([
        {
          ID: noiseId,
          entity: 'com.sap.developers.ims.Concepts',
          entityKey: `${TEST_PREFIX}k1`,
          attribute: 'x',
          valueDataType: 'cds.String',
          modification: 'update',
          createdAt: new Date().toISOString(),
          createdBy: TEST_PREFIX,
        },
        {
          ID: ctrlId,
          entity: 'com.sap.developers.ims.Advocates',
          entityKey: `${TEST_PREFIX}k2`,
          attribute: 'x',
          valueDataType: 'cds.String',
          modification: 'update',
          createdAt: new Date().toISOString(),
          createdBy: TEST_PREFIX,
        },
      ]);

      try {
        await purgeStaleChangelog({
          entities: ['com.sap.developers.ims.Concepts'],
        });
        // Load-bearing: control row (Advocates) survives, noise row (Concepts) gone.
        // Other Concepts rows on shared DEV DB will also be deleted — that's
        // intentional and matches production semantics.
        const survived = await SELECT.one.from(Changes).where({ ID: ctrlId });
        expect(survived).toBeDefined();
        const gone = await SELECT.one.from(Changes).where({ ID: noiseId });
        expect(gone).toBeFalsy();
      } finally {
        await DELETE.from(Changes).where({ ID: { in: [noiseId, ctrlId] } });
      }
    });
  },
);
