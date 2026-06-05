// test/unit/publish-validate-answer.test.js
// Unit tests for scripts/lib/publish-validate-answer.js (Task 9 of #209).
//
// The helper walks .tutorial-cache/ for `<slug>.validate-answer.json` sidecars
// emitted by Task 3 and POSTs each one to /content/validate-answer-specs.
// Failures are non-fatal — captured + reported, never thrown.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { publishValidateAnswerSpecs } from '../../scripts/lib/publish-validate-answer.js';

function makeFetchOk() {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
}

describe('publishValidateAnswerSpecs', () => {
  it('1. no sidecar files → empty result, no HTTP calls', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'va-empty-'));
    const fetchMock = makeFetchOk();

    const result = await publishValidateAnswerSpecs({
      cacheDir: dir,
      baseUrl: 'http://localhost:4004',
      apiKey: 'k',
      fetch: fetchMock,
    });

    expect(result).toEqual({ published: 0, failures: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2. one sidecar → POST to correct URL with bearer header', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'va-one-'));
    const payload = {
      slug: 'tut-a',
      specs: [
        { stepNumber: 2, questionId: 'q1', questionText: 'why?', correctAnswer: 'because', ruleType: 'free_text', aiGrading: true },
      ],
    };
    writeFileSync(path.join(dir, 'tut-a.validate-answer.json'), JSON.stringify(payload));

    const fetchMock = makeFetchOk();
    const result = await publishValidateAnswerSpecs({
      cacheDir: dir,
      baseUrl: 'http://localhost:4004',
      apiKey: 'secret-key',
      fetch: fetchMock,
    });

    expect(result.published).toBe(1);
    expect(result.failures).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4004/content/validate-answer-specs');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret-key');
    expect(init.headers['content-type']).toBe('application/json');
    // Body shape preserved: { slug, specs } — JSON.parse round-trips.
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('3. multiple sidecars → multiple POSTs in series', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'va-multi-'));
    const a = { slug: 'a', specs: [{ stepNumber: 1, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }] };
    const b = { slug: 'b', specs: [{ stepNumber: 2, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }] };
    const c = { slug: 'c', specs: [{ stepNumber: 3, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }] };
    writeFileSync(path.join(dir, 'a.validate-answer.json'), JSON.stringify(a));
    writeFileSync(path.join(dir, 'b.validate-answer.json'), JSON.stringify(b));
    writeFileSync(path.join(dir, 'c.validate-answer.json'), JSON.stringify(c));
    // unrelated file should be ignored
    writeFileSync(path.join(dir, 'a.json'), '{}');

    const fetchMock = makeFetchOk();
    const result = await publishValidateAnswerSpecs({
      cacheDir: dir,
      baseUrl: 'http://localhost:4004',
      apiKey: 'k',
      fetch: fetchMock,
    });

    expect(result.published).toBe(3);
    expect(result.failures).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const slugsPosted = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(init.body).slug)
      .sort();
    expect(slugsPosted).toEqual(['a', 'b', 'c']);
  });

  it('4. 404 on one slug → captured in failures, others continue', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'va-404-'));
    writeFileSync(path.join(dir, 'good.validate-answer.json'), JSON.stringify({
      slug: 'good', specs: [{ stepNumber: 1, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }],
    }));
    writeFileSync(path.join(dir, 'missing.validate-answer.json'), JSON.stringify({
      slug: 'missing', specs: [{ stepNumber: 1, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }],
    }));
    writeFileSync(path.join(dir, 'also-good.validate-answer.json'), JSON.stringify({
      slug: 'also-good', specs: [{ stepNumber: 1, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }],
    }));

    const fetchMock = vi.fn(async (url, init) => {
      const slug = JSON.parse(init.body).slug;
      if (slug === 'missing') {
        return { ok: false, status: 404, text: async () => '{"error":"tutorial_not_found"}' };
      }
      return { ok: true, status: 200, text: async () => '' };
    });

    const result = await publishValidateAnswerSpecs({
      cacheDir: dir,
      baseUrl: 'http://localhost:4004',
      apiKey: 'k',
      fetch: fetchMock,
    });

    expect(result.published).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].slug).toBe('missing');
    expect(result.failures[0].status).toBe(404);
    expect(result.failures[0].body).toContain('tutorial_not_found');
    // All three slugs were attempted — the 404 on `missing` did not abort.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('5. 5xx on one slug → captured in failures, others continue', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'va-5xx-'));
    writeFileSync(path.join(dir, 'good.validate-answer.json'), JSON.stringify({
      slug: 'good', specs: [{ stepNumber: 1, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }],
    }));
    writeFileSync(path.join(dir, 'boom.validate-answer.json'), JSON.stringify({
      slug: 'boom', specs: [{ stepNumber: 1, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }],
    }));

    const fetchMock = vi.fn(async (url, init) => {
      const slug = JSON.parse(init.body).slug;
      if (slug === 'boom') {
        return { ok: false, status: 503, text: async () => 'service unavailable' };
      }
      return { ok: true, status: 200, text: async () => '' };
    });

    const result = await publishValidateAnswerSpecs({
      cacheDir: dir,
      baseUrl: 'http://localhost:4004',
      apiKey: 'k',
      fetch: fetchMock,
    });

    expect(result.published).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].slug).toBe('boom');
    expect(result.failures[0].status).toBe(503);
    expect(result.failures[0].body).toBe('service unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('6. auth header uses apiKey argument (not env var) for testability', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'va-auth-'));
    writeFileSync(path.join(dir, 'a.validate-answer.json'), JSON.stringify({
      slug: 'a', specs: [{ stepNumber: 1, questionId: 'q', questionText: 'qt', correctAnswer: 'ca', ruleType: 'free_text', aiGrading: true }],
    }));

    // Set CONTENT_API_KEY in env to a different value — the helper must NOT
    // read it. It must use the apiKey argument exclusively.
    const prev = process.env.CONTENT_API_KEY;
    process.env.CONTENT_API_KEY = 'env-key-MUST-NOT-be-used';

    try {
      const fetchMock = makeFetchOk();
      await publishValidateAnswerSpecs({
        cacheDir: dir,
        baseUrl: 'http://localhost:4004',
        apiKey: 'arg-key-IS-used',
        fetch: fetchMock,
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.authorization).toBe('Bearer arg-key-IS-used');
      expect(init.headers.authorization).not.toContain('env-key');
    } finally {
      if (prev === undefined) delete process.env.CONTENT_API_KEY;
      else process.env.CONTENT_API_KEY = prev;
    }
  });
});
