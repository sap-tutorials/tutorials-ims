/**
 * Unit tests for POST /content/orphan-purge.
 *
 * The endpoint is bare-Express (not an AdminService action) — same auth
 * model as /content/publish (contentAuthMiddleware + CONTENT_API_KEY).
 * The CI's existing CONTENT_API_KEY secret authenticates the call.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-2
 *
 * Per-slug bucket dispatch:
 *   - slug in Tutorials with status=ACTIVE                  → purged[]
 *   - slug in Tutorials with status=INACTIVE                → alreadyInactive[]
 *   - slug in Tutorials with redirectTo_ID set              → redirected[]
 *     (the validator at admin-service.js:837-843 enforces these are
 *      always already-INACTIVE — the bucket exists so the operator
 *      sees them in the response instead of them silently landing in
 *      alreadyInactive)
 *   - slug NOT in Tutorials                                  → notFound[]
 *     (phantom ContentFiles row; requires operator action)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { _resetForTests as resetSecretResolver } from '../../srv/lib/secret-resolver.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('POST /content/orphan-purge', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slugActive    = `test-purge-active-${ts}`;
  const slugActive2   = `test-purge-active2-${ts}`;
  const slugInactive  = `test-purge-inactive-${ts}`;
  const slugRedirect  = `test-purge-redirect-${ts}`;   // INACTIVE + redirectTo_ID set
  const slugRedirectTarget = `test-purge-redirect-target-${ts}`;
  const slugMissing   = `test-purge-missing-${ts}`;     // not in Tutorials at all

  const headers = { 'authorization': `Bearer ${process.env.CONTENT_API_KEY || 'test-key'}`, 'x-initiator': 'test/unit-1' };

  beforeAll(async () => {
    // contentAuthMiddleware reads CONTENT_API_KEY via secret-resolver,
    // which caches in a globalThis singleton (5-min TTL). If another test
    // in the same worker primed the cache to null or a different value,
    // setting process.env here won't take effect. Reset explicitly —
    // matches the precedent at test/unit/mail-client-credstore.test.js.
    process.env.CONTENT_API_KEY = 'test-key';
    resetSecretResolver();
    const { Tutorials } = cds.entities(ns);
    const targetID = randomUUID();
    await INSERT.into(Tutorials).entries([
      { ID: randomUUID(),         slug: slugActive,         status: 'ACTIVE',   title: 'Active 1' },
      { ID: randomUUID(),         slug: slugActive2,        status: 'ACTIVE',   title: 'Active 2' },
      { ID: randomUUID(),         slug: slugInactive,       status: 'INACTIVE', title: 'Inactive' },
      { ID: targetID,             slug: slugRedirectTarget, status: 'ACTIVE',   title: 'Redirect target' },
      { ID: randomUUID(),         slug: slugRedirect,       status: 'INACTIVE', title: 'With redirect', redirectTo_ID: targetID },
    ]);
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug: { in: [slugActive, slugActive2, slugInactive, slugRedirect, slugRedirectTarget] } });
  });

  it('buckets slugs by per-slug behavior', async () => {
    const res = await project.post('/content/orphan-purge', { slugs: [slugActive, slugActive2, slugInactive, slugRedirect, slugMissing] }, { headers });
    expect(res.status).toBe(200);
    expect(res.data.purged.sort()).toEqual([slugActive, slugActive2].sort());
    expect(res.data.alreadyInactive).toEqual([slugInactive]);
    expect(res.data.redirected).toEqual([slugRedirect]);
    expect(res.data.notFound).toEqual([slugMissing]);
    expect(res.data.totalAttempted).toBe(5);
    expect(res.data.totalPurged).toBe(2);
    expect(typeof res.data.version).toBe('number');
  });

  it('flips Tutorials.status to INACTIVE for purged slugs', async () => {
    const { Tutorials } = cds.entities(ns);
    const rows = await SELECT.from(Tutorials).where({ slug: { in: [slugActive, slugActive2] } }).columns('slug', 'status');
    expect(rows.every(r => r.status === 'INACTIVE')).toBe(true);
  });

  it('returns 401 without bearer token', async () => {
    const res = await project.post('/content/orphan-purge', { slugs: [] }, { validateStatus: () => true });
    expect(res.status).toBe(401);
  });

  it('rejects > 100 slugs with 400', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `test-purge-bulk-${ts}-${i}`);
    const res = await project.post('/content/orphan-purge', { slugs: tooMany }, { headers, validateStatus: () => true });
    expect(res.status).toBe(400);
    expect(String(res.data.error?.message || res.data.error || res.data)).toMatch(/100-slug ceiling/i);
  });

  it('is idempotent — re-running yields all alreadyInactive', async () => {
    const res = await project.post('/content/orphan-purge', { slugs: [slugActive, slugActive2] }, { headers });
    expect(res.status).toBe(200);
    expect(res.data.alreadyInactive.sort()).toEqual([slugActive, slugActive2].sort());
    expect(res.data.purged).toEqual([]);
  });
});
