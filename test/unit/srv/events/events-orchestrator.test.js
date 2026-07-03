// test/unit/srv/events/events-orchestrator.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAllEvents, _setMockFetchers, _resetMockFetchers } from '../../../../srv/lib/events/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const khorosFixture = readFileSync(join(__dirname, '..', '__fixtures__', 'khoros-events-search.json'), 'utf8');
const rssFixture    = readFileSync(join(__dirname, '..', '__fixtures__', 'devtoberfest-rss.xml'), 'utf8');

describe('events orchestrator', () => {
  afterEach(() => _resetMockFetchers());

  it('merges Khoros + RSS results into one rows[] with source and perSource summary', async () => {
    _setMockFetchers({
      khoros: async () => ({ ok: true, status: 200, text: async () => khorosFixture }),
      rss:    async () => ({ ok: true, status: 200, text: async () => rssFixture }),
    });
    const { rows, perSource } = await fetchAllEvents({ now: new Date('2026-12-01T00:00:00Z') });
    // 2 khoros (past + /ec-p/ filtered) + 2 rss = 4
    expect(rows).toHaveLength(4);
    expect(perSource.khoros.rowsFetched).toBe(2);
    expect(perSource.rss.rowsFetched).toBe(2);
  });

  it('deduplicates by sourceId (first-writer-wins)', async () => {
    _setMockFetchers({
      khoros: async () => ({ ok: true, status: 200, text: async () =>
        JSON.stringify({ status: 'success', data: { items: [
          { id: '42', subject: 'First', view_href: 'https://a', occasion_data: { start_time: '2027-05-01T09:00:00Z', location: 'X' } },
          { id: '42', subject: 'Duplicate', view_href: 'https://b', occasion_data: { start_time: '2027-05-01T09:00:00Z', location: 'Y' } },
        ] } })
      }),
      rss: async () => ({ ok: true, status: 200, text: async () => '<?xml version="1.0"?><rss><channel></channel></rss>' }),
    });
    const { rows } = await fetchAllEvents({ now: new Date('2026-12-01T00:00:00Z') });
    const dupes = rows.filter(r => r.id === 'codejam/42');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].title).toBe('First');   // first-writer wins
  });

  it('degrades gracefully when Khoros fetch fails', async () => {
    _setMockFetchers({
      khoros: async () => { throw new Error('boom'); },
      rss:    async () => ({ ok: true, status: 200, text: async () => rssFixture }),
    });
    const { rows, perSource } = await fetchAllEvents({ now: new Date('2026-12-01T00:00:00Z') });
    expect(rows).toHaveLength(2);   // RSS survives
    expect(perSource.khoros.fetcherRejected).toBe(true);
    expect(perSource.khoros.reason).toContain('boom');
    expect(perSource.rss.rowsFetched).toBe(2);
  });

  it('returns empty when all sources fail', async () => {
    _setMockFetchers({
      khoros: async () => { throw new Error('a'); },
      rss:    async () => { throw new Error('b'); },
    });
    const { rows, perSource } = await fetchAllEvents({ now: new Date('2026-12-01T00:00:00Z') });
    expect(rows).toHaveLength(0);
    expect(perSource.khoros.fetcherRejected).toBe(true);
    expect(perSource.rss.fetcherRejected).toBe(true);
  });

  it('drops rows with startDate strictly before "now"', async () => {
    _setMockFetchers({
      khoros: async () => ({ ok: true, status: 200, text: async () => khorosFixture }),
      rss:    async () => ({ ok: true, status: 200, text: async () => rssFixture }),
    });
    // Freeze now AFTER the RSS items — Oct 2027 — both RSS rows should be filtered
    // The khoros items in fixture are Jan 2027 + Feb 2027 (past relative to Oct 2027).
    const { rows } = await fetchAllEvents({ now: new Date('2027-10-15T00:00:00Z') });
    expect(rows).toHaveLength(0);
  });
});
