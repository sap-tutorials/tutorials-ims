// test/unit/publish-challenge-answers.test.js
// Unit tests for scripts/lib/publish-challenge-answers.js (#2441).
//
// The helper walks .tutorial-cache/ for `<slug>.challenge-answers.json`
// sidecars and POSTs each one to /content/challenge-answers. Failures are
// non-fatal — captured + reported, never thrown. Mirrors
// test/unit/publish-validate-answer.test.js.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { publishChallengeAnswers } from '../../scripts/lib/publish-challenge-answers.js';

function makeFetchOk() {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
}

const sidecar = (slug) => ({
  slug,
  answers: [{ stepNumber: 1, nodeId: `challenge-1-0`, reference: 'because', prompt: 'why?' }],
});

describe('publishChallengeAnswers', () => {
  it('1. no sidecar files → empty result, no HTTP calls', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-empty-'));
    const fetchMock = makeFetchOk();
    const result = await publishChallengeAnswers({
      cacheDir: dir, baseUrl: 'http://localhost:4004', apiKey: 'k', fetch: fetchMock,
    });
    expect(result).toEqual({ published: 0, failures: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2. one sidecar → POST to correct URL with bearer header + preserved body', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-one-'));
    const payload = sidecar('tut-a');
    writeFileSync(path.join(dir, 'tut-a.challenge-answers.json'), JSON.stringify(payload));

    const fetchMock = makeFetchOk();
    const result = await publishChallengeAnswers({
      cacheDir: dir, baseUrl: 'http://localhost:4004', apiKey: 'secret-key', fetch: fetchMock,
    });

    expect(result.published).toBe(1);
    expect(result.failures).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4004/content/challenge-answers');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret-key');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('3. multiple sidecars → multiple POSTs, unrelated files ignored', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-multi-'));
    writeFileSync(path.join(dir, 'a.challenge-answers.json'), JSON.stringify(sidecar('a')));
    writeFileSync(path.join(dir, 'b.challenge-answers.json'), JSON.stringify(sidecar('b')));
    writeFileSync(path.join(dir, 'c.challenge-answers.json'), JSON.stringify(sidecar('c')));
    writeFileSync(path.join(dir, 'a.validate-answer.json'), '{}'); // ignored (different suffix)

    const fetchMock = makeFetchOk();
    const result = await publishChallengeAnswers({
      cacheDir: dir, baseUrl: 'http://localhost:4004', apiKey: 'k', fetch: fetchMock,
    });

    expect(result.published).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const slugs = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).slug).sort();
    expect(slugs).toEqual(['a', 'b', 'c']);
  });

  it('4. 404 on one slug → captured in failures, others continue', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-404-'));
    writeFileSync(path.join(dir, 'good.challenge-answers.json'), JSON.stringify(sidecar('good')));
    writeFileSync(path.join(dir, 'missing.challenge-answers.json'), JSON.stringify(sidecar('missing')));

    const fetchMock = vi.fn(async (url, init) => {
      const slug = JSON.parse(init.body).slug;
      if (slug === 'missing') return { ok: false, status: 404, text: async () => '{"error":"tutorial_not_found"}' };
      return { ok: true, status: 200, text: async () => '' };
    });

    const result = await publishChallengeAnswers({
      cacheDir: dir, baseUrl: 'http://localhost:4004', apiKey: 'k', fetch: fetchMock,
    });

    expect(result.published).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].slug).toBe('missing');
    expect(result.failures[0].status).toBe(404);
    expect(result.failures[0].body).toContain('tutorial_not_found');
  });

  it('5. network error → captured with status 0, others continue', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-net-'));
    writeFileSync(path.join(dir, 'good.challenge-answers.json'), JSON.stringify(sidecar('good')));
    writeFileSync(path.join(dir, 'boom.challenge-answers.json'), JSON.stringify(sidecar('boom')));

    const fetchMock = vi.fn(async (url, init) => {
      const slug = JSON.parse(init.body).slug;
      if (slug === 'boom') throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, text: async () => '' };
    });

    const result = await publishChallengeAnswers({
      cacheDir: dir, baseUrl: 'http://localhost:4004', apiKey: 'k', fetch: fetchMock,
    });

    expect(result.published).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].slug).toBe('boom');
    expect(result.failures[0].status).toBe(0);
    expect(result.failures[0].body).toBe('ECONNREFUSED');
  });

  it('6. malformed sidecar (missing answers array) → skipped, no POST', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-bad-'));
    writeFileSync(path.join(dir, 'x.challenge-answers.json'), JSON.stringify({ slug: 'x' })); // no answers[]
    const fetchMock = makeFetchOk();
    const result = await publishChallengeAnswers({
      cacheDir: dir, baseUrl: 'http://localhost:4004', apiKey: 'k', fetch: fetchMock,
    });
    expect(result).toEqual({ published: 0, failures: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('7. auth header uses apiKey argument (not env var)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-auth-'));
    writeFileSync(path.join(dir, 'a.challenge-answers.json'), JSON.stringify(sidecar('a')));
    const prev = process.env.CONTENT_API_KEY;
    process.env.CONTENT_API_KEY = 'env-key-MUST-NOT-be-used';
    try {
      const fetchMock = makeFetchOk();
      await publishChallengeAnswers({
        cacheDir: dir, baseUrl: 'http://localhost:4004', apiKey: 'arg-key-IS-used', fetch: fetchMock,
      });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.authorization).toBe('Bearer arg-key-IS-used');
    } finally {
      if (prev === undefined) delete process.env.CONTENT_API_KEY;
      else process.env.CONTENT_API_KEY = prev;
    }
  });
});
