import { describe, it, expect, vi, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('homepage-link-health job', () => {
  let runHomepageLinkHealth, toAbsoluteUrl;

  beforeAll(async () => {
    ({ runHomepageLinkHealth, toAbsoluteUrl } =
      await import('../../srv/jobs/homepage-link-health.js'));
  });

  it('marks reachable URLs OK and slow URLs SLOW', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('slow.example')) {
        await new Promise(r => setTimeout(r, 100));
        return new Response('', { status: 200 });
      }
      return new Response('', { status: 200 });
    }));

    const db = await cds.connect.to('db');
    const fastId = cds.utils.uuid();
    const slowId = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries([
      { ID: fastId, verb: 'BUILD',  shelf: 'TOOLS', sortOrder: 1, title: 'Fast', url: 'https://fast.example', isActive: true },
      { ID: slowId, verb: 'BUILD',  shelf: 'TOOLS', sortOrder: 2, title: 'Slow', url: 'https://slow.example', isActive: true }
    ]));

    await runHomepageLinkHealth({ slowThresholdMs: 50 });

    const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
      .where`ID in (${fastId}, ${slowId})`);
    const byId = Object.fromEntries(rows.map(r => [r.ID, r]));
    expect(byId[fastId].linkStatus).toBe('OK');
    expect(byId[slowId].linkStatus).toBe('SLOW');
    expect(byId[fastId].lastChecked).toBeTruthy();
  });

  it('marks broken URLs BROKEN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const db = await cds.connect.to('db');
    const id = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      ID: id, verb: 'INTEGRATE', shelf: 'TOOLS', sortOrder: 1, title: 'Broken',
      url: 'https://broken.example', isActive: true
    }));
    await runHomepageLinkHealth();
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves').where({ ID: id }));
    expect(row.linkStatus).toBe('BROKEN');
  });

  it('skips inactive entries', async () => {
    const stub = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    const db = await cds.connect.to('db');
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      ID: cds.utils.uuid(), verb: 'AI', shelf: 'TOOLS', sortOrder: 1,
      title: 'Inactive', url: 'https://inactive.example', isActive: false
    }));
    await runHomepageLinkHealth();
    expect(stub.mock.calls.some(c => String(c[0]).includes('inactive.example'))).toBe(false);
  });

  // Regression: root-relative internal links (e.g. /missions/) used to make
  // fetch() throw ("Failed to parse URL") → caught → falsely BROKEN.
  it('resolves root-relative internal links against the configured base URL', async () => {
    const stub = vi.fn(async (url) => {
      // Only an ABSOLUTE URL built from the configured base should reach fetch.
      if (url === 'https://dev.example/topics/btp/') return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', stub);

    const db = await cds.connect.to('db');
    await db.run(INSERT.into('com.sap.developers.ims.HomepageConfig').entries({
      ID: cds.utils.uuid(), publicBaseUrl: 'https://dev.example/'
    }));
    const id = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      // Use a URL not present in the seed CSV to avoid the @assert.unique.verbUrl constraint.
      ID: id, verb: 'AI', shelf: 'START_HERE', sortOrder: 99,
      title: 'Topics', url: '/topics/btp/', isExternal: false, isActive: true
    }));

    await runHomepageLinkHealth();

    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves').where({ ID: id }));
    expect(row.linkStatus).toBe('OK');
    // Trailing slash on the base must be collapsed, not doubled.
    expect(stub.mock.calls.some(c => String(c[0]) === 'https://dev.example/topics/btp/')).toBe(true);
    expect(stub.mock.calls.some(c => String(c[0]) === '/topics/btp/')).toBe(false);
  });

  describe('toAbsoluteUrl', () => {
    it('passes absolute http(s) URLs through unchanged', () => {
      expect(toAbsoluteUrl('https://x.example/a', 'https://base.example')).toBe('https://x.example/a');
      expect(toAbsoluteUrl('http://x.example', 'https://base.example')).toBe('http://x.example');
    });
    it('prepends the base to root-relative paths', () => {
      expect(toAbsoluteUrl('/missions/', 'https://base.example')).toBe('https://base.example/missions/');
    });
    it('returns null for unresolvable values (empty, non-http scheme, bare relative)', () => {
      expect(toAbsoluteUrl('', 'https://base.example')).toBeNull();
      expect(toAbsoluteUrl(null, 'https://base.example')).toBeNull();
      expect(toAbsoluteUrl('mailto:a@b.com', 'https://base.example')).toBeNull();
      expect(toAbsoluteUrl('missions/', 'https://base.example')).toBeNull();
    });
  });

  // Regression: servers that return 403 on HEAD (e.g. cockpit.btp.cloud.sap
  // via Akamai redirect) but 200 on GET were falsely reported BROKEN.
  it('falls back to GET when HEAD returns 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (String(url) === 'https://cockpit.btp.cloud.sap' && opts?.method === 'HEAD')
        return new Response('', { status: 403 });
      return new Response('', { status: 200 });
    }));

    const db = await cds.connect.to('db');
    const id = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      ID: id, verb: 'INTEGRATE', shelf: 'TOOLS', sortOrder: 98,
      title: 'Cockpit', url: 'https://cockpit.btp.cloud.sap', isActive: true
    }));

    await runHomepageLinkHealth();

    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves').where({ ID: id }));
    expect(row.linkStatus).toBe('OK');
  });

  // Admin override: when linkStatusOverride is set, the job applies it without
  // fetching — gives admins a way to silence false-BROKEN alerts on auth-gated
  // or geo-restricted URLs.
  it('applies linkStatusOverride without fetching the URL', async () => {
    const stub = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', stub);

    const db = await cds.connect.to('db');
    const id = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      ID: id, verb: 'AI', shelf: 'TOOLS', sortOrder: 97,
      title: 'Auth-gated', url: 'https://auth-gated.example',
      isActive: true, linkStatusOverride: 'OK'
    }));

    await runHomepageLinkHealth();

    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves').where({ ID: id }));
    expect(row.linkStatus).toBe('OK');
    expect(stub.mock.calls.some(c => String(c[0]).includes('auth-gated.example'))).toBe(false);
  });
});
