import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  beginSession, appendBatch, commitSession, abortSession, fetchRemoteHashes, renderConceptsPhase
} from '../lib/publish-client.js';

const baseUrl = 'http://localhost:4004';
const apiKey  = 'test-key';

describe('publish-client', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('beginSession returns sessionId + version on 201', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: () => Promise.resolve({ sessionId: 'abc', version: 7, expiresAt: '2026-05-30T00:00:00Z' })
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await beginSession({ baseUrl, apiKey, trigger: 't', hugoVersion: 'v1', expectedSlugCount: 5 });
    expect(out).toEqual({ sessionId: 'abc', version: 7, expiresAt: '2026-05-30T00:00:00Z' });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/content/publish/begin`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' })
      })
    );
  });

  it('beginSession throws with status attached on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409,
      text: () => Promise.resolve('lock held')
    }));
    await expect(
      beginSession({ baseUrl, apiKey, trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('appendBatch posts files/metadata/bodyTexts and returns server result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 202,
      json: () => Promise.resolve({ slugsAccepted: 3, batchHash: 'h', totalSizeBytes: 100 })
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await appendBatch({
      baseUrl, apiKey, sessionId: 'abc',
      files: { a: 'AA', b: 'BB', c: 'CC' },
      metadata: {}, bodyTexts: {}
    });
    expect(out.slugsAccepted).toBe(3);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.sessionId).toBe('abc');
    expect(Object.keys(body.files)).toEqual(['a', 'b', 'c']);
  });

  it('commitSession returns the activation result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ version: 7, fileCount: 1398, durationMs: 5234, alreadyActive: false })
    }));
    const out = await commitSession({ baseUrl, apiKey, sessionId: 'abc' });
    expect(out.version).toBe(7);
    expect(out.alreadyActive).toBe(false);
  });

  it('abortSession is best-effort and does not throw on server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
      text: () => Promise.resolve('boom')
    }));
    await expect(abortSession({ baseUrl, apiKey, sessionId: 'abc', reason: 'r' })).resolves.toMatchObject({ aborted: false });
  });

  it('fetchRemoteHashes returns the hash map', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ slug1: 'h1', slug2: 'h2' })
    }));
    const out = await fetchRemoteHashes({ baseUrl });
    expect(out).toEqual({ slug1: 'h1', slug2: 'h2' });
  });

  it('fetchRemoteHashes sends a Bearer header when apiKey is given (srv-qa gates /content/hashes)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve({ slug1: 'h1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchRemoteHashes({ baseUrl, apiKey: 'qa-key' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${baseUrl}/content/hashes`);
    expect(opts?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer qa-key' }));
  });

  it('renderConceptsPhase POSTs sessionId to /render-concepts and returns counts (#1327)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        conceptsSeen: 5000, conceptsChanged: 12, conceptsSkipped: 4988,
        conceptsErrored: 0, durationMs: 42000,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await renderConceptsPhase({ baseUrl, apiKey, sessionId: 'sess-1' });
    expect(out.conceptsChanged).toBe(12);
    expect(out.conceptsSkipped).toBe(4988);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${baseUrl}/content/publish/render-concepts`);
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-key' }));
    expect(JSON.parse(opts.body)).toEqual({ sessionId: 'sess-1' });
  });

  it('renderConceptsPhase throws with status attached on non-2xx (#1327)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, text: () => Promise.resolve('shell unavailable'),
    }));
    await expect(
      renderConceptsPhase({ baseUrl, apiKey, sessionId: 'sess-1' })
    ).rejects.toMatchObject({ status: 500 });
  });
});
