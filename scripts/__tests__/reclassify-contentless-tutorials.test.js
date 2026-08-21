import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { reclassifyContentless } from '../reclassify-contentless-tutorials.cjs';

// Boot the app in-memory so the ${NS} entities + cds.ql globals the script
// uses resolve exactly as they do under `cds bind --exec`. Mirrors
// test/search-service.test.js.
cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';
// Quiet the script's own logger during the run.
const silentLog = { info() {}, warn() {}, error() {} };

describe('reclassify-contentless-tutorials (#1960)', () => {
  beforeAll(async () => {
    const { Tutorials, ContentManifest, ContentFiles } = cds.entities(NS);

    // Two manifest versions: v4 (SUPERSEDED, stale) and v5 (ACTIVE, live).
    await INSERT.into(ContentManifest).entries([
      { version: 4, status: 'SUPERSEDED' },
      { version: 5, status: 'ACTIVE' },
    ]);

    // Live content set at the ACTIVE version (v5). 'stale-version' only exists
    // at v4, so it does NOT serve. 'mixedcase-tut' content is stored lowercase.
    await INSERT.into(ContentFiles).entries([
      { slug: 'live-tut', version: 5, mimeType: 'text/html' },
      { slug: 'mixedcase-tut', version: 5, mimeType: 'text/html' },
      { slug: 'stale-version', version: 4, mimeType: 'text/html' },
    ]);

    await INSERT.into(Tutorials).entries([
      // Serves at v5 → must be kept.
      { ID: 'rc-live', legacyId: 95001, slug: 'live-tut', title: 'Live Tutorial', status: 'ACTIVE' },
      // Case-insensitive: content under lowercase slug → must be kept.
      { ID: 'rc-mixed', legacyId: 95002, slug: 'MixedCase-Tut', title: 'Mixed Case', status: 'ACTIVE' },
      // ACTIVE but no content at any version → phantom, must be flipped.
      { ID: 'rc-phantom-active', legacyId: 95003, slug: 'phantom-active', title: 'Phantom Active', status: 'ACTIVE' },
      // null status + no content → phantom, must be flipped.
      { ID: 'rc-phantom-null', legacyId: 95004, slug: 'phantom-null', title: 'Phantom Null', status: null },
      // Content only at the stale v4, not the active v5 → must be flipped.
      { ID: 'rc-stale', legacyId: 95005, slug: 'stale-version', title: 'Stale Version', status: 'ACTIVE' },
      // Already DELETED → not a candidate, must be untouched.
      { ID: 'rc-deleted', legacyId: 95006, slug: 'gone', title: 'Gone', status: 'DELETED' },
      // INACTIVE (admin-managed) with no content → NOT ACTIVE/null, must be untouched.
      { ID: 'rc-inactive', legacyId: 95007, slug: 'held', title: 'Held', status: 'INACTIVE' },
    ]);
  });

  it('dry-run selects exactly the contentless ACTIVE/null rows and changes nothing', async () => {
    const { Tutorials } = cds.entities(NS);
    const res = await reclassifyContentless({ commit: false, log: silentLog });

    expect(res.activeVersion).toBe(5);
    const slugs = res.toDelete.map((r) => r.slug).sort();
    expect(slugs).toEqual(['phantom-active', 'phantom-null', 'stale-version']);
    expect(res.updated).toBe(0);

    // Nothing mutated on a dry run.
    const after = await SELECT.from(Tutorials).columns('ID', 'status')
      .where({ ID: { in: ['rc-phantom-active', 'rc-phantom-null', 'rc-stale'] } });
    for (const r of after) expect(r.status).not.toBe('DELETED');
  });

  it('commit flips only the contentless rows to DELETED, sparing live/case/held/gone', async () => {
    const { Tutorials } = cds.entities(NS);
    const res = await reclassifyContentless({ commit: true, targetStatus: 'DELETED', log: silentLog });
    expect(res.updated).toBe(3);

    const rows = await SELECT.from(Tutorials).columns('ID', 'slug', 'status')
      .where({ ID: { like: 'rc-%' } });
    const byId = Object.fromEntries(rows.map((r) => [r.ID, r.status]));

    // Flipped:
    expect(byId['rc-phantom-active']).toBe('DELETED');
    expect(byId['rc-phantom-null']).toBe('DELETED');
    expect(byId['rc-stale']).toBe('DELETED');
    // Spared:
    expect(byId['rc-live']).toBe('ACTIVE');       // serves at v5
    expect(byId['rc-mixed']).toBe('ACTIVE');      // case-insensitive content match
    expect(byId['rc-inactive']).toBe('INACTIVE'); // not a candidate
    expect(byId['rc-deleted']).toBe('DELETED');   // already DELETED, untouched
  });

  it('is idempotent — a second commit run finds nothing left to flip', async () => {
    const res = await reclassifyContentless({ commit: true, targetStatus: 'DELETED', log: silentLog });
    expect(res.toDelete.length).toBe(0);
    expect(res.updated).toBe(0);
  });
});
