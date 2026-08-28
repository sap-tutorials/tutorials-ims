// test/unit/admin-feature-flags-toggle.test.js
//
// #2060 — bound enable()/disable() row actions on AdminService.FeatureFlags.
// The viewer is @cds.persistence.skip, so these actions flip the backing
// ImsConfig row for a kind:'db' flag and return the freshly re-resolved row.
// Generic flags (flag.*) route through db-flags.js; content.delta.* flags route
// through the dedicated content-delta module. Non-db flags reject with 400.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import { bustFeatureFlagsCache } from '../../srv/lib/feature-flags/db-flags.js';
import { bustContentDeltaFlagsCache } from '../../srv/lib/content-delta-flags.js';

const NS = 'com.sap.developers.ims';
const project = cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

let db, ImsConfig;

async function readIms(key) {
  const row = await db.run(SELECT.one.from(ImsConfig).where({ key }));
  return row ? String(row.value).toLowerCase() : null;
}

describe('AdminService.FeatureFlags bound enable/disable (#2060)', () => {
  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ ImsConfig } = cds.entities(NS));
    await db.run(DELETE.from(ImsConfig).where({
      key: { in: ['flag.kg.pagerank', 'content.delta.write'] },
    }));
    bustFeatureFlagsCache();
    bustContentDeltaFlagsCache();
  });

  afterAll(() => { bustFeatureFlagsCache(); bustContentDeltaFlagsCache(); });

  it('enable() on a generic db flag upserts flag.* to true and flips the resolved row', async () => {
    const res = await project.post(
      `/admin/FeatureFlags(key='KG_PAGERANK_ENABLED')/AdminService.enable`,
      {},
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    expect(res.data.key).toBe('KG_PAGERANK_ENABLED');
    expect(res.data.enabled).toBe(true);
    expect(res.data.winningLayer).toBe('db');
    expect(await readIms('flag.kg.pagerank')).toBe('true');
  });

  it('disable() on a generic db flag upserts flag.* to false', async () => {
    // enable first, then disable.
    await project.post(`/admin/FeatureFlags(key='KG_PAGERANK_ENABLED')/AdminService.enable`, {}, ADMIN_AUTH);
    const res = await project.post(
      `/admin/FeatureFlags(key='KG_PAGERANK_ENABLED')/AdminService.disable`,
      {},
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    expect(res.data.enabled).toBe(false);
    expect(await readIms('flag.kg.pagerank')).toBe('false');
  });

  it('enable() on a content.delta.* flag routes to the content.delta ImsConfig key', async () => {
    const res = await project.post(
      `/admin/FeatureFlags(key='CONTENT_DELTA_WRITE_ENABLED')/AdminService.enable`,
      {},
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    expect(res.data.key).toBe('CONTENT_DELTA_WRITE_ENABLED');
    expect(res.data.enabled).toBe(true);
    expect(await readIms('content.delta.write')).toBe('true');
  });

  it('rejects a non-db flag (db-setting) with 400', async () => {
    const res = await project.post(
      `/admin/FeatureFlags(key='KNOWLEDGE_GRAPH_ENABLED')/AdminService.enable`,
      {},
      { ...ADMIN_AUTH, validateStatus: () => true },
    );
    expect(res.status).toBe(400);
  });

  it('rejects a constant flag with 400', async () => {
    const res = await project.post(
      `/admin/FeatureFlags(key='KG_WEIGHT')/AdminService.disable`,
      {},
      { ...ADMIN_AUTH, validateStatus: () => true },
    );
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated callers', async () => {
    const res = await project.post(
      `/admin/FeatureFlags(key='KG_PAGERANK_ENABLED')/AdminService.enable`,
      {},
      { validateStatus: () => true },
    );
    expect(res.status).toBe(401);
  });
});
