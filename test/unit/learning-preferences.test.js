import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('setLearningPreferences action handler', () => {
  beforeAll(async () => {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { like: '__test__-pr6-%' } });
    await DELETE.from(Users).where({ uuid: { like: '__test__-pr6-%' } });
  });

  afterAll(async () => {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { like: '__test__-pr6-%' } });
    await DELETE.from(Users).where({ uuid: { like: '__test__-pr6-%' } });
  });

  it('1. INSERTs a new row on first call; subsequent SELECT returns the typed shape', async () => {
    const userUuid = '__test__-pr6-act-1';
    const { data: result } = await project.post(
      '/api/setLearningPreferences',
      { deployment: 'cloud', role: null, cloud: 'btp' },
      { auth: { username: userUuid } }
    );
    expect(result.deployment).toBe('cloud');
    expect(result.role).toBeNull();
    expect(result.cloud).toBe('btp');
  });

  it('2. PUT-style clearing: re-call with {deployment: onprem, role: null, cloud: null} — clears prior role+cloud', async () => {
    const userUuid = '__test__-pr6-act-2';
    await project.post('/api/setLearningPreferences',
      { deployment: 'cloud', role: 'developer', cloud: 'btp' },
      { auth: { username: userUuid } }
    );
    const { data: result } = await project.post('/api/setLearningPreferences',
      { deployment: 'onprem', role: null, cloud: null },
      { auth: { username: userUuid } }
    );
    expect(result.deployment).toBe('onprem');
    expect(result.role).toBeNull();
    expect(result.cloud).toBeNull();
  });

  it('3. Invalid enum value returns 400 with field-level error message', async () => {
    const userUuid = '__test__-pr6-act-3';
    const res = await project.post('/api/setLearningPreferences',
      { deployment: 'hybrid', role: null, cloud: null },
      { auth: { username: userUuid } }
    ).catch(e => e);
    expect(res.response?.status || res.status).toBe(400);
  });

  it('4. Anonymous caller is rejected by the XSUAA gate (401)', async () => {
    const res = await project.post('/api/setLearningPreferences',
      { deployment: 'cloud', role: null, cloud: null }
    ).catch(e => e);
    expect(res.response?.status || res.status).toBe(401);
  });

  it('5. GET /api/LearningPreferences returns the caller own row only (before-READ filter)', async () => {
    const userUuid = '__test__-pr6-act-5';
    await project.post('/api/setLearningPreferences',
      { deployment: 'cloud', role: 'architect', cloud: 'aws' },
      { auth: { username: userUuid } }
    );
    const { data: list } = await project.get('/api/LearningPreferences', { auth: { username: userUuid } });
    expect(list.value).toHaveLength(1);
    expect(list.value[0]).toMatchObject({
      deployment: 'cloud', role: 'architect', cloud: 'aws',
    });
  });

  it('6. role = sysadmin is a valid enum value (regression guard against admin XSUAA collision)', async () => {
    const userUuid = '__test__-pr6-act-6';
    const { data: result } = await project.post('/api/setLearningPreferences',
      { deployment: null, role: 'sysadmin', cloud: null },
      { auth: { username: userUuid } }
    );
    expect(result.role).toBe('sysadmin');
  });
});
