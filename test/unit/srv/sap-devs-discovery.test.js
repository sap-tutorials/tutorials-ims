// test/unit/srv/sap-devs-discovery.test.js
//
// Unit tests for the vendored discovery-missions client. Mocks
// global.fetch and asserts:
//   - CSRF token round-trip (HEAD /platformx/ → x-csrf-token; POST
//     /platformx/$batch forwards it).
//   - Batch multipart body construction (boundary, GET line, headers).
//   - extractBatchJSON handles both double-encoded string values AND
//     native JSON array values (the "d" envelope's inner value can be
//     either shape depending on the OData function).
//   - Mission normalization (Id → string id, Name → name,
//     UCLongDescription → description, Effort/Category passed through).
//   - CSRF retry on 403 refetches the token and retries once.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  searchDiscoveryMissions,
  extractBatchJSON,
} from '../../../srv/lib/sap-devs-discovery.js';

const PLATFORMX = 'https://discovery-center.cloud.sap/platformx/';

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Build a multipart batch response body matching what Discovery Center
 * returns. Value under `d.<funcname>` is a double-encoded JSON string,
 * matching real API behavior.
 */
function makeBatchResponseText(rows) {
  const inner = JSON.stringify(rows);
  const envelope = JSON.stringify({
    d: { GetViewFuzzySearchesCustomV3: inner },
  });
  return [
    '--changeset_xyz',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    '',
    envelope,
    '--changeset_xyz--',
    '',
  ].join('\r\n');
}

function makeCsrfHeadResponse(token) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'x-csrf-token') return token;
        return null;
      },
    },
  };
}

function makeBatchOkResponse(text) {
  return {
    ok: true,
    status: 200,
    async text() { return text; },
  };
}

describe('searchDiscoveryMissions', () => {
  it('performs CSRF fetch, then POST /platformx/$batch, and returns normalized missions', async () => {
    // First fetch — HEAD for CSRF.
    fetchMock.mockResolvedValueOnce(makeCsrfHeadResponse('CSRF_TOKEN_123'));
    // Second fetch — POST /$batch returning missions.
    fetchMock.mockResolvedValueOnce(makeBatchOkResponse(makeBatchResponseText([
      { Id: 3019, Name: 'BTP Enterprise', Category: 'onboard', Effort: '2', UCLongDescription: 'A' },
      { Id: 3258, Name: 'Integration Suite', Category: 'develop', Effort: '1', UCLongDescription: 'B' },
    ])));

    const rows = await searchDiscoveryMissions({ query: '', top: 100 });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: '3019',
      name: 'BTP Enterprise',
      effort: '2',
      category: 'onboard',
      description: 'A',
    });

    // Verify request 1: HEAD with x-csrf-token: Fetch header.
    expect(fetchMock.mock.calls[0][0]).toBe(PLATFORMX);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
    expect(fetchMock.mock.calls[0][1].headers['x-csrf-token']).toBe('Fetch');

    // Verify request 2: POST /$batch with x-csrf-token: CSRF_TOKEN_123.
    expect(fetchMock.mock.calls[1][0]).toBe(PLATFORMX + '$batch');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[1][1].headers['x-csrf-token']).toBe('CSRF_TOKEN_123');
    // Multipart body includes the GET line for the mission function.
    expect(fetchMock.mock.calls[1][1].body).toContain('GET GetViewFuzzySearchesCustomV3');
    // And the top parameter propagates.
    expect(fetchMock.mock.calls[1][1].body).toContain("top='100'");
  });

  it('escapes single quotes in the query string to avoid breaking the OData literal', async () => {
    fetchMock.mockResolvedValueOnce(makeCsrfHeadResponse('T'));
    fetchMock.mockResolvedValueOnce(makeBatchOkResponse(makeBatchResponseText([])));

    await searchDiscoveryMissions({ query: "SAP's Cool Feature" });

    const body = fetchMock.mock.calls[1][1].body;
    // Single quotes are doubled, matching OData literal escape convention.
    expect(body).toContain("searchString='SAP''s Cool Feature'");
  });

  it('retries once on 403 (CSRF token rejected) with a fresh token', async () => {
    // Sequence: CSRF, 403 batch, CSRF, 200 batch.
    fetchMock
      .mockResolvedValueOnce(makeCsrfHeadResponse('OLD_TOKEN'))
      .mockResolvedValueOnce({ ok: false, status: 403, async text() { return ''; } })
      .mockResolvedValueOnce(makeCsrfHeadResponse('NEW_TOKEN'))
      .mockResolvedValueOnce(makeBatchOkResponse(makeBatchResponseText([
        { Id: 1, Name: 'One', Category: 'x', Effort: '1', UCLongDescription: 'd' },
      ])));

    const rows = await searchDiscoveryMissions({ query: '' });
    expect(rows).toHaveLength(1);
    // Second POST used the refreshed token.
    expect(fetchMock.mock.calls[3][1].headers['x-csrf-token']).toBe('NEW_TOKEN');
  });

  it('throws when CSRF HEAD returns no x-csrf-token header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
    });
    await expect(searchDiscoveryMissions({ query: '' })).rejects.toThrow(/no x-csrf-token/);
  });

  it('throws on non-200 batch response (not the retry-able 403 path)', async () => {
    fetchMock.mockResolvedValueOnce(makeCsrfHeadResponse('T'));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, async text() { return ''; } });
    await expect(searchDiscoveryMissions({ query: '' })).rejects.toThrow(/HTTP 500/);
  });
});

describe('extractBatchJSON', () => {
  it('unwraps a double-encoded JSON string value from the "d" envelope', () => {
    const body = makeBatchResponseText([{ Id: 42, Name: 'X' }]);
    const rows = extractBatchJSON(body);
    expect(rows).toEqual([{ Id: 42, Name: 'X' }]);
  });

  it('accepts a native array value directly (no double-encoding)', () => {
    const envelope = JSON.stringify({
      d: { GetSomething: [{ inline: true }] },
    });
    const body = `--x\r\nContent-Type: application/http\r\n\r\n${envelope}\r\n--x--`;
    const rows = extractBatchJSON(body);
    expect(rows).toEqual([{ inline: true }]);
  });

  it('throws when the response has no JSON body', () => {
    expect(() => extractBatchJSON('just some text')).toThrow(/no JSON/);
  });

  it('throws when the JSON is missing the "d" envelope', () => {
    expect(() => extractBatchJSON('{"other":1}')).toThrow(/"d" envelope/);
  });
});
