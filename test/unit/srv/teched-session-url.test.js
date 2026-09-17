// test/unit/srv/teched-session-url.test.js
//
// Issue #2392 (items 2 + 8): every TechEd session must expose a prominent link
// to the same session on the SAP TechEd event website, in every view AND in the
// Add-to-Calendar content. Root cause: the live RainFocus catalog returns
// neither `url` nor `sessionUrl`, so `session.url` was always null. The fetcher
// now constructs the sap.com deep link from `sourceId` (RainFocus sessionID) +
// `venue`. These tests prove the exact URL for a BERLIN and a VIRTUAL session,
// that a real upstream url still wins if present, that a missing sourceId yields
// null (no crash), and that the constructed url survives normalization +
// content-hash (so item 8's ical URL:/DESCRIPTION population is automatic).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionUrl, parseSession } from '../../../srv/lib/teched/rainfocus-fetcher.js';
import { normalizeSession } from '../../../srv/lib/teched/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Real (trimmed) RainFocus capture for both venues (2026-09-15). The first
// BERLIN / VIRTUAL items are the KEY100 keynotes, whose sessionIDs match the
// real sap.com URLs the maintainer provided.
const CAPTURE = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'teched', 'rainfocus-search.json'), 'utf8'),
);

describe('buildSessionUrl (issue #2392)', () => {
  it('builds the exact sap.com deep link for a BERLIN session (te26)', () => {
    expect(buildSessionUrl('1786103955856001msiq', 'BERLIN')).toBe(
      'https://www.sap.com/events/teched/berlin/flow/sap/te26/catalog/page/catalog/session/1786103955856001msiq',
    );
  });

  it('builds the exact sap.com deep link for a VIRTUAL session (tev26)', () => {
    expect(buildSessionUrl('1788452327509003AspI', 'VIRTUAL')).toBe(
      'https://www.sap.com/events/teched/virtual/flow/sap/tev26/catalog/page/catalog/session/1788452327509003AspI',
    );
  });

  it('is robust to venue casing/whitespace', () => {
    expect(buildSessionUrl('abc', ' berlin ')).toContain('/teched/berlin/flow/sap/te26/');
    expect(buildSessionUrl('abc', 'virtual')).toContain('/teched/virtual/flow/sap/tev26/');
  });

  it('returns null when sourceId is missing (no crash)', () => {
    expect(buildSessionUrl(null, 'BERLIN')).toBeNull();
    expect(buildSessionUrl('', 'BERLIN')).toBeNull();
    expect(buildSessionUrl(undefined, 'VIRTUAL')).toBeNull();
  });

  it('returns null for an unrecognized venue (no guess)', () => {
    expect(buildSessionUrl('abc', 'ZURICH')).toBeNull();
    expect(buildSessionUrl('abc', null)).toBeNull();
  });
});

describe('parseSession url population (issue #2392)', () => {
  const berlinItem = CAPTURE.BERLIN.sectionList[0].items[0];
  const virtualItem = CAPTURE.VIRTUAL.sectionList[0].items[0];

  it('populates a constructed url for a BERLIN session (live capture has no url/sessionUrl)', () => {
    // Guard: the real capture carries no upstream url, exercising the fallback.
    expect(berlinItem.url ?? null).toBeNull();
    expect(berlinItem.sessionUrl ?? null).toBeNull();

    const parsed = parseSession(berlinItem, 'BERLIN');
    expect(parsed).toBeTruthy();
    expect(parsed.session.url).toBe(
      `https://www.sap.com/events/teched/berlin/flow/sap/te26/catalog/page/catalog/session/${berlinItem.sessionID}`,
    );
  });

  it('populates a constructed url for a VIRTUAL session', () => {
    const parsed = parseSession(virtualItem, 'VIRTUAL');
    expect(parsed.session.url).toBe(
      `https://www.sap.com/events/teched/virtual/flow/sap/tev26/catalog/page/catalog/session/${virtualItem.sessionID}`,
    );
  });

  it('prefers a real upstream url over the constructed one when present', () => {
    const real = 'https://example.com/real-session';
    const parsed = parseSession({ ...berlinItem, url: real }, 'BERLIN');
    expect(parsed.session.url).toBe(real);
  });

  it('carries the constructed url through normalizeSession (row + content hash)', () => {
    const parsed = parseSession(berlinItem, 'BERLIN');
    const seen = new Set();
    const row = normalizeSession(parsed.session, seen);
    expect(row.url).toBe(parsed.session.url);
    // The url is a source-owned field, so changing it must change the hash —
    // proving it participates in the delta gate (and thus survives to the feed).
    const other = normalizeSession({ ...parsed.session, url: 'https://example.com/x' }, new Set());
    expect(row.contentHash).not.toBe(other.contentHash);
  });
});
