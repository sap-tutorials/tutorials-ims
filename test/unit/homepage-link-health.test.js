import { describe, it, expect, vi, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('homepage-link-health job', () => {
  let runHomepageLinkHealth;

  beforeAll(async () => {
    ({ runHomepageLinkHealth } = await import('../../srv/jobs/homepage-link-health.js'));
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
});
