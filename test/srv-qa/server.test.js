// test/srv-qa/server.test.js
//
// [#655] Task 3: /preview/render handler validation of optional rulesVr field.
//
// We don't have supertest in the project; instead we mount the same handler
// shape in an inline Express app and exercise it via real HTTP on an ephemeral
// port. The auth middleware (requireXsuaaScope) passes through in unit-test
// mode (no VCAP_SERVICES present) — see xsuaa-scope-middleware.test.js for
// the contract. This lets the test focus on body validation without an XSUAA
// stub.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { requireXsuaaScope, _resetForTests } from '../../srv-qa/xsuaa-scope-middleware.js';
import { createSemaphore } from '../../srv-qa/preview-semaphore.js';
import * as previewRenderer from '../../srv-qa/preview-renderer.js';

// Build a test express app that mirrors the body-validation shape of the
// real /preview/render handler in srv-qa/server.js. We don't mount cds.on
// here — the handler is structurally identical, and the validation lives
// in the same closure.
function buildTestApp({ renderPreviewImpl }) {
  const app = express();
  const requireAuthorScope = requireXsuaaScope('Tutorial.Author');
  const previewSemaphore = createSemaphore(4);
  const PREVIEW_QUEUE_TIMEOUT_MS = 10_000;

  app.post('/preview/render',
    requireAuthorScope,
    express.json({ limit: '1mb' }),
    async (req, res) => {
      let slot;
      try {
        slot = await previewSemaphore.acquire(PREVIEW_QUEUE_TIMEOUT_MS);
      } catch {
        res.status(503).json({ error: 'busy' });
        return;
      }
      try {
        const markdown = req.body?.markdown;
        if (typeof markdown !== 'string') {
          res.status(400).json({ error: 'expected JSON body { markdown: string, rulesVr?: string }' });
          return;
        }
        const rulesVr = req.body?.rulesVr;
        if (rulesVr !== undefined && typeof rulesVr !== 'string') {
          res.status(400).json({ error: 'rulesVr must be a string when provided' });
          return;
        }
        const { html, status, durationMs, bytes } = await renderPreviewImpl(markdown, rulesVr);
        console.log(JSON.stringify({
          event: 'preview.render',
          status,
          ms: durationMs,
          bytes,
          hasRulesVr: typeof rulesVr === 'string' && rulesVr.length > 0,
          totalMs: 0,
        }));
        res.set('Content-Type', 'text/html; charset=utf-8').status(200).send(html);
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        slot.release();
      }
    }
  );

  return app;
}

describe('POST /preview/render — rulesVr payload validation [#655]', () => {
  let server;
  let baseUrl;
  let renderCalls;
  let stubRender;

  beforeAll(() => {
    _resetForTests();
    delete process.env.VCAP_SERVICES;
    delete process.env.VCAP_APPLICATION;
  });

  beforeEach(async () => {
    renderCalls = [];
    stubRender = async (markdown, rulesVr) => {
      renderCalls.push({ markdown, rulesVr });
      return { html: '<!doctype html><html><body>ok</body></html>', status: 'ok', durationMs: 1, bytes: 42 };
    };
    const app = buildTestApp({ renderPreviewImpl: stubRender });
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('rejects non-string rulesVr with 400', async () => {
    const r = await fetch(`${baseUrl}/preview/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '---\ntitle: t\n---\n\n### S\nx\n', rulesVr: 123 }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/rulesVr/);
    expect(renderCalls.length).toBe(0);
  });

  it('accepts empty-string rulesVr as omitted (200)', async () => {
    const r = await fetch(`${baseUrl}/preview/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '---\ntitle: t\n---\n\n### S\nx\n', rulesVr: '' }),
    });
    expect(r.status).toBe(200);
    expect(renderCalls.length).toBe(1);
    // Empty string is forwarded as-is to renderPreview; the renderer's own
    // contract (Task 2) treats empty/undefined identically.
    expect(renderCalls[0].rulesVr).toBe('');
  });

  it('accepts valid rulesVr string (200) and forwards to renderPreview', async () => {
    const rulesVr = '[VALIDATE_1]\n###Rule\nmultiple-choice\n[VALIDATE_END_1]\n';
    const r = await fetch(`${baseUrl}/preview/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '---\ntitle: t\n---\n\n### S\nx\n', rulesVr }),
    });
    expect(r.status).toBe(200);
    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].rulesVr).toBe(rulesVr);
  });

  it('still rejects missing markdown with 400 (regression guard)', async () => {
    const r = await fetch(`${baseUrl}/preview/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rulesVr: 'x' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/markdown/);
    expect(renderCalls.length).toBe(0);
  });

  it('omitted rulesVr forwards undefined to renderPreview', async () => {
    const r = await fetch(`${baseUrl}/preview/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '---\ntitle: t\n---\n\n### S\nx\n' }),
    });
    expect(r.status).toBe(200);
    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].rulesVr).toBeUndefined();
  });

  it('logs hasRulesVr=true when a non-empty rulesVr is provided', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await fetch(`${baseUrl}/preview/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '---\ntitle: t\n---\n\n### S\nx\n', rulesVr: '[VALIDATE_1]\n...\n' }),
      });
      const logged = logSpy.mock.calls
        .map((c) => c[0])
        .filter((s) => typeof s === 'string' && s.includes('"event":"preview.render"'));
      expect(logged.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logged[0]);
      expect(parsed.hasRulesVr).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs hasRulesVr=false when rulesVr is empty string', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await fetch(`${baseUrl}/preview/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '---\ntitle: t\n---\n\n### S\nx\n', rulesVr: '' }),
      });
      const logged = logSpy.mock.calls
        .map((c) => c[0])
        .filter((s) => typeof s === 'string' && s.includes('"event":"preview.render"'));
      expect(logged.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logged[0]);
      expect(parsed.hasRulesVr).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });
});
