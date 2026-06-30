/**
 * Hybrid test — exercises /content/orphan-purge against real HANA.
 * Gated by ALLOW_HYBRID_WRITES=true per test/hybrid/_guard.js.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Testing
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const writesAllowed = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const describeIf = writesAllowed ? describe : describe.skip;

describeIf('POST /content/orphan-purge — hybrid (real HANA)', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slugA = `__test__purge-orphan-a-${ts}`;
  const slugB = `__test__purge-orphan-b-${ts}`;
  let srvUrl;
  let apiKey;

  beforeAll(async () => {
    srvUrl = process.env.CAP_BASE_URL || cds.server?.url || `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;
    apiKey = process.env.CONTENT_API_KEY;
    if (!apiKey) throw new Error('CONTENT_API_KEY env var required for hybrid orphan-purge test');

    // Read the current ACTIVE manifest version (do NOT seed one — we
    // piggyback on real DEV state so the seeded ContentFiles rows show
    // up in /content/source-hashes which only reports the active version).
    const { ContentManifest, ContentFiles, Tutorials } = cds.entities(ns);
    const [activeManifest] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('version')
      .orderBy('version desc')
      .limit(1);
    if (!activeManifest) throw new Error('No ACTIVE ContentManifest found in DEV — cannot seed test fixtures');
    const activeVersion = activeManifest.version;

    await INSERT.into(Tutorials).entries([
      { slug: slugA, status: 'ACTIVE', title: '__TEST__ Active A' },
      { slug: slugB, status: 'ACTIVE', title: '__TEST__ Active B' },
    ]);

    // Seed matching ContentFiles rows so the /content/source-hashes
    // assertion is non-vacuous. The endpoint's driving table is
    // ContentFiles (see srv/lib/content-store.js, SELECT FROM
    // ContentFiles LEFT JOIN Tutorials). Without these rows the seeded
    // slugs aren't in the response set regardless of the INACTIVE
    // filter, and a regression that drops the filter would still pass.
    await INSERT.into(ContentFiles).entries([
      {
        slug: slugA,
        version: activeVersion,
        content: Buffer.from('test'),
        contentHash: 'a'.repeat(64),
        sizeBytes: 4,
        compressedBytes: 4,
        mimeType: 'text/html',
        sourceContent: Buffer.from('# test'),
        sourceHash: 'b'.repeat(64),
      },
      {
        slug: slugB,
        version: activeVersion,
        content: Buffer.from('test'),
        contentHash: 'c'.repeat(64),
        sizeBytes: 4,
        compressedBytes: 4,
        mimeType: 'text/html',
        sourceContent: Buffer.from('# test'),
        sourceHash: 'd'.repeat(64),
      },
    ]);
  });

  afterAll(async () => {
    const { ContentFiles, Tutorials } = cds.entities(ns);
    await DELETE.from(ContentFiles).where({ slug: { in: [slugA, slugB] } });
    await DELETE.from(Tutorials).where({ slug: { in: [slugA, slugB] } });
  });

  it('flips both seeded slugs from ACTIVE to INACTIVE', async () => {
    // Pre-purge sanity: confirm the slugs DO appear in /content/source-hashes
    // BEFORE the purge. Without this, the post-purge "absent" assertion is a
    // vacuous truth — the slugs would be absent whether or not the INACTIVE
    // filter clause exists. Seeding ContentFiles in beforeAll + this check =
    // genuine coverage of the filter clause.
    const preRes = await fetch(`${srvUrl}/content/source-hashes`);
    expect(preRes.status).toBe(200);
    const preMap = await preRes.json();
    expect(preMap[slugA]).toBe('b'.repeat(64));
    expect(preMap[slugB]).toBe('d'.repeat(64));

    const res = await fetch(`${srvUrl}/content/orphan-purge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'x-initiator':   `test/hybrid-${ts}`
      },
      body: JSON.stringify({ slugs: [slugA, slugB] })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purged.sort()).toEqual([slugA, slugB].sort());
    expect(body.totalPurged).toBe(2);

    const { Tutorials } = cds.entities(ns);
    const rows = await SELECT.from(Tutorials).where({ slug: { in: [slugA, slugB] } }).columns('slug', 'status');
    expect(rows.every(r => r.status === 'INACTIVE')).toBe(true);
  });

  it('removes purged slugs from /content/source-hashes', async () => {
    const res = await fetch(`${srvUrl}/content/source-hashes`);
    const map = await res.json();
    expect(map[slugA]).toBeUndefined();
    expect(map[slugB]).toBeUndefined();
  });

  it('removes purged slugs from /build/catalog', async () => {
    // Spec §Testing-hybrid: purged slugs must disappear from /build/catalog.
    // The catalog handler filters tutorials by `status = 'ACTIVE' or status
    // is null` (srv/lib/build-catalog.js), so post-purge INACTIVE slugs are
    // dropped. We string-search the serialized JSON to be robust against any
    // catalog shape change (tutorial-list / mission-hierarchy / featured /
    // etc.). The test slugs have a unique `__test__purge-orphan-*-<ts>`
    // prefix so this is collision-safe.
    const res = await fetch(`${srvUrl}/build/catalog`);
    expect(res.status).toBe(200);
    const catalog = await res.json();
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain(slugA);
    expect(serialized).not.toContain(slugB);
  });

  it('records a PipelineLog row with metadata.stage=purge-orphans', async () => {
    const { PipelineLog } = cds.entities(ns);
    const rows = await SELECT.from(PipelineLog)
      .where({ initiator: `test/hybrid-${ts}`, pipelineType: 'SCHEDULED_JOB' })
      .columns('ID', 'metadata', 'status');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].metadata).toMatch(/"stage":"purge-orphans"/);
    expect(rows[0].status).toBe('SUCCESS');
  });
});
