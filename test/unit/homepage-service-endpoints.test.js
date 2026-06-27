// test/unit/homepage-service-endpoints.test.js
// Tests for HomepageService (#639) — verifies each endpoint returns the documented shape.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests as resetHomepageCaches } from '../../srv/homepage-service.js';

cds.test('serve', '--project', '.', '--in-memory');

describe('HomepageService endpoints', () => {
  let svc;
  beforeAll(async () => {
    process.env.YOUTUBE_API_KEY = '';  // exercise the no-key fallback path
    svc = await cds.connect.to('HomepageService');
  });

  it('events() returns array', async () => {
    const out = await svc.send('events', {});
    expect(Array.isArray(out)).toBe(true);
  });

  it('events() queries the Events DB entity and returns mapped rows', async () => {
    // Bust the 60s module cache populated by the previous test (which ran against
    // an empty Events table). Without this the new row is invisible until TTL expiry.
    resetHomepageCaches();

    const db = await cds.connect.to('db');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await db.run(INSERT.into('com.sap.developers.ims.Events').entries({
      ID: cds.utils.uuid(),
      name: '__TEST__ Future event',
      startDate: tomorrow,
      eventType: 'CODEJAM',
    }));

    const out = await svc.send('events', {});
    expect(Array.isArray(out)).toBe(true);
    const synthetic = out.find(e => e.title === '__TEST__ Future event');
    // If this assertion fails, the CDS QL .where() syntax in homepage-service.js
    // is broken again — the prior `.where('startDate >= ?', ...)` raw-placeholder
    // form threw at parse time and the catch path silently returned [].
    expect(synthetic).toBeTruthy();
    expect(synthetic.format).toBe('CODEJAM');
  });

  it('videos() returns shape { featured, recent, error }', async () => {
    const out = await svc.send('videos', {});
    expect(out).toHaveProperty('featured');
    expect(out).toHaveProperty('recent');
    expect(out).toHaveProperty('error');
    // With YOUTUBE_API_KEY='', the error should be 'no-api-key'.
    expect(out.error).toBe('no-api-key');
  });

  it('shelves({ verb: LEARN }) returns shelves for that verb', async () => {
    const out = await svc.send('shelves', { verb: 'LEARN' });
    expect(Array.isArray(out)).toBe(true);
    // In-memory SQLite has no seed data for LEARN verb so result may be empty,
    // but any row that IS returned must have verb === 'LEARN'.
    expect(out.every(s => s.verb === 'LEARN')).toBe(true);
  });

  it('communityBlogs() returns array', async () => {
    const out = await svc.send('communityBlogs', {});
    expect(Array.isArray(out)).toBe(true);
  });

  it('news() returns array', async () => {
    const out = await svc.send('news', {});
    expect(Array.isArray(out)).toBe(true);
  });
});

