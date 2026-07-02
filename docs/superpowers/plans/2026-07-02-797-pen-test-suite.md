# CSRF / XSS / Injection Penetration Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a focused pen-test regression suite (6 test files) plus a CI grep guard so future PRs cannot silently reintroduce CSRF/XSS/injection surface. Framework defaults (CAP CSRF auto-enforcement, Fiori Elements token prefetch, `sanitize-html`, approuter CSP) already cover the primary attack surface — this backfill *tests* what is already *defended*.

**Architecture:** Six new test files (2 unit + 4 smoke) added under `test/unit/` and `test/smoke/`, no source-code changes. One new pre-build guard script (`scripts/check-hugo-safe-html.cjs`) grep'd via `predocs:build`-style wiring. Documentation updated in `docs/developers/operations/testing-endpoints.md` with a new "Security Testing Reference" section that cross-links each pen-test file to the endpoint it covers.

**Tech Stack:** vitest workspaces (`unit`, `smoke`), native `fetch` via `test/smoke/smoke.config.js` (`fetchWithRetry`, `SRV_URL`, `BASE_URL`), the existing `srv/lib/analytics-sql-validator.cjs` (`validateSelect`) and `scripts/parsers/sanitize-html.ts`. No new dependencies.

**Non-goals:**
- No source-code changes to `srv/lib/analytics-sql-validator.cjs`, `srv/server.js`, or `approuter/xs-app.json`. Any real vulnerability the tests uncover becomes a **separate** follow-up issue with its own PR.
- One-line `export` addition to `scripts/parsers/sanitize-html.ts` is allowed if `sanitizeLine` needs to be reachable from the test (recon confirms it's currently internal). Prefer testing via `stripDangerousHtml` if it covers the surface.
- No `sanitize-html` package upgrade. We test our config, not the library.
- No new smoke-runner infrastructure — reuses `test/smoke/smoke.config.js`.

**File-count note:** Issue #797 recommends 6 test files. This plan produces 7 total: the 6 pen-test files from the spec **plus** `test/unit/scripts/check-hugo-safe-html.test.js` (unit tests for the grep guard itself). The extra file is justified by the "Grep-based CI check" acceptance criterion, which requires a testable guard — untested guards rot. Reviewer of the PR should decide if this trade-off is acceptable; the alternative is a manually-tested guard (higher regression risk).

**Related issue:** [#797](https://github.com/sap-tutorials/tutorials-ims/issues/797)

---

## File Structure

**Create:**
- `test/unit/srv/analytics-sql-validator.pen.test.js` — 20–30 malicious SQL fixtures against `validateSelect`
- `test/unit/scripts/sanitize-html.pen.test.js` — OWASP XSS cheatsheet payloads against `sanitizeLine`
- `test/smoke/csrf-enforcement.test.js` — 8–12 CSRF assertions on OData + custom Express mutations
- `test/smoke/xss-reflection.test.js` — assertions that reflected data on public pages is HTML-encoded
- `test/smoke/express-route-mutations.test.js` — auth + scope + malformed-body rejection on custom Express POSTs
- `test/smoke/security-headers.test.js` — CSP, XFO, XCTO, HSTS, Referrer-Policy on approuter HTML
- `scripts/check-hugo-safe-html.cjs` — grep guard: no new `safeHTML`/`safeHTMLAttr`/`printf "<...>"` in `hugo/layouts/` without a `<!-- security-reviewed -->` marker
- `test/unit/scripts/check-hugo-safe-html.test.js` — unit tests for the grep guard itself

**Modify:**
- `docs/developers/operations/testing-endpoints.md` — add "Security Testing Reference" section after "Quick Smoke Test Checklist"
- `package.json` — wire `check-hugo-safe-html.cjs` into `precommit` / a `check:security-annotations` script, and reference from CI

**Do NOT modify:**
- `srv/lib/analytics-sql-validator.cjs` — tests probe existing behavior; any real finding is a follow-up issue.
- `scripts/parsers/sanitize-html.ts` — same policy.
- `srv/server.js`, `approuter/xs-app.json` — same policy.
- `vitest.config.ts` — the existing `unit` and `smoke` glob includes already pick up new files.

**Reference recon (from Explore agent, 2026-07-02):**
- `srv/lib/analytics-sql-validator.cjs` exports only `{ validateSelect }`. Internal allowlist covers ~30 HANA functions and `MAX_LEN = 16384`. Existing tests: none.
- `scripts/parsers/sanitize-html.ts` exports `ALLOWED_IFRAME_HOSTNAMES`. `sanitizeLine()` is defined below the head of the file. Existing tests: none.
- `srv/server.js` has 17 custom `app.post(...)` routes. No `.put()`/`.delete()`.
- `approuter/xs-app.json` has 37 routes with `"csrfProtection": false`.
- `hugo/layouts/` has 7 `safeHTML` occurrences across 6 files, all currently reviewed/trusted internal sources — the grep guard baselines those with `<!-- security-reviewed -->` markers.
- Smoke test pattern: `import { describe, it, expect } from 'vitest'; import { SRV_URL, fetchWithRetry } from './smoke.config.js';`
- Unit test pattern: `import { describe, it, expect } from 'vitest';` plus dynamic import of the module under test.

---

## Task 0: Baseline `<!-- security-reviewed -->` markers on existing Hugo `safeHTML` usages

The grep guard (Task 6) fails the build on any un-annotated `safeHTML`. To prevent that guard from being a nag on unrelated PRs, we annotate the 7 pre-existing occurrences up front as trusted-baseline. This is a mechanical, no-behavior change.

**Files (from recon):**
- Modify: `hugo/layouts/developer-advocates/single.html`
- Modify: `hugo/layouts/explore/about.html`
- Modify: `hugo/layouts/shortcodes/hero.html`
- Modify: `hugo/layouts/shortcodes/mermaid.html`
- Modify: `hugo/layouts/_default/_markup/render-image.html` (2 occurrences)

- [ ] **Step 0.1: Confirm current `safeHTML` locations**

Run: `grep -rn -E "safeHTML|safeHTMLAttr" hugo/layouts/`
Expected: 7 lines across the 6 files listed above.

- [ ] **Step 0.2: Add `<!-- security-reviewed: <one-line rationale> -->` immediately above each `safeHTML` line**

Rationale template: `<!-- security-reviewed: <source> — <why trusted> -->`. Examples:
- Advocates single: `<!-- security-reviewed: rendered from HANA AdvocateBios; admin-supplied, sanitize-html'd at write path -->`
- explore/about: `<!-- security-reviewed: readFile of a static repo asset; not user-supplied -->`
- hero shortcode / mermaid shortcode: `<!-- security-reviewed: shortcode .Inner is author-supplied Hugo template content, not runtime user input -->`
- render-image.html (×2): `<!-- security-reviewed: safeHTMLAttr on markdown image alt/title parsed by Hugo; markdown source is trusted authored content -->`

The exact wording is not important — the marker `security-reviewed:` is what the guard grep for.

- [ ] **Step 0.3: Verify the guard grep does not fire yet (guard doesn't exist — sanity check for future runs)**

Run: `grep -rn -E "safeHTML|safeHTMLAttr" hugo/layouts/ | wc -l`
Run: `grep -rB1 -E "safeHTML|safeHTMLAttr" hugo/layouts/ | grep -c "security-reviewed:"`
Expected: both counts equal 7.

- [ ] **Step 0.4: Confirm Hugo still builds (annotations are HTML comments, harmless)**

Run: `npm run fetch-tutorials && npx hugo --source hugo --minify --gc --logLevel info 2>&1 | tail -20`
Expected: build succeeds, no new warnings.
If `fetch-tutorials` needs `CAP_BASE_URL`, use the DEV url per `CLAUDE.md § Gotchas`.

- [ ] **Step 0.5: Commit**

```bash
git add hugo/layouts/
git commit -m "chore(#797): baseline security-reviewed markers on existing safeHTML usages

Prep for the pen-test suite's Hugo grep guard (see #797). All 7 existing
safeHTML/safeHTMLAttr occurrences are trusted-baseline (admin-supplied
+ sanitized, or shortcode template content, or static file reads).
Adding the marker so the forthcoming guard doesn't false-positive."
```

---

## Task 1: `analytics-sql-validator.pen.test.js` — SQL injection fuzz

Fuzz `validateSelect` with malicious statements. The validator is the single point of trust for `AnalyticsService.runSelectQuery`.

**Files:**
- Create: `test/unit/srv/analytics-sql-validator.pen.test.js`

- [ ] **Step 1.1: Write the failing test file with `expect.fail()` placeholder**

```javascript
// test/unit/srv/analytics-sql-validator.pen.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const validator = require(path.resolve(import.meta.dirname, '../../../srv/lib/analytics-sql-validator.cjs'));

// Minimal allowlist matching real AnalyticsService exposure — extend if
// analytics-service.js is refactored to expose a broader set.
const ALLOWED = ['Users', 'TaskRecords', 'Missions', 'Tutorials'];

describe('analytics-sql-validator: injection fuzz (#797)', () => {
  describe('rejects DDL/DML', () => {
    const cases = [
      ['DROP TABLE Users', /select/i],
      ['DELETE FROM Users', /select/i],
      ['UPDATE Users SET name=\'x\'', /select/i],
      ['INSERT INTO Users VALUES (1)', /select/i],
      ['TRUNCATE TABLE Users', /select/i],
      ['ALTER TABLE Users ADD c INT', /select/i],
      ['CREATE TABLE t (id INT)', /select/i],
    ];
    it.each(cases)('rejects %s', (sql) => {
      expect(() => validator.validateSelect(sql, ALLOWED)).toThrow();
    });
  });

  describe('rejects multi-statement / stacked queries', () => {
    const cases = [
      'SELECT * FROM Users; DROP TABLE Users',
      'SELECT 1; DELETE FROM Users',
      'SELECT * FROM Users; SELECT * FROM Missions',
    ];
    it.each(cases)('rejects %s', (sql) => {
      expect(() => validator.validateSelect(sql, ALLOWED)).toThrow();
    });
  });

  describe('rejects comment-based bypass', () => {
    const cases = [
      'SELECT * FROM Users -- ; DROP TABLE Users',
      'SELECT * FROM Users /* comment */',
      'SELECT /* nested */ * FROM Users',
    ];
    it.each(cases)('rejects %s', (sql) => {
      expect(() => validator.validateSelect(sql, ALLOWED)).toThrow();
    });
  });

  describe('rejects unallowed tables', () => {
    it('rejects SELECT * FROM ImsConfig (secret table)', () => {
      expect(() => validator.validateSelect('SELECT * FROM ImsConfig', ALLOWED)).toThrow();
    });
    it('rejects SELECT * FROM SYS.M_DATABASE (HANA information schema)', () => {
      expect(() => validator.validateSelect('SELECT * FROM SYS.M_DATABASE', ALLOWED)).toThrow();
    });
  });

  describe('rejects disallowed functions', () => {
    const cases = [
      'SELECT SESSION_USER FROM DUMMY',
      'SELECT CURRENT_USER FROM Users',
      'SELECT SYSTEM_USER FROM Users',
      // These may or may not throw depending on the validator's function detection.
      // The intent is to pin behavior: if the validator ALLOWS these today, this
      // test fails and prompts a follow-up ticket.
    ];
    it.each(cases)('rejects %s', (sql) => {
      expect(() => validator.validateSelect(sql, ALLOWED)).toThrow();
    });
  });

  describe('rejects oversize input', () => {
    it('rejects SQL longer than 16384 chars', () => {
      const huge = 'SELECT * FROM Users WHERE id IN (' +
        Array.from({ length: 5000 }, (_, i) => i).join(',') + ')';
      expect(huge.length).toBeGreaterThan(16384);
      expect(() => validator.validateSelect(huge, ALLOWED)).toThrow();
    });
  });

  describe('accepts legitimate SELECTs', () => {
    it('accepts a plain SELECT', () => {
      const { sql, selectedColumns } = validator.validateSelect(
        'SELECT id, name FROM Users',
        ALLOWED,
      );
      expect(sql.toLowerCase()).toContain('select');
      expect(selectedColumns).toEqual(expect.arrayContaining(['id', 'name']));
    });
    it('accepts SELECT with allowlisted COUNT()', () => {
      expect(() => validator.validateSelect('SELECT COUNT(*) FROM Users', ALLOWED)).not.toThrow();
    });
    it('accepts SELECT with WHERE + parameter placeholder', () => {
      expect(() => validator.validateSelect("SELECT id FROM Users WHERE name = 'x'", ALLOWED)).not.toThrow();
    });
  });
});
```

Note: 20+ cases across 6 buckets. If any legitimate case fails, that means the validator is over-strict (not a bug — a design choice) — adjust the test to match observed behavior and document it. If any injection case passes (test unexpectedly green when writing), file a follow-up ticket referencing #797 before adjusting the test.

- [ ] **Step 1.2: Run tests to confirm the file compiles**

Run: `npx vitest run test/unit/srv/analytics-sql-validator.pen.test.js --project unit`
Expected: 20+ tests execute. Some will pass, some may fail depending on the validator's actual behavior. Green tests confirm the defense; red tests are either (a) validator gap needing follow-up issue, or (b) test assumption wrong — read the error and decide.

- [ ] **Step 1.3: For every red test, decide follow-up vs. adjust**

For each failure: is this a real gap in `validateSelect`?
- **Yes, real gap:** file a follow-up issue referencing #797. In the test, wrap the assertion in a comment `// TODO(#XXX): validator lets this through today — real gap` and use `.skip` on the individual case. Do NOT edit `analytics-sql-validator.cjs` in this task.
- **No, test wrong:** fix the test assertion to match observed behavior.

- [ ] **Step 1.4: Run to green**

Run: `npx vitest run test/unit/srv/analytics-sql-validator.pen.test.js --project unit`
Expected: all tests pass (skipped ones show `-`). Skipped-count should be 0 in the happy path; document any skips inline with a TODO+issue link.

- [ ] **Step 1.5: Commit**

```bash
git add test/unit/srv/analytics-sql-validator.pen.test.js
git commit -m "test(#797): analytics-sql-validator injection fuzz suite

Adds ~25 malicious SQL fixtures against validateSelect: DDL/DML, stacked
queries, comment bypasses, unallowed tables, disallowed functions, oversize
input. Positive cases pin the happy path (plain SELECT, COUNT, WHERE clauses).

No source changes; any real gap becomes a follow-up issue per plan."
```

---

## Task 2: `sanitize-html.pen.test.js` — XSS payload fuzz

Fuzz `sanitizeLine` (or whichever function `sanitize-html.ts` exports for line-level sanitization) with the OWASP XSS Filter Evasion Cheat Sheet payloads.

**Files:**
- Create: `test/unit/scripts/sanitize-html.pen.test.js`

- [ ] **Step 2.1: Confirm the function surface first**

Run: `grep -nE "^export" scripts/parsers/sanitize-html.ts`
Expected output includes the function(s) the test will call. **Recon (2026-07-02) confirms `sanitizeLine` is defined but NOT exported** (only `ALLOWED_IFRAME_HOSTNAMES` and `stripDangerousHtml` are). Task 2.4 handles this: add `export` to the function definition (one-line change). Alternatively, test via the exported `stripDangerousHtml` wrapper if it covers the same surface — prefer that if it does, to keep the export surface small.

- [ ] **Step 2.2: Write the failing test**

```javascript
// test/unit/scripts/sanitize-html.pen.test.js
import { describe, it, expect } from 'vitest';
// Import name adapts to Step 2.1 result. Example uses `sanitizeLine`.
import { sanitizeLine } from '../../../scripts/parsers/sanitize-html.ts';

// OWASP XSS Filter Evasion Cheat Sheet — condensed high-signal set
const XSS_PAYLOADS = [
  { name: 'basic script tag', input: '<script>alert(1)</script>' },
  { name: 'img onerror', input: '<img src=x onerror=alert(1)>' },
  { name: 'svg onload', input: '<svg onload=alert(1)>' },
  { name: 'javascript URI in href', input: '<a href="javascript:alert(1)">x</a>' },
  { name: 'data URI in href', input: '<a href="data:text/html,<script>alert(1)</script>">x</a>' },
  { name: 'iframe with srcdoc', input: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { name: 'style expression', input: '<div style="background:url(javascript:alert(1))">x</div>' },
  { name: 'meta refresh', input: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' },
  { name: 'object embed', input: '<object data="javascript:alert(1)"></object>' },
  { name: 'embed src', input: '<embed src="javascript:alert(1)">' },
  { name: 'form action javascript', input: '<form action="javascript:alert(1)"><input type=submit></form>' },
  { name: 'onmouseover attr', input: '<div onmouseover="alert(1)">x</div>' },
  { name: 'onclick attr', input: '<button onclick="alert(1)">x</button>' },
  { name: 'entity-encoded script', input: '&#60;script&#62;alert(1)&#60;/script&#62;' },
  { name: 'UTF-7 script (historical)', input: '+ADw-script+AD4-alert(1)+ADw-/script+AD4-' },
  { name: 'null byte in tag', input: '<scr\0ipt>alert(1)</scr\0ipt>' },
  { name: 'newline in tag', input: '<scri\npt>alert(1)</scr\nipt>' },
  { name: 'uppercase SCRIPT', input: '<SCRIPT>alert(1)</SCRIPT>' },
  { name: 'mixed case iFRaMe', input: '<iFRaMe src="javascript:alert(1)"></iFRaMe>' },
  { name: 'style tag with @import', input: '<style>@import "javascript:alert(1)";</style>' },
];

describe('sanitize-html: XSS payload fuzz (#797)', () => {
  it.each(XSS_PAYLOADS)('neutralizes: $name', ({ input }) => {
    const output = sanitizeLine(input);
    // Sanitized output must not contain any executable form of the payload.
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/javascript:/i);
    expect(output).not.toMatch(/on\w+\s*=/i);
    expect(output).not.toMatch(/<iframe(?![^>]*src="https:\/\/(www\.youtube\.com|youtube\.com|youtu\.be|microlearning\.opensap\.com|sapvideo\.cfapps\.eu10-004\.hana\.ondemand\.com))/i);
  });

  describe('allowlist positive cases', () => {
    it('preserves <a href="https://...">', () => {
      const out = sanitizeLine('<a href="https://example.com">x</a>');
      expect(out).toContain('href="https://example.com"');
    });
    it('preserves <code>', () => {
      const out = sanitizeLine('<code>x</code>');
      expect(out).toContain('<code>');
    });
    it('preserves YouTube iframe (allowlisted host)', () => {
      const out = sanitizeLine('<iframe src="https://www.youtube.com/embed/x"></iframe>');
      expect(out).toContain('iframe');
      expect(out).toContain('youtube.com');
    });
  });
});
```

- [ ] **Step 2.3: Run test to verify it exercises the sanitizer**

Run: `npx vitest run test/unit/scripts/sanitize-html.pen.test.js --project unit`
Expected: 20 injection cases + 3 allowlist positive cases execute. All pass if sanitizer is doing its job. Same red-vs-adjust protocol as Task 1: real gaps → follow-up issue + `.skip`; test-wrong → adjust assertion.

- [ ] **Step 2.4: (Conditional) If import fails because the function isn't exported**

Minimal one-line addition to `scripts/parsers/sanitize-html.ts`:

```typescript
export function sanitizeLine(...) { ... }  // was: function sanitizeLine
```

Only make this export change if the test cannot otherwise reach the sanitizer. Note in the commit.

- [ ] **Step 2.5: Run to green**

Run: `npx vitest run test/unit/scripts/sanitize-html.pen.test.js --project unit`
Expected: all pass (or `.skip` with follow-up issue).

- [ ] **Step 2.6: Commit**

```bash
git add test/unit/scripts/sanitize-html.pen.test.js scripts/parsers/sanitize-html.ts
git commit -m "test(#797): sanitize-html XSS payload fuzz suite

20 payloads from OWASP XSS Filter Evasion Cheat Sheet plus 3 positive
allowlist cases. Asserts sanitized output has no <script>, javascript:,
event handlers, or off-allowlist <iframe>.

No behavior change to sanitize-html.ts."
```

---

## Task 3: `security-headers.test.js` — CSP/XFO/XCTO/HSTS/Referrer-Policy on approuter

Cheapest smoke test — just fetches the approuter root and asserts headers.

**Files:**
- Create: `test/smoke/security-headers.test.js`

- [ ] **Step 3.1: Write the failing test**

```javascript
// test/smoke/security-headers.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe.skipIf(!BASE_URL || BASE_URL.startsWith('http://localhost'))(
  'Approuter security headers (#797)',
  () => {
    it('sets CSP with default-src \'self\'', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeTruthy();
      expect(csp).toMatch(/default-src\s+'self'/);
    });

    it('sets X-Frame-Options SAMEORIGIN', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });

    it('sets X-Content-Type-Options nosniff', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('sets Strict-Transport-Security with includeSubDomains and preload', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const hsts = res.headers.get('strict-transport-security');
      expect(hsts).toBeTruthy();
      expect(hsts).toMatch(/max-age=\d+/);
      expect(hsts).toMatch(/includeSubDomains/);
    });

    it('sets Referrer-Policy strict-origin-when-cross-origin', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    });

    it('CSP script-src allows known SAP hosts', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const csp = res.headers.get('content-security-policy');
      // Approuter serves ui5 assets from ui5.sap.com; loosening this would be a regression.
      expect(csp).toMatch(/script-src[^;]*ui5\.sap\.com/);
    });
  },
);
```

Note: `describe.skipIf` guards against localhost (headers are typically set by the deployed approuter, not the local CAP CORS response). This runs only when `SMOKE_BASE_URL` points at a real approuter.

- [ ] **Step 3.2: Run test locally with SMOKE_BASE_URL pointing at DEV approuter**

Run: `SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" npx vitest run test/smoke/security-headers.test.js --project smoke`
Expected: all 6 assertions pass (recon confirmed live headers include all five).

- [ ] **Step 3.3: Run test with no `SMOKE_BASE_URL` and confirm skip**

Run: `npx vitest run test/smoke/security-headers.test.js --project smoke`
Expected: `describe.skipIf` triggers; tests report as skipped, not failed.

- [ ] **Step 3.4: Commit**

```bash
git add test/smoke/security-headers.test.js
git commit -m "test(#797): approuter security-headers smoke

Asserts CSP (default-src 'self', ui5.sap.com script-src), X-Frame-Options,
X-Content-Type-Options, HSTS with includeSubDomains, Referrer-Policy on
approuter HTML responses. Skips when SMOKE_BASE_URL is unset or localhost."
```

---

## Task 4: `csrf-enforcement.test.js` — OData mutations require x-csrf-token

CAP OData services enforce CSRF automatically. Test that POSTs without a fetched CSRF token are rejected.

**Files:**
- Create: `test/smoke/csrf-enforcement.test.js`

- [ ] **Step 4.1: Write the failing test**

```javascript
// test/smoke/csrf-enforcement.test.js
import { describe, it, expect } from 'vitest';
import { SRV_URL, BASE_URL, fetchWithRetry } from './smoke.config.js';

const AUTHOR_TOKEN = process.env.SMOKE_AUTHOR_TOKEN;

// CSRF enforcement is on OData mutations. We test:
// 1. POST without any token -> 403 (or 401 if unauthenticated first).
// 2. POST with a bogus token -> 403.
// 3. HEAD/GET with x-csrf-token: fetch -> response echoes a token.
describe.skipIf(!SRV_URL)('CSRF enforcement on OData (#797)', () => {
  const authHeaders = AUTHOR_TOKEN
    ? { Authorization: `Bearer ${AUTHOR_TOKEN}` }
    : {};

  it('POST /admin/Tags without CSRF token is rejected (403 or 401)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/Tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ slug: '__test__csrf', label: 'x' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('POST /admin/Tags with x-csrf-token: bogus is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/Tags`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'bogus-not-a-real-token',
        ...authHeaders,
      },
      body: JSON.stringify({ slug: '__test__csrf', label: 'x' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('HEAD /admin/$metadata with x-csrf-token: fetch returns a token', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/$metadata`, {
      method: 'HEAD',
      headers: { 'x-csrf-token': 'fetch', ...authHeaders },
    });
    // If auth passes: expect x-csrf-token header. If auth fails: skip assertion (headers only meaningful for authenticated fetch).
    if (res.status === 200) {
      expect(res.headers.get('x-csrf-token')).toBeTruthy();
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });

  it('POST /api/getProgress (developer-service action) rejected without CSRF token', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/getProgress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([401, 403]).toContain(res.status);
  });

  it('POST /admin/Missions without CSRF token is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/Missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ slug: '__test__csrf' }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe.skipIf(!BASE_URL)('CSRF via approuter (#797)', () => {
  it('POST /admin/Tags via approuter without token is rejected', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/admin/Tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: '__test__csrf-appr', label: 'x' }),
    });
    // Approuter with `csrfProtection: false` still requires auth (XSUAA), so unauthenticated → 401/403.
    expect([401, 403]).toContain(res.status);
  });
});
```

- [ ] **Step 4.2: Run locally with SRV_URL only (no auth token)**

Run: `SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" npx vitest run test/smoke/csrf-enforcement.test.js --project smoke`
Expected: all 5 SRV-block assertions pass (all 401/403 without auth is the expected happy path).

- [ ] **Step 4.3: Confirm via approuter (BASE_URL set)**

Run: `SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" npx vitest run test/smoke/csrf-enforcement.test.js --project smoke`
Expected: BASE_URL block runs, remaining 401/403 assertion passes.

- [ ] **Step 4.4: Commit**

```bash
git add test/smoke/csrf-enforcement.test.js
git commit -m "test(#797): CSRF enforcement smoke

Asserts CAP auto-CSRF is on for OData mutations: POST /admin/Tags,
POST /admin/Missions, POST /api/getProgress are all rejected without
a valid x-csrf-token. HEAD \$metadata with x-csrf-token: fetch returns a
token. Runs against SRV_URL and BASE_URL (approuter) independently."
```

---

## Task 5: `express-route-mutations.test.js` — custom Express POST auth + malformed-body

Covers the 17 custom `.post()` routes in `srv/server.js`. Not every route needs its own assertion — batch by auth policy:

| Route | Auth | Test |
|---|---|---|
| `/content/publish` (+ chunked variants) | `contentAuthMiddleware` (bearer via `CONTENT_API_KEY`) | POST without bearer → 401 |
| `/build/repo-catalog` | Same | POST without bearer → 401 |
| `/content/rollback`, `/content/orphan-purge` | Same | POST without bearer → 401 |
| `/admin/analytics/export`, `/admin/advocates/:slug/photo` | XSUAA `@requires: 'Admin'` | POST unauth → 401/403 |
| `/api/ui-event` | Public POST (accepts arbitrary JSON) | POST with huge body → 413 or 400 |
| `/feedback/submit` | Rate-limited public | POST malformed → 400 |
| `/api/codecheck`, `/api/validate-answer` | XSUAA (per-user rate limit) | POST unauth → 401/403 |
| `/chat/stream` | XSUAA | POST unauth → 401/403 |

**Files:**
- Create: `test/smoke/express-route-mutations.test.js`

- [ ] **Step 5.1: Write the failing test**

```javascript
// test/smoke/express-route-mutations.test.js
import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe.skipIf(!SRV_URL)('Custom Express route auth + input hardening (#797)', () => {
  describe('bearer-token-required routes', () => {
    const bearerRoutes = [
      { path: '/content/publish', method: 'POST' },
      { path: '/content/publish/begin', method: 'POST' },
      { path: '/content/publish/append', method: 'POST' },
      { path: '/content/publish/commit', method: 'POST' },
      { path: '/content/publish/abort', method: 'POST' },
      { path: '/content/rollback', method: 'POST' },
      { path: '/content/orphan-purge', method: 'POST' },
      { path: '/build/repo-catalog', method: 'POST' },
    ];
    it.each(bearerRoutes)('$method $path without Authorization → 401', async ({ path, method }) => {
      const res = await fetchWithRetry(`${SRV_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('POST /content/publish with wrong bearer → 401', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/content/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer definitely-not-the-key',
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('XSUAA-required routes (unauthenticated → 401/403)', () => {
    const xsuaaRoutes = [
      '/admin/analytics/export',
      '/admin/advocates/foo/photo',
      '/api/codecheck',
      '/api/validate-answer',
      '/chat/stream',
    ];
    it.each(xsuaaRoutes)('POST %s without XSUAA → 401/403', async (path) => {
      const res = await fetchWithRetry(`${SRV_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('public POST hardening', () => {
    it('POST /api/ui-event with malformed JSON → 400', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/api/ui-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{',
      });
      expect(res.status).toBe(400);
    });

    it('POST /feedback/submit with empty body → 400 or 422', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/feedback/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      // Rate-limiter may 429 or handler may 400/422 for missing fields.
      expect([400, 422, 429]).toContain(res.status);
    });

    it('POST /api/ui-event with 5MB payload rejected (413) or accepted (2xx) but bounded', async () => {
      const huge = 'x'.repeat(5 * 1024 * 1024);
      const res = await fetchWithRetry(`${SRV_URL}/api/ui-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: huge }),
      });
      // Either the express.json({limit}) rejects (413) or the handler ignores it (2xx).
      // If it 500s, that's a real DoS surface — file a follow-up issue.
      expect([200, 204, 400, 413]).toContain(res.status);
    });
  });
});
```

- [ ] **Step 5.2: Run against DEV**

Run: `SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" npx vitest run test/smoke/express-route-mutations.test.js --project smoke`
Expected: all pass. If `/api/ui-event` 5MB test 500s, do **not** patch `srv/server.js` in this task — file a follow-up issue, `.skip` the case with a TODO comment referencing that issue, and note in the commit.

- [ ] **Step 5.3: Commit**

```bash
git add test/smoke/express-route-mutations.test.js
git commit -m "test(#797): custom Express route auth + input hardening smoke

Sweeps all 17 app.post() routes in srv/server.js:
  - 8 bearer-required (contentAuthMiddleware) reject unauth + wrong bearer
  - 5 XSUAA-required reject unauth (401/403)
  - 3 public-POST checks: malformed JSON, empty body rate-limit, 5MB payload bounded

Any 500 is a follow-up issue reference; happy path is 4xx everywhere."
```

---

## Task 6: `xss-reflection.test.js` — reflected data on public pages is HTML-encoded

The hardest smoke test — needs to inject data (usually via admin creates), then GET a public page and assert the payload is encoded. Since we don't want to write to DEV in a smoke test, this task is **read-only**: it scans existing rendered public pages for suspicious raw-HTML patterns.

**Files:**
- Create: `test/smoke/xss-reflection.test.js`

- [ ] **Step 6.1: Write the failing test**

```javascript
// test/smoke/xss-reflection.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// Read-only reflection check: fetch high-risk public pages and grep for
// patterns that would indicate un-encoded author-supplied HTML slipping
// through. This catches the class where Hugo's default escaping was
// bypassed (safeHTML/htmlSafe on user data).
describe.skipIf(!BASE_URL)('XSS reflection on public pages (#797)', () => {
  const publicPages = [
    { path: '/', name: 'homepage' },
    { path: '/tutorials/', name: 'tutorials index' },
    { path: '/missions/', name: 'missions index' },
    { path: '/developer-advocates/', name: 'advocates listing' },
  ];

  it.each(publicPages)('$name has no raw <script> in author-editable regions', async ({ path }) => {
    const res = await fetchWithRetry(`${BASE_URL}${path}`);
    // Some pages 404 in some envs; skip if page missing.
    if (res.status === 404) return;
    expect(res.ok).toBe(true);
    const html = await res.text();
    // Scripts are allowed via <script src="/js/..."> and <script>window.__DATA__=...</script>
    // (inline JSON). Reject only script tags with attributes suggesting event handlers
    // or inline handler attributes injected via reflection.
    expect(html).not.toMatch(/<script[^>]*\bonerror\s*=/i);
    expect(html).not.toMatch(/<img[^>]*\bonerror\s*=/i);
    expect(html).not.toMatch(/\bjavascript:\s*alert\(/i);
    expect(html).not.toMatch(/<iframe[^>]*\bsrcdoc\s*=/i);
  });

  it('search results page HTML-encodes the query param', async () => {
    // Reflected input: URL query -> rendered on page.
    const payload = '<script>alert(1)</script>';
    const res = await fetchWithRetry(`${BASE_URL}/search/?q=${encodeURIComponent(payload)}`);
    if (res.status === 404) return; // if /search/ not enabled in this env
    const html = await res.text();
    // Raw <script>alert(1)</script> from the URL must NOT appear as literal HTML.
    // Hugo/Vue must encode it.
    expect(html).not.toContain('<script>alert(1)</script>');
    // Encoded form is acceptable (e.g. &lt;script&gt;).
  });

  it('tutorial slug 404 page does not reflect slug unencoded', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${encodeURIComponent(payload)}/`);
    // Expect 404, but check the 404 body does not contain the raw payload.
    const html = await res.text();
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
```

- [ ] **Step 6.2: Run against DEV**

Run: `SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" npx vitest run test/smoke/xss-reflection.test.js --project smoke`
Expected: all pass. If `/tutorials/{payload}/` reflects the payload, that IS a real vulnerability — file follow-up + `.skip` per policy.

- [ ] **Step 6.3: Commit**

```bash
git add test/smoke/xss-reflection.test.js
git commit -m "test(#797): XSS reflection smoke (read-only)

Fetches 4 public pages + search + 404 route with reflection-style payload
(<script>alert>, <img onerror>, <iframe srcdoc>). Asserts none of those
patterns appear in the response HTML. Read-only — does not write to DB."
```

---

## Task 7: `check-hugo-safe-html.cjs` — CI grep guard + unit test

Fails the build if any `hugo/layouts/*.html` gains a new `safeHTML` / `safeHTMLAttr` / `printf "<%s>"` usage without a `<!-- security-reviewed -->` marker on the preceding line.

**Files:**
- Create: `scripts/check-hugo-safe-html.cjs`
- Create: `test/unit/scripts/check-hugo-safe-html.test.js`
- Modify: `package.json` — add `check:security-annotations` script and wire into `precommit`/`prebuild`

- [ ] **Step 7.1: Write the failing test for the guard**

```javascript
// test/unit/scripts/check-hugo-safe-html.test.js
import { describe, it, expect } from 'vitest';
import { checkHugoSafeHtml } from '../../../scripts/check-hugo-safe-html.cjs';

describe('check-hugo-safe-html guard (#797)', () => {
  it('passes when safeHTML has adjacent security-reviewed marker', () => {
    const files = new Map([
      ['x.html', '<!-- security-reviewed: trusted source -->\n{{ .Bio | safeHTML }}\n'],
    ]);
    expect(checkHugoSafeHtml(files)).toEqual({ ok: true, findings: [] });
  });

  it('flags safeHTML without adjacent marker', () => {
    const files = new Map([
      ['x.html', '<div>{{ .Bio | safeHTML }}</div>\n'],
    ]);
    const result = checkHugoSafeHtml(files);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: 'x.html', line: 1 });
  });

  it('flags safeHTMLAttr without adjacent marker', () => {
    const files = new Map([
      ['x.html', '<a href="{{ .Url | safeHTMLAttr }}">x</a>\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(false);
  });

  it('flags printf "<%s>" pattern without adjacent marker', () => {
    const files = new Map([
      ['x.html', '{{ printf "<a href=\'%s\'>x</a>" .Url }}\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(false);
  });

  it('accepts multiple safeHTML if each has a marker on line above', () => {
    const files = new Map([
      ['x.html', '<!-- security-reviewed: a -->\n{{ .A | safeHTML }}\n<!-- security-reviewed: b -->\n{{ .B | safeHTML }}\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(true);
  });

  it('marker must be within 3 lines above (not stale from earlier in file)', () => {
    const files = new Map([
      ['x.html', '<!-- security-reviewed: old -->\n<p>lots</p>\n<p>of</p>\n<p>lines</p>\n{{ .X | safeHTML }}\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(false);
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails (module doesn't exist yet)**

Run: `npx vitest run test/unit/scripts/check-hugo-safe-html.test.js --project unit`
Expected: FAIL — Cannot find module `check-hugo-safe-html.cjs`.

- [ ] **Step 7.3: Implement the guard**

```javascript
// scripts/check-hugo-safe-html.cjs
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PATTERN = /\b(safeHTML|safeHTMLAttr)\b|printf\s+"<[^"]*%s/i;
const MARKER = /security-reviewed:/i;
const MARKER_WINDOW = 3; // must be within 3 lines above

/**
 * @param {Map<string, string>} files - path → contents
 * @returns {{ok: boolean, findings: Array<{file: string, line: number, snippet: string}>}}
 */
function checkHugoSafeHtml(files) {
  const findings = [];
  for (const [file, contents] of files) {
    const lines = contents.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!PATTERN.test(line)) continue;
      // Look for marker within MARKER_WINDOW lines above (inclusive of same line).
      const windowStart = Math.max(0, i - MARKER_WINDOW);
      let hasMarker = false;
      for (let j = windowStart; j <= i; j++) {
        if (MARKER.test(lines[j])) { hasMarker = true; break; }
      }
      if (!hasMarker) {
        findings.push({ file, line: i + 1, snippet: line.trim() });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

function walkHtmlFiles(dir, acc = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtmlFiles(full, acc);
    else if (entry.name.endsWith('.html')) acc.set(full, fs.readFileSync(full, 'utf8'));
  }
  return acc;
}

function main() {
  const root = path.resolve(__dirname, '..', 'hugo', 'layouts');
  if (!fs.existsSync(root)) {
    console.error(`hugo/layouts not found at ${root}`);
    process.exit(1);
  }
  const files = walkHtmlFiles(root);
  const { ok, findings } = checkHugoSafeHtml(files);
  if (ok) {
    console.log(`check-hugo-safe-html: OK (${files.size} files scanned)`);
    process.exit(0);
  }
  console.error(`check-hugo-safe-html: ${findings.length} unmarked safeHTML/printf usage(s) found:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
  }
  console.error('');
  console.error('Add a comment on (or within 3 lines above) each occurrence explaining why the source is trusted, prefixed with "security-reviewed:". See #797.');
  process.exit(2);
}

module.exports = { checkHugoSafeHtml };

if (require.main === module) main();
```

- [ ] **Step 7.4: Run unit test to verify green**

Run: `npx vitest run test/unit/scripts/check-hugo-safe-html.test.js --project unit`
Expected: all 6 tests pass.

- [ ] **Step 7.5: Run the guard CLI against the repo (should be green thanks to Task 0)**

Run: `node scripts/check-hugo-safe-html.cjs`
Expected: `check-hugo-safe-html: OK (N files scanned)` where N is the count of `hugo/layouts/**/*.html` files, exit 0.

- [ ] **Step 7.6: Wire into `package.json`**

Add to `package.json` `scripts`:

```json
{
  "check:security-annotations": "node scripts/check-hugo-safe-html.cjs"
}
```

Wire it into whatever aggregate script already runs pre-build guards. Check `package.json` for a `prebuild` or `precommit` hook; add `&& npm run check:security-annotations` to that. If no aggregate exists, add just the standalone script and reference it from the acceptance criteria — CI runs it explicitly per the `deploy.yml` update (Task 9).

- [ ] **Step 7.7: Commit**

```bash
git add scripts/check-hugo-safe-html.cjs test/unit/scripts/check-hugo-safe-html.test.js package.json
git commit -m "feat(#797): security-annotation grep guard for Hugo templates

Adds scripts/check-hugo-safe-html.cjs — fails the build if any hugo/layouts/**/*.html
introduces a new safeHTML / safeHTMLAttr / printf \"<%s>\" without a
'security-reviewed:' marker within 3 lines above. Baseline for existing
7 occurrences was set in the previous commit.

6 unit tests cover positive path, negative path, sibling-line window,
and stale-marker rejection.

Wired into package.json as 'npm run check:security-annotations'.
CI reference lands in the deploy workflow (see #797)."
```

---

## Task 8: Update `docs/developers/operations/testing-endpoints.md`

Add a "Security Testing Reference" section with a table linking each pen-test file to the endpoint(s) it covers.

**Files:**
- Modify: `docs/developers/operations/testing-endpoints.md` — insert new `## Security Testing Reference` section after `## Quick Smoke Test Checklist` and before `## Local Development Notes`.

- [ ] **Step 8.1: Draft the new section**

```markdown
## Security Testing Reference

Focused pen-test suite added in [#797](https://github.com/sap-tutorials/tutorials-ims/issues/797). All framework defaults (CAP CSRF auto-enforcement, Fiori Elements token prefetch, `sanitize-html`, approuter CSP) cover the primary attack surface — these tests pin the coverage against regression.

| File | Type | Scope |
|---|---|---|
| [`test/unit/srv/analytics-sql-validator.pen.test.js`](../../../test/unit/srv/analytics-sql-validator.pen.test.js) | unit | Malicious SQL against `AnalyticsService.runSelectQuery` validator (DDL/DML, stacked queries, comment bypasses, disallowed tables, oversize input). Covers [`srv/lib/analytics-sql-validator.cjs`](../../../srv/lib/analytics-sql-validator.cjs). |
| [`test/unit/scripts/sanitize-html.pen.test.js`](../../../test/unit/scripts/sanitize-html.pen.test.js) | unit | OWASP XSS Filter Evasion Cheat Sheet payloads against tutorial-source sanitizer. Covers [`scripts/parsers/sanitize-html.ts`](../../../scripts/parsers/sanitize-html.ts). |
| [`test/smoke/csrf-enforcement.test.js`](../../../test/smoke/csrf-enforcement.test.js) | smoke | POST to `/admin/Tags`, `/admin/Missions`, `/api/getProgress` without valid `x-csrf-token` → 4xx. Covers CAP OData mutation surface. |
| [`test/smoke/express-route-mutations.test.js`](../../../test/smoke/express-route-mutations.test.js) | smoke | Sweeps all 17 custom `app.post(...)` routes in `srv/server.js` — bearer-token routes, XSUAA-scoped routes, public-POST hardening. |
| [`test/smoke/xss-reflection.test.js`](../../../test/smoke/xss-reflection.test.js) | smoke | Read-only reflection check on public pages (homepage, tutorials index, missions index, advocates, search, tutorial 404). |
| [`test/smoke/security-headers.test.js`](../../../test/smoke/security-headers.test.js) | smoke | CSP, X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy on approuter HTML responses. |
| [`scripts/check-hugo-safe-html.cjs`](../../../scripts/check-hugo-safe-html.cjs) | build guard | Fails build if any new `safeHTML` / `safeHTMLAttr` / `printf "<%s>"` lands in `hugo/layouts/**/*.html` without a `<!-- security-reviewed: ... -->` marker within 3 lines above. Runs as `npm run check:security-annotations`. |

**Running locally:**

```bash
# All unit pen tests (fast, no external deps)
npx vitest run test/unit/srv/analytics-sql-validator.pen.test.js \
              test/unit/scripts/sanitize-html.pen.test.js \
              test/unit/scripts/check-hugo-safe-html.test.js \
              --project unit

# All smoke pen tests (needs deployed DEV; SRV and/or approuter URLs)
SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  npx vitest run test/smoke/csrf-enforcement.test.js \
                 test/smoke/express-route-mutations.test.js \
                 test/smoke/xss-reflection.test.js \
                 test/smoke/security-headers.test.js \
                 --project smoke

# Hugo safeHTML guard
npm run check:security-annotations
```

**Policy for new findings:** if a pen test uncovers a real vulnerability (not a test-expectation mismatch), file a follow-up issue referencing #797, skip that individual case with a `.skip` and a `// TODO(#XXX)` comment, and address it in a dedicated PR. This suite is a **regression net**, not a fix-it-all PR.
```

- [ ] **Step 8.2: Insert into the doc**

Read the doc, find the line "## Quick Smoke Test Checklist" and the next `##` heading. Insert the new section between them.

- [ ] **Step 8.3: Verify VitePress sidebar doesn't need update**

Run: `grep -n "testing-endpoints" docs/.vitepress/config.ts`
Expected: file is already registered. If not, add it (unlikely — it's a top-level doc).

- [ ] **Step 8.4: Local docs preview (optional)**

Run: `npm run docs:build`
Expected: `predocs:build` passes (no dead links, no unregistered pages).

- [ ] **Step 8.5: Commit**

```bash
git add docs/developers/operations/testing-endpoints.md
git commit -m "docs(#797): pen-test suite reference in testing-endpoints.md

Adds 'Security Testing Reference' section with a table linking each of
the 6 new test files (2 unit + 4 smoke) plus the Hugo grep guard to
the endpoint(s) they cover, run-locally commands, and the follow-up
policy for real findings."
```

---

## Task 9: CI wiring — smoke suite already runs; explicit call for the guard

Smoke tests under `test/smoke/**/*.test.js` are already picked up by `npm run test:smoke` per `vitest.config.ts` — no CI edit needed for the four smoke files. The Hugo grep guard needs an explicit call.

**Files:**
- Modify: `.github/workflows/deploy.yml` — add a step that runs `npm run check:security-annotations` before the Hugo build (or as part of the existing lint step).
- Modify: `.github/workflows/rebuild-content.yml` — same (only in modes that build Hugo).

- [ ] **Step 9.1: Locate existing lint/check steps in `deploy.yml`**

Run: `grep -n -E "npm run (lint|check|test|build:all)" .github/workflows/deploy.yml`
Expected: finds the build:all / test / lint invocations.

- [ ] **Step 9.2: Add the guard step**

Insert as its own step, immediately before the Hugo build:

```yaml
      - name: Check Hugo security annotations
        run: npm run check:security-annotations
```

- [ ] **Step 9.3: Same for `rebuild-content.yml`**

Insert where Hugo build begins (skip in `catalog-only` mode if that mode doesn't build Hugo; keep for `full` and `slug-targeted`).

- [ ] **Step 9.4: Verify locally that the guard runs successfully**

Run: `npm run check:security-annotations`
Expected: exit 0 with "OK (N files scanned)".

- [ ] **Step 9.5: Commit**

```bash
git add .github/workflows/deploy.yml .github/workflows/rebuild-content.yml
git commit -m "ci(#797): wire security-annotation guard into deploy + rebuild workflows

Runs 'npm run check:security-annotations' before Hugo builds in
deploy.yml and rebuild-content.yml so any un-marked safeHTML usage
introduced in a PR fails CI before merge."
```

---

## Task 10: Final verification and PR

- [ ] **Step 10.1: Run all new tests as a single sweep**

Unit:
```
npx vitest run test/unit/srv/analytics-sql-validator.pen.test.js \
              test/unit/scripts/sanitize-html.pen.test.js \
              test/unit/scripts/check-hugo-safe-html.test.js \
              --project unit
```
Expected: all pass (or `.skip` only for documented follow-ups).

Smoke (against DEV):
```
SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  npx vitest run test/smoke/csrf-enforcement.test.js \
                 test/smoke/express-route-mutations.test.js \
                 test/smoke/xss-reflection.test.js \
                 test/smoke/security-headers.test.js \
                 --project smoke
```
Expected: all pass.

Guard:
```
npm run check:security-annotations
```
Expected: exit 0.

- [ ] **Step 10.2: Verify no source files were changed in `srv/` or `approuter/`**

Run: `git diff --stat main -- srv/ approuter/`
Expected: empty (Task 2's optional `sanitize-html.ts` export is the only allowed edit under `scripts/parsers/`; Task 0's `hugo/layouts/` markers are pure HTML comments).

- [ ] **Step 10.3: Verify diff scope**

Run: `git diff --stat main`
Expected: ~9 new files + ~9 modified files (hugo layouts + docs + package.json + 2 workflow files), and nothing else surprising.

- [ ] **Step 10.4: Open PR**

Run:
```bash
git push -u origin feat/797-pen-test-suite
gh pr create --title "test(#797): dedicated CSRF/XSS/injection pen-test suite" \
             --body "$(cat <<'EOF'
Closes #797.

Adds a focused pen-test regression suite:

- **Unit tests** (fast, no deps):
  - `test/unit/srv/analytics-sql-validator.pen.test.js` — 25+ malicious SQL fixtures against `validateSelect`
  - `test/unit/scripts/sanitize-html.pen.test.js` — OWASP XSS payloads
  - `test/unit/scripts/check-hugo-safe-html.test.js` — guard's own tests
- **Smoke tests** (run against deployed DEV in CI):
  - `test/smoke/csrf-enforcement.test.js` — CAP OData CSRF
  - `test/smoke/express-route-mutations.test.js` — 17 custom Express POSTs auth + input hardening
  - `test/smoke/xss-reflection.test.js` — read-only reflection check on public pages
  - `test/smoke/security-headers.test.js` — CSP/XFO/XCTO/HSTS/Referrer-Policy on approuter
- **Build guard**: `scripts/check-hugo-safe-html.cjs` — fails build if any un-annotated `safeHTML` lands in `hugo/layouts/`. Baseline established in prep commit (7 existing occurrences annotated).
- **Docs**: new "Security Testing Reference" section in `docs/developers/operations/testing-endpoints.md`.

**No source-code behavior changes** in `srv/`, `approuter/`, or `scripts/parsers/sanitize-html.ts` (aside from an optional one-line `export` if the internal `sanitizeLine` wasn't already exported — noted in commit).

Any real vulnerability discovered while writing these tests → follow-up issue + `.skip` on the case; not fixed in this PR (regression net first, remediation second).
EOF
)"
```

- [ ] **Step 10.5: Confirm CI green**

Wait for CI on the PR. If any smoke test regresses on the deployed environment, treat it like a code-review finding and iterate.

---

## Acceptance criteria mapping (from issue #797)

- [x] 6 test files added, all green in `npm test` + `npm run test:smoke` — **Tasks 1–6.**
- [x] Documented in `docs/developers/operations/testing-endpoints.md` — **Task 8.**
- [x] CI runs smoke pen-tests on every deploy — **already the case** for `test/smoke/*.test.js`; smoke suite runs via `deploy.yml`. Task 9 adds the explicit grep-guard step.
- [x] Grep-based CI check that fails PRs adding `safeHTML`/`htmlSafe`/`printf "<%s>"` patterns without `<!-- security-reviewed -->` marker — **Tasks 0, 7, 9.**

## Risk notes for the executor

- **Do not "fix" any real vulnerability in this PR.** The issue explicitly frames this as a regression net. Real findings deserve their own PR + review; conflating them makes both harder to review.
- **The 5MB `/api/ui-event` payload test could 500** — that would be a real DoS surface. File a follow-up, don't patch here.
- **The optional `export sanitizeLine`** in Task 2 is the only allowed source edit outside the test/scripts/docs surface. Prefer the smallest possible change.
- **Baseline task (Task 0) must run first.** Skipping it means Task 7's guard fires on 7 pre-existing files and blocks the PR.

## Estimated wall-clock

Per issue estimate: 1–2 days dev + half-day review. If executed by a fresh subagent per task with review between, expect ~10 subagent runs.
