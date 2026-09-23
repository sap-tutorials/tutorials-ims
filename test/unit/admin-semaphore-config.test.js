// test/unit/admin-semaphore-config.test.js
//
// #2477 — AdminService.SemaphoreConfig: a @cds.persistence.skip viewer over the
// semaphore.sync.* ImsConfig tuning keys, with bound setValue(value)/clearValue()
// actions. READ synthesizes one row per shared descriptor key (defaults layered
// under any live ImsConfig value); setValue upserts the raw row; clearValue
// deletes it so the documented default takes effect again. Unknown keys reject.

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { SEMAPHORE_CONFIG_KEYS } from '../../srv/lib/semaphore-sync/config-keys.js';

const NS = 'com.sap.developers.ims';
const project = cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

let db, ImsConfig;
const ALL_KEYS = SEMAPHORE_CONFIG_KEYS.map((k) => k.key);

async function readIms(key) {
  const row = await db.run(SELECT.one.from(ImsConfig).where({ key }));
  return row ? String(row.value) : null;
}

describe('AdminService.SemaphoreConfig viewer + setValue/clearValue (#2477)', () => {
  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ ImsConfig } = cds.entities(NS));
    await db.run(DELETE.from(ImsConfig).where({ key: { in: ALL_KEYS } }));
  });

  it('READ synthesizes every descriptor key with its default when ImsConfig is empty', async () => {
    const res = await project.get('/admin/SemaphoreConfig', ADMIN_AUTH);
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(rows.map((r) => r.key).sort()).toEqual([...ALL_KEYS].sort());
    for (const d of SEMAPHORE_CONFIG_KEYS) {
      const row = rows.find((r) => r.key === d.key);
      expect(row.isDefault).toBe(true);
      expect(row.rawDbValue).toBeNull();
      expect(row.effectiveValue).toBe(String(d.default ?? ''));
      expect(row.defaultValue).toBe(String(d.default ?? ''));
      expect(row.valueType).toBe(d.valueType);
    }
  });

  it('setValue upserts a string key and the resolved row reflects it', async () => {
    const res = await project.post(
      `/admin/SemaphoreConfig(key='semaphore.sync.model')/AdminService.setValue`,
      { value: 'SAPExtended' },
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    expect(res.data.key).toBe('semaphore.sync.model');
    expect(res.data.effectiveValue).toBe('SAPExtended');
    expect(res.data.rawDbValue).toBe('SAPExtended');
    expect(res.data.isDefault).toBe(false);
    expect(await readIms('semaphore.sync.model')).toBe('SAPExtended');
  });

  it('setValue round-trips a csv value verbatim (parsing is the job’s concern)', async () => {
    const res = await project.post(
      `/admin/SemaphoreConfig(key='semaphore.sync.actualTagClasses')/AdminService.setValue`,
      { value: 'Topic, Product ,  Skill' },
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    expect(res.data.effectiveValue).toBe('Topic, Product ,  Skill');
    expect(await readIms('semaphore.sync.actualTagClasses')).toBe('Topic, Product ,  Skill');
  });

  it('setValue stores a bool key as its string and updates in place on re-set', async () => {
    await project.post(
      `/admin/SemaphoreConfig(key='semaphore.sync.dryRun')/AdminService.setValue`,
      { value: 'false' }, ADMIN_AUTH,
    );
    expect(await readIms('semaphore.sync.dryRun')).toBe('false');
    // Re-set updates the same row (no duplicate insert).
    const res = await project.post(
      `/admin/SemaphoreConfig(key='semaphore.sync.dryRun')/AdminService.setValue`,
      { value: 'true' }, ADMIN_AUTH,
    );
    expect(res.data.effectiveValue).toBe('true');
    const rows = await db.run(SELECT.from(ImsConfig).where({ key: 'semaphore.sync.dryRun' }));
    expect(rows.length).toBe(1);
  });

  it('clearValue removes the row so the default takes effect again', async () => {
    await project.post(
      `/admin/SemaphoreConfig(key='semaphore.sync.model')/AdminService.setValue`,
      { value: 'SAPExtended' }, ADMIN_AUTH,
    );
    expect(await readIms('semaphore.sync.model')).toBe('SAPExtended');
    const res = await project.post(
      `/admin/SemaphoreConfig(key='semaphore.sync.model')/AdminService.clearValue`,
      {}, ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    expect(res.data.isDefault).toBe(true);
    expect(res.data.effectiveValue).toBe('SAPCore');
    expect(await readIms('semaphore.sync.model')).toBeNull();
  });

  it('setValue rejects a key outside the semaphore.sync.* allowlist with 400', async () => {
    const FOREIGN = 'semaphore.sync.notAKey';
    await db.run(DELETE.from(ImsConfig).where({ key: FOREIGN }));
    const res = await project.post(
      `/admin/SemaphoreConfig(key='${FOREIGN}')/AdminService.setValue`,
      { value: 'true' },
      { ...ADMIN_AUTH, validateStatus: () => true },
    );
    expect(res.status).toBe(400);
    // And the non-allowlisted key was NOT written.
    expect(await readIms(FOREIGN)).toBeNull();
  });

  it('rejects unauthenticated callers', async () => {
    const res = await project.post(
      `/admin/SemaphoreConfig(key='semaphore.sync.model')/AdminService.setValue`,
      { value: 'x' },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(401);
  });
});
