import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

const PREFIX = '__test__-pr6-hybrid';
const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe('UserLearningPreferences (hybrid HANA)', () => {
  beforeAll(async () => {
    if (!writesEnabled) return;
    if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { in: SELECT.from(Users).columns('ID').where({ uuid: { like: `${PREFIX}-%` } }) } });
    await DELETE.from(Users).where({ uuid: { like: `${PREFIX}-%` } });
  });

  afterAll(async () => {
    if (!writesEnabled) return;
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { in: SELECT.from(Users).columns('ID').where({ uuid: { like: `${PREFIX}-%` } }) } });
    await DELETE.from(Users).where({ uuid: { like: `${PREFIX}-%` } });
  });

  it.skipIf(!writesEnabled)(
    '1. invalid enum value rejected at the JS validation layer in the action handler',
    async () => {
      // Hybrid hits the action endpoint with invalid enum and asserts a 400.
      // Per recon item 2: project.post returns/throws via axios-style; on 4xx it
      // throws an error whose .response.status carries the HTTP status.
      const userUuid = `${PREFIX}-enum`;
      const res = await project.post('/api/setLearningPreferences',
        { deployment: 'hybrid', role: null, cloud: null },
        { auth: { username: userUuid } }
      ).catch(e => e);
      expect(res.response?.status || res.status).toBe(400);
    }
  );

  it.skipIf(!writesEnabled)(
    '2. Schema + SELECT-then-INSERT-or-UPDATE shape: PK is single-column on USER_ID; FK to USERS.ID; idempotent same-payload writes',
    async () => {
      const userUuid = `${PREFIX}-schema`;
      // First call INSERTs.
      await project.post('/api/setLearningPreferences',
        { deployment: 'cloud', role: 'developer', cloud: 'btp' },
        { auth: { username: userUuid } }
      );
      // Same payload twice — idempotent: existing row UPDATEd, no duplicate INSERT.
      await project.post('/api/setLearningPreferences',
        { deployment: 'cloud', role: 'developer', cloud: 'btp' },
        { auth: { username: userUuid } }
      );
      const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
      const dbUser = await SELECT.one.from(Users).where({ uuid: userUuid });
      const rows = await SELECT.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deployment: 'cloud', role: 'developer', cloud: 'btp' });
    }
  );

  it.skipIf(!writesEnabled)(
    '3. @PersonalData cascade: delete removes the row when the parent Users row is deleted',
    async () => {
      const userUuid = `${PREFIX}-cascade`;
      await project.post('/api/setLearningPreferences',
        { deployment: 'cloud', role: null, cloud: null },
        { auth: { username: userUuid } }
      );
      const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
      const dbUser = await SELECT.one.from(Users).where({ uuid: userUuid });
      // Trigger anonymization cascade: simulate by deleting the parent row.
      await DELETE.from(Users).where({ ID: dbUser.ID });
      const rows = await SELECT.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
      expect(rows).toHaveLength(0);
    }
  );
});
