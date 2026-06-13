// test/unit/server-route-mounting.test.js
// Regression guard for issue #314 — POST /api/codecheck and /api/validate-answer
// must be mounted in `cds.on('bootstrap')`, BEFORE CAP's OData router for
// DeveloperService (mounted at /api/*) gets a chance to intercept.
//
// Without the bootstrap-mount, requests fall through to the OData parser and
// fail with `{"error":{"message":"Invalid resource path \"DeveloperService.codecheck\""}}`.
//
// This test boots CAP via `cds.test('serve')` (in-memory SQLite, no HANA bind
// needed) and confirms the handlers receive the request — proven by the
// response NOT containing the OData parser error and the status NOT being a
// CAP-routed 404 with the resource-path error body.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const { GET, POST } = cds.test('serve', '--project', '.');

describe('Route mounting — /api/* express handlers must precede DeveloperService OData router (#314)', () => {
  it('POST /api/codecheck reaches the express handler, not CAP\'s OData parser', async () => {
    let status, body;
    try {
      const res = await POST('/api/codecheck', {
        tutorialSlug: 'x',
        stepNumber: 1,
        submittedCode: 'y',
      });
      status = res.status;
      body = res.data;
    } catch (err) {
      // CAP's POST helper throws on non-2xx; capture the response we care about.
      status = err.response?.status;
      body = err.response?.data;
    }

    const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? '');

    // The OData router emits exactly this string; the handler never does.
    expect(
      bodyText,
      `Body looks like the OData parser error — /api/codecheck is shadowed again.\nstatus=${status} body=${bodyText.slice(0, 300)}`
    ).not.toContain('Invalid resource path');
    expect(bodyText).not.toContain('DeveloperService.codecheck');
  });

  it('POST /api/validate-answer reaches the express handler, not CAP\'s OData parser', async () => {
    let status, body;
    try {
      const res = await POST('/api/validate-answer', {
        tutorialSlug: 'x',
        stepNumber: 1,
        questionId: 'q1',
        answer: 'y',
      });
      status = res.status;
      body = res.data;
    } catch (err) {
      status = err.response?.status;
      body = err.response?.data;
    }

    const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? '');

    expect(
      bodyText,
      `Body looks like the OData parser error — /api/validate-answer is shadowed again.\nstatus=${status} body=${bodyText.slice(0, 300)}`
    ).not.toContain('Invalid resource path');
    expect(bodyText).not.toContain('DeveloperService.validate-answer');
  });

  it('DeveloperService at /api/ still serves OData metadata (positive control)', async () => {
    // If our bootstrap reservation accidentally captured all of /api/*, this
    // test would 404. It should still return the OData service document.
    const { status, data } = await GET('/api/');
    expect(status).toBe(200);
    expect(data).toHaveProperty('@odata.context');
    expect(data.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Tutorials' }),
    ]));
  });
});
