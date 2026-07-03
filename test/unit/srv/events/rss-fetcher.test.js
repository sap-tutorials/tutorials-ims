// test/unit/srv/events/rss-fetcher.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRss, parseRss, _setMockFetcher, _resetMockFetcher } from '../../../../srv/lib/events/rss-fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '..', '__fixtures__', 'devtoberfest-rss.xml'), 'utf8');

describe('rss-fetcher.parseRss', () => {
  it('returns 2 rows from a 2-item feed', () => {
    const rows = parseRss(fixture, 'devtoberfest', 'global');
    expect(rows).toHaveLength(2);
  });

  it('derives id as "<typeId>/<sha256(link)[0..12]>"', () => {
    const rows = parseRss(fixture, 'devtoberfest', 'global');
    expect(rows[0].id).toMatch(/^devtoberfest\/[0-9a-f]{12}$/);
  });

  it('parses RFC1123Z pubDate to YYYY-MM-DD', () => {
    const rows = parseRss(fixture, 'devtoberfest', 'global');
    expect(rows[0].date).toBe('2027-10-05');
    expect(rows[1].date).toBe('2027-10-12');
  });

  it('sets scope to defaultScope and leaves end_date/location empty', () => {
    const rows = parseRss(fixture, 'devtoberfest', 'global');
    expect(rows[0].scope).toBe('global');
    expect(rows[0].end_date).toBe('');
    expect(rows[0].location).toBe('');
  });
});

describe('rss-fetcher.fetchRss', () => {
  afterEach(() => _resetMockFetcher());

  it('calls the provided URL and returns parsed rows', async () => {
    _setMockFetcher(async () => ({ ok: true, status: 200, text: async () => fixture }));
    const rows = await fetchRss('https://example/rss', 'devtoberfest', 'global');
    expect(rows).toHaveLength(2);
  });
});
