/**
 * Hybrid coverage for the /content/source-hashes companion fix.
 *
 * Independent of orphan-purge.test.js so a regression in the filter
 * surfaces here even when the purge endpoint test is green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const writesAllowed = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const describeIf = writesAllowed ? describe : describe.skip;

describeIf('/content/source-hashes — INACTIVE filter (hybrid)', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slug = `__test__sourcehashes-inactive-${ts}`;
  let srvUrl;

  beforeAll(async () => {
    srvUrl = process.env.CAP_BASE_URL || cds.server?.url || `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;
    const { Tutorials } = cds.entities(ns);
    await INSERT.into(Tutorials).entries({ slug, status: 'INACTIVE', title: '__TEST__ Inactive' });
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug });
  });

  it('does not return an INACTIVE slug from /content/source-hashes', async () => {
    const res = await fetch(`${srvUrl}/content/source-hashes`);
    expect(res.status).toBe(200);
    const map = await res.json();
    expect(map[slug]).toBeUndefined();
  });
});
