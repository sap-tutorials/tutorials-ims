// test/unit/srv/events/khoros-fetcher.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKhoros, _setMockFetcher, _resetMockFetcher, parseKhoros } from '../../../../srv/lib/events/khoros-fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '..', '__fixtures__', 'khoros-events-search.json');
const fixtureText = readFileSync(fixturePath, 'utf8');

describe('khoros-fetcher.parseKhoros', () => {
  it('returns 2 rows from a 4-item fixture (filters past + /ec-p/ items)', () => {
    // Freeze "now" at 2026-12-01 so 2027-01-15 stays future and 2024-01-01 stays past.
    const now = new Date('2026-12-01T00:00:00Z');
    const rows = parseKhoros(fixtureText, 'codejam', 'local', { now });
    expect(rows).toHaveLength(2);
  });

  it('assigns id as "<typeID>/<messageId>"', () => {
    const rows = parseKhoros(fixtureText, 'codejam', 'local', { now: new Date('2026-12-01T00:00:00Z') });
    expect(rows[0].id).toBe('codejam/12345');
  });

  it('maps subject → title, view_href → url, location, and scope from defaultScope', () => {
    const rows = parseKhoros(fixtureText, 'codejam', 'local', { now: new Date('2026-12-01T00:00:00Z') });
    const r = rows[0];
    expect(r.title).toBe('Build AI services using SAP CAP (Bengaluru, India)');
    expect(r.url).toBe('https://community.sap.com/t5/sap-codejam/build-ai-services-using-sap-cap-bengaluru/ev-p/12345');
    expect(r.location).toBe('Bosch Global Software Technologies, Bengaluru, India');
    expect(r.scope).toBe('local');
  });

  it('formats start/end as YYYY-MM-DD', () => {
    const rows = parseKhoros(fixtureText, 'codejam', 'local', { now: new Date('2026-12-01T00:00:00Z') });
    // 2027-01-15T09:30 +05:30 = 2027-01-15T04:00Z. Format uses local date component of the parsed timestamp.
    expect(rows[0].date).toMatch(/^2027-01-1[45]$/);
    expect(rows[0].end_date).toMatch(/^2027-01-1[45]$/);
  });

  it('filters items whose view_href contains /ec-p/ (Go rss.go:87 rule)', () => {
    const rows = parseKhoros(fixtureText, 'codejam', 'local', { now: new Date('2026-12-01T00:00:00Z') });
    const filtered = rows.find(r => r.id === 'codejam/88888');
    expect(filtered).toBeUndefined();
  });

  it('drops items past "now"', () => {
    const rows = parseKhoros(fixtureText, 'codejam', 'local', { now: new Date('2026-12-01T00:00:00Z') });
    const filtered = rows.find(r => r.id === 'codejam/99999');
    expect(filtered).toBeUndefined();
  });
});

describe('khoros-fetcher.fetchKhoros', () => {
  afterEach(() => _resetMockFetcher());

  it('calls the Khoros API with the correct SEARCH query URL', async () => {
    let capturedURL = null;
    _setMockFetcher(async (url) => {
      capturedURL = url;
      return { ok: true, status: 200, text: async () => fixtureText };
    });
    await fetchKhoros('codejam-events', 'codejam', 'local', { now: new Date('2026-12-01T00:00:00Z') });
    expect(capturedURL).toContain('https://groups.community.sap.com/api/2.0/search');
    expect(capturedURL).toContain(encodeURIComponent("board.id='codejam-events'"));
  });
});
