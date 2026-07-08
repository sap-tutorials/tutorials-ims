// test/unit/set-preferred-event-region.test.js
// #1030 — setPreferredEventRegion action.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('setPreferredEventRegion', () => {
  beforeAll(async () => {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { like: '__test__-t15-%' } });
    await DELETE.from(Users).where({ sapId: { like: '__test__-t15-%' } });
  });

  afterAll(async () => {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { like: '__test__-t15-%' } });
    await DELETE.from(Users).where({ sapId: { like: '__test__-t15-%' } });
  });

  it('1. rejects anonymous caller with 401', async () => {
    const res = await project.post('/api/setPreferredEventRegion', { region: 'EMEA' })
      .catch(e => e);
    expect(res.response?.status ?? res.status).toBe(401);
  });

  it('2. rejects invalid region with 400', async () => {
    const res = await project.post(
      '/api/setPreferredEventRegion',
      { region: 'BOGUS' },
      { auth: { username: '__test__-t15-u2' } }
    ).catch(e => e);
    expect(res.response?.status ?? res.status).toBe(400);
  });

  it('3. auto-provisions Users row and inserts UserLearningPreferences on first save', async () => {
    const userUuid = '__test__-t15-u3';
    await project.post(
      '/api/setPreferredEventRegion',
      { region: 'EMEA' },
      { auth: { username: userUuid } }
    );
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const u = await SELECT.one.from(Users).where({ sapId: userUuid });
    expect(u).toBeDefined();
    const pref = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u.ID });
    expect(pref?.preferredEventRegion).toBe('EMEA');
  });

  it('4. updates existing UserLearningPreferences row on second call', async () => {
    const userUuid = '__test__-t15-u4';
    await project.post(
      '/api/setPreferredEventRegion',
      { region: 'EMEA' },
      { auth: { username: userUuid } }
    );
    await project.post(
      '/api/setPreferredEventRegion',
      { region: 'APJ' },
      { auth: { username: userUuid } }
    );
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const u = await SELECT.one.from(Users).where({ sapId: userUuid });
    const pref = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u.ID });
    expect(pref?.preferredEventRegion).toBe('APJ');
  });

  it('5. clears to null when passed null', async () => {
    const userUuid = '__test__-t15-u5';
    await project.post(
      '/api/setPreferredEventRegion',
      { region: 'EMEA' },
      { auth: { username: userUuid } }
    );
    await project.post(
      '/api/setPreferredEventRegion',
      { region: null },
      { auth: { username: userUuid } }
    );
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const u = await SELECT.one.from(Users).where({ sapId: userUuid });
    const pref = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u.ID });
    expect(pref?.preferredEventRegion).toBeNull();
  });

  it('6. accepts VIRTUAL and ALL as UI-mode values', async () => {
    const u5uuid = '__test__-t15-u6v';
    const u6uuid = '__test__-t15-u6a';
    await project.post(
      '/api/setPreferredEventRegion',
      { region: 'VIRTUAL' },
      { auth: { username: u5uuid } }
    );
    await project.post(
      '/api/setPreferredEventRegion',
      { region: 'ALL' },
      { auth: { username: u6uuid } }
    );
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const u5 = await SELECT.one.from(Users).where({ sapId: u5uuid });
    const p5 = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u5.ID });
    expect(p5?.preferredEventRegion).toBe('VIRTUAL');
    const u6 = await SELECT.one.from(Users).where({ sapId: u6uuid });
    const p6 = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u6.ID });
    expect(p6?.preferredEventRegion).toBe('ALL');
  });
});
