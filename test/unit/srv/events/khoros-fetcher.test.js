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
    // 2027-01-15T09:30 +05:30 = 2027-01-15 as authored locally.
    expect(rows[0].date).toBe('2027-01-15');
    expect(rows[0].end_date).toBe('2027-01-15');
  });

  // #1615 — an APJ-morning event (e.g. Sydney 09:00 +10:00) has a UTC instant on
  // the PREVIOUS calendar day (23:00Z). The date shown must be the LOCAL authored
  // day, not the UTC day. Regression guard for the Sydney/Brisbane report.
  it('#1615: keeps the local authored day for a positive-offset morning event', () => {
    const fixture = JSON.stringify({
      status: 'success',
      data: { items: [
        {
          id: 'syd',
          subject: '🇦🇺 Build AI services using SAP CAP (Sydney, Australia)',
          view_href: 'https://community.sap.com/t5/sap-codejam/sydney/ev-p/14446555',
          occasion_data: {
            start_time: '2026-09-04T09:00:00.000+10:00',   // UTC instant = 2026-09-03T23:00Z
            end_time:   '2026-09-04T17:00:00.000+10:00',
            timezone:   'Australia/Sydney',
            location:   'The Mint, Macquarie Street, Sydney NSW, Australia',
          },
        },
        {
          id: 'bne',
          subject: '🇦🇺 Build Code-based AI Agents (Brisbane, Australia)',
          view_href: 'https://community.sap.com/t5/sap-codejam/brisbane/ev-p/14455650',
          occasion_data: {
            start_time: '2026-09-01T09:00:00.000+10:00',
            end_time:   '2026-09-01T17:00:00.000+10:00',
            timezone:   'Australia/Brisbane',
            location:   'SAP Australia Brisbane, Creek Street, Brisbane City QLD, Australia',
          },
        },
      ] },
    });
    const rows = parseKhoros(fixture, 'codejam', 'local', { now: new Date('2026-08-01T00:00:00Z') });
    const syd = rows.find(r => r.id === 'codejam/syd');
    const bne = rows.find(r => r.id === 'codejam/bne');
    expect(syd.date).toBe('2026-09-04');
    expect(syd.end_date).toBe('2026-09-04');
    expect(bne.date).toBe('2026-09-01');
    expect(bne.end_date).toBe('2026-09-01');
  });

  it('#1615: still formats a Z (UTC) timestamp on its own day', () => {
    const fixture = JSON.stringify({
      status: 'success',
      data: { items: [
        {
          id: 'utc',
          subject: 'UTC event',
          view_href: 'https://community.sap.com/t5/sap-codejam/utc/ev-p/1',
          occasion_data: {
            start_time: '2027-03-10T09:00:00.000Z',
            end_time:   '2027-03-10T17:00:00.000Z',
            timezone:   'UTC',
            location:   'Berlin, Germany',
          },
        },
      ] },
    });
    const rows = parseKhoros(fixture, 'codejam', 'local', { now: new Date('2026-08-01T00:00:00Z') });
    expect(rows[0].date).toBe('2027-03-10');
    expect(rows[0].end_date).toBe('2027-03-10');
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

  // #1736 — the query must scope to occasion messages, bound to upcoming events,
  // and order soonest-first. Without this, a large board's default ~100-row
  // relevance window never reaches genuinely-future events (e.g. Sept CodeJams).
  it('#1736: scopes to occasions, bounds to upcoming, and orders soonest-first', async () => {
    let capturedURL = null;
    _setMockFetcher(async (url) => {
      capturedURL = url;
      return { ok: true, status: 200, text: async () => fixtureText };
    });
    await fetchKhoros('codejam-events', 'codejam', 'local', { now: new Date('2026-12-01T00:00:00Z') });
    expect(capturedURL).toContain(encodeURIComponent("conversation.style='occasion'"));
    expect(capturedURL).toContain(encodeURIComponent('ORDER BY occasion_data.start_time ASC'));
    expect(capturedURL).toContain(encodeURIComponent('LIMIT 100'));
  });

  it('#1736: derives the start_time cutoff from opts.now', async () => {
    let capturedURL = null;
    _setMockFetcher(async (url) => {
      capturedURL = url;
      return { ok: true, status: 200, text: async () => fixtureText };
    });
    const now = new Date('2026-12-01T00:00:00Z');
    await fetchKhoros('codejam-events', 'codejam', 'local', { now });
    expect(capturedURL).toContain(
      encodeURIComponent(`occasion_data.start_time > '${now.toISOString()}'`),
    );
  });
});
