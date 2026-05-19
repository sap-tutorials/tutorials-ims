import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchAdminDocs, _resetCache, _setIndexPath } from '../srv/lib/admin-docs-index.js';

const FIXTURE = {
  generatedAt: '2026-05-19T00:00:00.000Z',
  docs: [
    {
      id: 'docs/auth.md#0',
      path: 'docs/auth.md',
      heading: 'XSUAA Authentication Setup',
      body: 'XSUAA provides authentication via SAP IDP. Configure xs-security.json and bind the service to the approuter.',
      headingTokens: ['xsuaa', 'authentication', 'setup'],
      bodyTokens: ['xsuaa', 'provides', 'authentication', 'sap', 'idp', 'configure', 'xs-security', 'json', 'bind', 'service', 'approuter']
    },
    {
      id: 'docs/auth.md#1',
      path: 'docs/auth.md',
      heading: 'Approuter Routes',
      body: 'The approuter routes requests to the CAP backend. Token forwarding is handled automatically across all bound services.',
      headingTokens: ['approuter', 'routes'],
      bodyTokens: ['approuter', 'routes', 'requests', 'cap', 'backend', 'token', 'forwarding', 'handled', 'automatically', 'across', 'bound', 'services']
    },
    {
      id: 'docs/content.md#0',
      path: 'docs/content.md',
      heading: 'Content Pipeline',
      body: 'Tutorial HTML is published as gzip BLOBs to HANA. The publish-content script computes SHA-256 hashes for delta detection.',
      headingTokens: ['content', 'pipeline'],
      bodyTokens: ['tutorial', 'html', 'published', 'gzip', 'blobs', 'hana', 'publish-content', 'script', 'computes', 'sha-256', 'hashes', 'delta', 'detection']
    }
  ]
};

let tmpDir;
let fixturePath;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-docs-index-'));
  fixturePath = join(tmpDir, 'admin-docs-index.json');
  writeFileSync(fixturePath, JSON.stringify(FIXTURE));
  _setIndexPath(fixturePath);
});

afterAll(() => {
  _setIndexPath(null); // reset to default
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin-docs-index', () => {
  it('ranks heading matches above body matches and returns hit shape', () => {
    _resetCache();

    const hits = searchAdminDocs({ query: 'approuter' });
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // First hit should be the section whose HEADING contains "approuter"
    expect(hits[0].heading).toBe('Approuter Routes');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0]).toMatchObject({
      id: expect.any(String),
      path: expect.any(String),
      heading: expect.any(String),
      score: expect.any(Number),
      snippet: expect.any(String)
    });
    expect(hits[0].snippet.length).toBeLessThanOrEqual(240);
  });

  it('returns [] when query has no matchable tokens (stopwords / typos / empty)', () => {
    _resetCache();

    expect(searchAdminDocs({ query: 'the and for with' })).toEqual([]);
    expect(searchAdminDocs({ query: 'zzzzzzzzz qwqwqwqw' })).toEqual([]);
    expect(searchAdminDocs({ query: '' })).toEqual([]);
    expect(searchAdminDocs({})).toEqual([]);
  });
});
