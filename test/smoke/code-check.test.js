import { describe, it, expect } from 'vitest';
import { SRV_URL, BASE_URL, fetchWithRetry } from './smoke.config.js';

const PILOT_SLUG = process.env.SMOKE_CODECHECK_PILOT_SLUG;
const CODECHECK_TOKEN = process.env.SMOKE_CODECHECK_TOKEN;

describe('Code check endpoint smoke', () => {
  // Test 1: unauthenticated POST → 401
  it('POST /api/codecheck without auth returns 401', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/codecheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'sap-cloud-application-programming-getting-started',
        stepNumber: 1,
        submittedCode: 'const x = 1;',
      }),
    });
    expect(res.status).toBe(401);
  });

  // Test 1b — regression guard for issue #314.
  // Until #314 was fixed, POST /api/codecheck was shadowed by DeveloperService's
  // OData router (mounted at /api/* by cds.serve). The express handler in
  // cds.on('served', ...) was registered too late: CAP's OData middleware would
  // try to parse "codecheck" as an entity name and 404 with
  // {"error":{"message":"Invalid resource path \"DeveloperService.codecheck\"",...}}.
  //
  // The fix moved the mount to cds.on('bootstrap', ...) so it runs before CAP's
  // OData router for DeveloperService. This test asserts the handler is reached
  // by checking that the *response shape* is the handler's auth-failure shape,
  // not the OData parser's resource-path error shape.
  it('POST /api/codecheck is not shadowed by the /api OData router (#314 regression guard)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/codecheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'sap-cloud-application-programming-getting-started',
        stepNumber: 1,
        submittedCode: 'const x = 1;',
      }),
    });
    const text = await res.text();
    // The OData router emits a body like
    //   {"error":{"message":"Invalid resource path \"DeveloperService.codecheck\""}}
    // — that's the regression we are guarding against.
    expect(text, `Response was the OData parser error — /api/codecheck is being shadowed again. body=${text}`)
      .not.toContain('Invalid resource path');
    expect(text).not.toContain('DeveloperService.codecheck');
  });

  // Test 2: clearly-fake bearer token → 401
  it('POST /api/codecheck with a bad bearer token returns 401', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/codecheck`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer this-is-a-fake-token-and-not-valid',
      },
      body: JSON.stringify({
        tutorialSlug: 'sap-cloud-application-programming-getting-started',
        stepNumber: 1,
        submittedCode: 'const x = 1;',
      }),
    });
    expect(res.status).toBe(401);
  });

  // Test 3: pilot tutorial HTML contains the mount div but never leaks the reference solution.
  // Skip-gated: only runs when a pilot tutorial with a CODECHECK block has been deployed.
  it.skipIf(!PILOT_SLUG)(
    'pilot tutorial HTML contains step-codecheck-mount and no reference-solution leak',
    async () => {
      const res = await fetchWithRetry(`${BASE_URL}/tutorials/${PILOT_SLUG}/`);
      expect(res.status).toBe(200);

      const html = await res.text();

      // The mount div must be present on at least one step.
      // Hugo's HTML minifier may strip quotes from attribute values, so accept both forms.
      expect(html).toMatch(/class\s*=\s*["']?step-codecheck-mount["']?/);

      // Anti-leak: reference solutions must never appear in the served HTML.
      // data-reference-solution attribute would expose the answer verbatim.
      expect(html).not.toContain('data-reference-solution');

      // referenceSolution as a JS property or JSON key must also be absent
      // (case-insensitive to catch camelCase variants and serialised JSON).
      expect(html.toLowerCase()).not.toContain('referencesolution');
    }
  );

  // Test 4: authenticated POST returns a verdict object.
  // Skip-gated: only runs when a valid XSUAA bearer token is provided via env.
  it.skipIf(!CODECHECK_TOKEN)(
    'POST /api/codecheck with valid auth returns 200 with a verdict',
    async () => {
      const slug = PILOT_SLUG || 'sap-cloud-application-programming-getting-started';
      const stepNumber = Number(process.env.SMOKE_CODECHECK_PILOT_STEP) || 1;
      const res = await fetchWithRetry(`${SRV_URL}/api/codecheck`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CODECHECK_TOKEN}`,
        },
        body: JSON.stringify({
          tutorialSlug: slug,
          stepNumber,
          submittedCode: 'const srv = await cds.connect.to("CatalogService");',
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      // Verify the real API contract from CHECK_CODE_OUTPUT_SCHEMA.
      expect(['pass', 'partial', 'fail'], `Expected verdict in ['pass','partial','fail'], got: ${JSON.stringify(body)}`).toContain(body.verdict);
      expect(typeof body.summary, `Expected summary string, got: ${JSON.stringify(body)}`).toBe('string');
      expect(Array.isArray(body.correctAspects), `Expected correctAspects array, got: ${JSON.stringify(body)}`).toBe(true);
      expect(Array.isArray(body.suggestions), `Expected suggestions array, got: ${JSON.stringify(body)}`).toBe(true);
    }
  );
});
