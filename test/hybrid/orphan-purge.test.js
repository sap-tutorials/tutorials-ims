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

    const { Tutorials } = cds.entities(ns);
    await INSERT.into(Tutorials).entries([
      { slug: slugA, status: 'ACTIVE', title: '__TEST__ Active A' },
      { slug: slugB, status: 'ACTIVE', title: '__TEST__ Active B' },
    ]);
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug: { in: [slugA, slugB] } });
  });

  it('flips both seeded slugs from ACTIVE to INACTIVE', async () => {
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
