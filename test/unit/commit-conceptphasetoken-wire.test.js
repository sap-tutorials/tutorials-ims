// test/unit/commit-conceptphasetoken-wire.test.js
//
// FIX 1 (#2802): verify the conceptPhaseToken wiring end-to-end:
//
//   A. publish-client.commitSession includes conceptPhaseToken in the POST body
//      (mirrors pipelineToken).
//
//   B. content-store.js commitHandler destructures conceptPhaseToken from
//      req.body and forwards it into sessionHelpers.commitSession.
//
// These tests prove the wire shape without needing live HANA — the actual
// persistence of the column on ContentManifest is covered by
// content-publish-session-phasetoken.test.js.

import { describe, it, expect, vi, afterEach } from 'vitest';

// ============================================================================
// Part A: publish-client POST body shape
// ============================================================================
import { commitSession as clientCommitSession } from '../../scripts/lib/publish-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('publish-client.commitSession — POST body includes conceptPhaseToken', () => {
  it('sends conceptPhaseToken in the POST body when provided (mirrors pipelineToken)', async () => {
    const capturedBodies = [];
    const mockFetch = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBodies.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: 1, fileCount: 10, totalSizeBytes: 1000, durationMs: 50, alreadyActive: false, rejectedReverts: [] }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const TOKEN = 'cpt-deadbeef00112233deadbeef00112233deadbeef00112233deadbeef001122';
    const PIPELINE = 'pipe-aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc00112233';

    await clientCommitSession({
      baseUrl: 'http://localhost:4004',
      apiKey: 'test-key',
      sessionId: 'sess-aabbccdd',
      pipelineToken: PIPELINE,
      conceptPhaseToken: TOKEN,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = capturedBodies[0];
    expect(body.pipelineToken, 'pipelineToken must be in POST body').toBe(PIPELINE);
    expect(body.conceptPhaseToken, 'conceptPhaseToken must be in POST body').toBe(TOKEN);
    expect(body.sessionId).toBe('sess-aabbccdd');
  });

  it('sends conceptPhaseToken: null when not provided (back-compat)', async () => {
    const capturedBodies = [];
    const mockFetch = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBodies.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: 1, fileCount: 5, totalSizeBytes: 500, durationMs: 30, alreadyActive: false, rejectedReverts: [] }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    await clientCommitSession({
      baseUrl: 'http://localhost:4004',
      apiKey: 'test-key',
      sessionId: 'sess-eeff0011',
      // conceptPhaseToken intentionally omitted
    });

    const body = capturedBodies[0];
    // null sentinel must be present (not undefined/missing) — JSON.stringify would
    // drop an undefined value, so this also proves the key appears in the wire payload.
    expect(Object.prototype.hasOwnProperty.call(body, 'conceptPhaseToken'), 'conceptPhaseToken key must exist in body').toBe(true);
    expect(body.conceptPhaseToken).toBeNull();
  });
});

// ============================================================================
// Part B: commitHandler destructures conceptPhaseToken and forwards it
//
// commitHandler is a closure inside createContentHandlers that closes over
// sessionHelpers (created by createSessionHelpers). We verify the forwarding
// via a CDS in-memory integration: beginSession + appendSession + commitHandler
// with a real req/res — and then inspect what commitSession actually received
// by reading ContentManifest.conceptPhaseToken (same approach as
// content-publish-session-phasetoken.test.js, but exercising the HTTP handler
// layer rather than sessionHelpers directly).
// ============================================================================
import { describe as describeB, it as itB, expect as expectB, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createContentHandlers } from '../../packages/content/content-store.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

describeB('commitHandler — forwards conceptPhaseToken from req.body to ContentManifest', () => {
  let handlers;
  let ContentManifest, ContentFiles, PipelineLog, JobLocks;
  let sessionId;

  beforeAll(() => {
    handlers = createContentHandlers({ namespace: NS });
    ({ ContentManifest, ContentFiles, PipelineLog, JobLocks } = cds.entities(NS));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);

    // Begin a session via the handler (mirrors real publish flow)
    const beginRes = await new Promise((resolve) => {
      const captured = {};
      handlers.beginHandler(
        {
          body: { trigger: 'unit-wire-test', hugoVersion: '0.147.0', expectedSlugCount: 1 },
          headers: {},
          get: () => undefined,
        },
        {
          status: () => ({ json: (v) => { captured.result = v; resolve(captured.result); } }),
        }
      );
    });
    sessionId = beginRes.sessionId;

    // Append a file so commit has something to commit
    await new Promise((resolve, reject) => {
      handlers.appendHandler(
        {
          body: {
            sessionId,
            files: { 'wire-test-slug': gzipSync(Buffer.from('<html><body><main>wire test</main></body></html>', 'utf-8')).toString('base64') },
          },
        },
        {
          status: (code) => ({
            json: (v) => { if (code >= 400) reject(new Error(`append failed ${code}: ${JSON.stringify(v)}`)); else resolve(v); },
          }),
        }
      );
    });
  });

  itB('commitHandler passes conceptPhaseToken from req.body through to ContentManifest', async () => {
    const TOKEN = 'cpt-11223344556677889900aabbccddeeff11223344556677889900aabbccddee';
    const PIPELINE = 'pipe-00112233445566778899aabbccddeeff00112233445566778899aabbccddee';

    await new Promise((resolve, reject) => {
      handlers.commitHandler(
        {
          body: {
            sessionId,
            allowRevertSlugs: [],
            pipelineToken: PIPELINE,
            conceptPhaseToken: TOKEN,
          },
        },
        {
          status: (code) => ({
            json: (v) => { if (code >= 400) reject(new Error(`commit failed ${code}: ${JSON.stringify(v)}`)); else resolve(v); },
          }),
        }
      );
    });

    const manifest = await SELECT.one.from(ContentManifest).where({ sessionId });
    expectB(manifest, 'manifest row must exist').toBeTruthy();
    expectB(manifest.status).toBe('ACTIVE');
    expectB(manifest.pipelineToken, 'pipelineToken must be persisted on ContentManifest').toBe(PIPELINE);
    expectB(manifest.conceptPhaseToken, 'conceptPhaseToken must be persisted on ContentManifest').toBe(TOKEN);
  });

  itB('commitHandler without conceptPhaseToken leaves the column null (back-compat)', async () => {
    await new Promise((resolve, reject) => {
      handlers.commitHandler(
        { body: { sessionId, allowRevertSlugs: [] } },
        {
          status: (code) => ({
            json: (v) => { if (code >= 400) reject(new Error(`commit failed ${code}: ${JSON.stringify(v)}`)); else resolve(v); },
          }),
        }
      );
    });

    const manifest = await SELECT.one.from(ContentManifest).where({ sessionId });
    expectB(manifest).toBeTruthy();
    expectB(manifest.conceptPhaseToken).toBeNull();
  });
});
