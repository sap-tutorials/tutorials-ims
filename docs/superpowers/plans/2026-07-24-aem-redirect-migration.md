# AEM Redirect Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the valid redirects from the AEM `RewriteRule` export and seed them into the production `LegacyRedirects` table, adding allowlisted external-redirect support (SAP Community et al.) without weakening the #891 open-redirect guard.

**Architecture:** A new shared `redirect-allowlist.js` module exposes `isAllowedTarget(toPath)` — same-origin `/path` OR `https:` URL on a curated SAP host allowlist. The three enforcement gates (both resolver copies + the save-time validator) switch from `isSameOriginPath` to `isAllowedTarget`. The 30 extracted rules are appended to the seed CSV. `Location` emission already handles absolute URLs, so no approuter server change is needed.

**Tech Stack:** SAP CAP (Node.js), CDS entities, HANA CSV seed data, ESM resolver modules, Vitest, MTA build (`mta.yaml` before-all cp).

## Global Constraints

- **Open-redirect guard is preserved, never removed.** Only `https:` targets on the allowlist may be external; `http:`, `javascript:`, `data:`, `mailto:`, and protocol-relative `//host` targets stay rejected. (Spec §Security)
- **Allowlist hosts (exact):** `community.sap.com`, `pages.community.sap.com`, `opensource.sap.com`, `www.sap.com`, `help.sap.com`. (Spec §Rule Inventory)
- **Resolver copies must stay byte-identical.** `srv/lib/legacy-redirects-resolver.js` is the source of truth; `approuter/lib/legacy-redirects-resolver.js` is a build-time copy. The same applies to the new allowlist module. After editing the srv copy, re-run the `cp` (mta.yaml:107 + new line). (Spec §New module)
- **Seed UUIDs are deterministic**, continuing the existing `66333900-1eaa-0001-0001-0000000000NN` scheme. `statusCode=301`, `isActive=true`. (Spec §Seed data)
- **No CDS schema change** — reuse `fromPath / toPath / statusCode / isPattern / isActive`.
- Never write raw SQL in CAP handlers — use `cds.ql`/CQL (global rule).
- Run from the worktree: `D:\projects\tutorials-poc\.claude\worktrees\752-aem-redirect-migration`. Unit tests: `npx vitest run --project unit`.

## File Structure

- **Create** `srv/lib/redirect-allowlist.js` — single source of truth for `ALLOWED_HOSTS` + `isAllowedTarget()`. Imports `isSameOriginPath` from the resolver (or re-implements the same-origin check — see Task 1 decision).
- **Create (build copy)** `approuter/lib/redirect-allowlist.js` — copied from srv at build; committed too so local dev + tests work without a build.
- **Modify** `srv/lib/legacy-redirects-resolver.js` — `buildIndex()` and `resolveRedirect()` call `isAllowedTarget`.
- **Modify** `approuter/lib/legacy-redirects-resolver.js` — identical mirror.
- **Modify** `srv/admin-service.js:543` — save-time validator uses `isAllowedTarget`.
- **Modify** `db/data/com.sap.developers.ims-LegacyRedirects.csv` — append 30 rows.
- **Modify** `mta.yaml:107` area — add cp for the new allowlist module.
- **Modify** `test/unit/legacy-redirects-resolver.test.js` — allowlist cases.
- **Modify** `test/unit/admin-homepage-crud.test.js:22` — row-count assertion (3 → 33).
- **Modify** `test/smoke/redirects.test.js` — add same-origin + external smoke cases (optional, gated on deploy).

---

### Task 1: `redirect-allowlist.js` module + unit tests

**Files:**
- Create: `srv/lib/redirect-allowlist.js`
- Create: `approuter/lib/redirect-allowlist.js` (identical copy)
- Test: `test/unit/redirect-allowlist.test.js`

**Interfaces:**
- Consumes: `isSameOriginPath` from `./legacy-redirects-resolver.js` (already exported).
- Produces:
  - `export const ALLOWED_HOSTS: Set<string>`
  - `export function isAllowedTarget(toPath: string): boolean` — true iff `isSameOriginPath(toPath)` OR (`new URL(toPath).protocol === 'https:'` AND host ∈ `ALLOWED_HOSTS`). Returns false on parse error or any non-https scheme.

- [ ] **Step 1: Write the failing test**

Create `test/unit/redirect-allowlist.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { isAllowedTarget, ALLOWED_HOSTS } from '../../srv/lib/redirect-allowlist.js';

describe('isAllowedTarget — same-origin (preserves #891 behavior)', () => {
  it('accepts same-origin absolute paths', () => {
    expect(isAllowedTarget('/foo')).toBe(true);
    expect(isAllowedTarget('/foo/bar?q=1')).toBe(true);
    expect(isAllowedTarget('/')).toBe(true);
  });
  it('rejects protocol-relative and bare paths', () => {
    expect(isAllowedTarget('//community.sap.com')).toBe(false);
    expect(isAllowedTarget('foo')).toBe(false);
    expect(isAllowedTarget('')).toBe(false);
  });
});

describe('isAllowedTarget — allowlisted external hosts', () => {
  it('accepts https on an allowlisted host', () => {
    expect(isAllowedTarget('https://community.sap.com/topics/leonardo')).toBe(true);
    expect(isAllowedTarget('https://opensource.sap.com/')).toBe(true);
    expect(isAllowedTarget('https://www.sap.com/products/try-sap/trials-downloads.html')).toBe(true);
    expect(isAllowedTarget('https://help.sap.com/doc/abc/Cloud/en-US/index.html')).toBe(true);
    expect(isAllowedTarget('https://pages.community.sap.com/topics/business-technology-platform')).toBe(true);
  });
  it('rejects non-allowlisted hosts', () => {
    expect(isAllowedTarget('https://attacker.example/x')).toBe(false);
    expect(isAllowedTarget('https://sap.com.attacker.example/x')).toBe(false);
  });
  it('rejects non-https schemes even on allowlisted hosts', () => {
    expect(isAllowedTarget('http://community.sap.com/x')).toBe(false);
    expect(isAllowedTarget('javascript:alert(1)')).toBe(false);
    expect(isAllowedTarget('data:text/html,x')).toBe(false);
  });
  it('exposes the exact five allowlisted hosts', () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual([
      'community.sap.com', 'help.sap.com', 'opensource.sap.com',
      'pages.community.sap.com', 'www.sap.com',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/redirect-allowlist.test.js`
Expected: FAIL — cannot resolve `../../srv/lib/redirect-allowlist.js`.

- [ ] **Step 3: Write the module**

Create `srv/lib/redirect-allowlist.js`:

```javascript
/**
 * Trusted-host allowlist for redirect targets (#752).
 *
 * Extends the #891 open-redirect guard: a redirect target is allowed if it is
 * a same-origin absolute path (existing behavior) OR an https:// URL whose host
 * is on the curated SAP allowlist below. Everything else (http:, javascript:,
 * data:, protocol-relative //host, arbitrary external hosts) stays rejected.
 *
 * Adding a destination is a deliberate, PR-reviewed edit to ALLOWED_HOSTS —
 * admins cannot introduce external targets through the admin UI.
 *
 * MIRROR: copied to approuter/lib/ at MTA build time (mta.yaml before-all).
 * Source of truth is this srv/lib copy. Keep both in sync.
 *
 * @module redirect-allowlist
 */
import { isSameOriginPath } from './legacy-redirects-resolver.js';

export const ALLOWED_HOSTS = new Set([
  'community.sap.com',
  'pages.community.sap.com',
  'opensource.sap.com',
  'www.sap.com',
  'help.sap.com',
]);

/**
 * @param {string} toPath
 * @returns {boolean}
 */
export function isAllowedTarget(toPath) {
  if (isSameOriginPath(toPath)) return true;
  let u;
  try {
    u = new URL(toPath);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.has(u.host);
}
```

- [ ] **Step 4: Create the approuter copy**

Run: `cp srv/lib/redirect-allowlist.js approuter/lib/redirect-allowlist.js`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/redirect-allowlist.test.js`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/redirect-allowlist.js approuter/lib/redirect-allowlist.js test/unit/redirect-allowlist.test.js
git commit -m "feat(#752): redirect-allowlist module (same-origin OR allowlisted SAP host)"
```

---

### Task 2: Wire the allowlist into both resolver copies

**Files:**
- Modify: `srv/lib/legacy-redirects-resolver.js:33` and `:134`
- Modify: `approuter/lib/legacy-redirects-resolver.js` (identical)
- Test: `test/unit/legacy-redirects-resolver.test.js`

**Interfaces:**
- Consumes: `isAllowedTarget` from `./redirect-allowlist.js` (Task 1).
- Produces: no signature change — `buildIndex`/`resolveRedirect` keep their existing signatures; only the internal validation predicate changes.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/legacy-redirects-resolver.test.js`:

```javascript
describe('#752 — allowlisted external targets', () => {
  it('buildIndex keeps an allowlisted external row and drops a non-allowlisted one', () => {
    const idx = buildIndex([
      { id: 'ext-ok',  fromPath: '/leonardo-iot', toPath: 'https://community.sap.com/topics/leonardo', statusCode: 301, isPattern: false, isActive: true },
      { id: 'ext-bad', fromPath: '/evil',         toPath: 'https://attacker.example/x',                statusCode: 301, isPattern: false, isActive: true },
    ]);
    expect(resolveRedirect(idx, '/leonardo-iot')).toEqual({
      id: 'ext-ok', toPath: 'https://community.sap.com/topics/leonardo', statusCode: 301,
    });
    expect(resolveRedirect(idx, '/evil')).toBeNull();
  });

  it('pattern substitution cannot smuggle a non-allowlisted external host', () => {
    // toPath is allowlisted at build time, but $1 could push it off-allowlist.
    const idx = buildIndex([
      { id: 'p', fromPath: '^/x/(.*)$', toPath: 'https://community.sap.com/$1', statusCode: 301, isPattern: true, isActive: true },
    ]);
    // benign capture stays on-allowlist
    expect(resolveRedirect(idx, '/x/topics/leonardo')?.toPath).toBe('https://community.sap.com/topics/leonardo');
    // a capture that would form a different host is re-validated and rejected
    const idx2 = buildIndex([
      { id: 'p2', fromPath: '^/y/(.*)$', toPath: 'https://community.sap.com.$1', statusCode: 301, isPattern: true, isActive: true },
    ]);
    expect(resolveRedirect(idx2, '/y/attacker.example/x')).toBeNull();
  });
});
```

> Note: the existing `#891 — same-origin toPath validation` describe block for
> `isSameOriginPath` stays unchanged — that predicate is still exported and still
> the fast path. Do not delete those cases.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit test/unit/legacy-redirects-resolver.test.js`
Expected: FAIL — `ext-ok` row is dropped (current `isSameOriginPath` rejects the https target), so `resolveRedirect(idx, '/leonardo-iot')` returns `null` instead of the expected object.

- [ ] **Step 3: Edit `srv/lib/legacy-redirects-resolver.js`**

Add the import after the file's opening (top of module, alongside existing code):

```javascript
import { isAllowedTarget } from './redirect-allowlist.js';
```

At line ~33 inside `buildIndex()`, change:

```javascript
    if (!isSameOriginPath(row.toPath)) {
```
to:
```javascript
    if (!isAllowedTarget(row.toPath)) {
```

At line ~134 inside `resolveRedirect()`, change:

```javascript
      if (!isSameOriginPath(resolved)) continue;
```
to:
```javascript
      if (!isAllowedTarget(resolved)) continue;
```

Leave the `isSameOriginPath` function definition and its export in place (the allowlist module and the #891 tests both import it).

- [ ] **Step 4: Sync the approuter copy**

Run: `cp srv/lib/legacy-redirects-resolver.js approuter/lib/legacy-redirects-resolver.js`
Then verify: `diff -q srv/lib/legacy-redirects-resolver.js approuter/lib/legacy-redirects-resolver.js` → no output.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project unit test/unit/legacy-redirects-resolver.test.js`
Expected: PASS — new #752 cases green, all existing #891 cases still green.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/legacy-redirects-resolver.js approuter/lib/legacy-redirects-resolver.js test/unit/legacy-redirects-resolver.test.js
git commit -m "feat(#752): resolver honors host allowlist for external redirect targets"
```

---

### Task 3: Save-time validator uses the allowlist

**Files:**
- Modify: `srv/admin-service.js:543-559`
- Test: `test/unit/admin-legacy-redirects-validation.test.js` (create)

**Interfaces:**
- Consumes: `isAllowedTarget` from `./lib/redirect-allowlist.js`.
- Produces: the `before(['CREATE','UPDATE','NEW','PATCH'], 'LegacyRedirects')` hook now accepts allowlisted external `toPath` and rejects everything else with a single message.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admin-legacy-redirects-validation.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

describe('LegacyRedirects save-time validation (#752)', () => {
  let admin;
  beforeAll(async () => { admin = await cds.connect.to('AdminService'); });

  it('accepts a same-origin toPath', async () => {
    const row = await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.create('LegacyRedirects').entries({ fromPath: '/same-origin-ok', toPath: '/tutorials/', statusCode: 301, isPattern: false, isActive: true }));
    expect(row.toPath).toBe('/tutorials/');
  });

  it('accepts an allowlisted external toPath', async () => {
    const row = await admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.create('LegacyRedirects').entries({ fromPath: '/ext-ok', toPath: 'https://community.sap.com/topics/leonardo', statusCode: 301, isPattern: false, isActive: true }));
    expect(row.toPath).toBe('https://community.sap.com/topics/leonardo');
  });

  it('rejects a non-allowlisted external toPath', async () => {
    await expect(admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.create('LegacyRedirects').entries({ fromPath: '/ext-bad', toPath: 'https://attacker.example/x', statusCode: 301, isPattern: false, isActive: true })
    )).rejects.toThrow(/allowlisted SAP host|same-origin/i);
  });

  it('rejects an http (non-https) external toPath', async () => {
    await expect(admin.tx({ user: ADMIN_USER }, (tx) =>
      tx.create('LegacyRedirects').entries({ fromPath: '/ext-http', toPath: 'http://community.sap.com/x', statusCode: 301, isPattern: false, isActive: true })
    )).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/admin-legacy-redirects-validation.test.js`
Expected: FAIL — the "allowlisted external" case rejects (current validator blocks any scheme).

- [ ] **Step 3: Edit `srv/admin-service.js`**

Ensure the import exists near the top of the file (with the other `./lib/...` imports):

```javascript
const { isAllowedTarget } = require('./lib/redirect-allowlist.js');
```

> If `admin-service.js` is CommonJS and `redirect-allowlist.js` is ESM, use a
> dynamic import inside the handler instead:
> `const { isAllowedTarget } = await import('./lib/redirect-allowlist.js');`
> Check the top of `admin-service.js` for `require` vs `import` and match it.

Replace the validator body (lines ~544-558) with:

```javascript
      const toPath = req.data?.toPath;
      if (toPath === undefined) return; // PATCH that doesn't touch toPath — fine
      if (typeof toPath !== 'string' || toPath.length === 0) {
        return req.reject(400, 'toPath is required and must be a non-empty string');
      }
      if (!isAllowedTarget(toPath)) {
        return req.reject(400, 'toPath must be a same-origin path (/…) or an https URL on an allowlisted SAP host (community.sap.com, pages.community.sap.com, opensource.sap.com, www.sap.com, help.sap.com)');
      }
```

Update the leading comment block (lines 538-542) to note external allowlisting is now permitted.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/admin-legacy-redirects-validation.test.js`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js test/unit/admin-legacy-redirects-validation.test.js
git commit -m "feat(#752): save-time validator accepts allowlisted external redirect targets"
```

---

### Task 4: Seed the 30 extracted rules

**Files:**
- Modify: `db/data/com.sap.developers.ims-LegacyRedirects.csv`
- Modify: `test/unit/admin-homepage-crud.test.js:22` (row-count assertion)

**Interfaces:**
- Consumes: nothing (data only).
- Produces: 33 total seed rows (3 existing + 30 new). Later tests/smoke rely on the specific rows in the spec's Rule Inventory tables.

- [ ] **Step 1: Update the row-count assertion first (failing test)**

In `test/unit/admin-homepage-crud.test.js`, change the `exposes LegacyRedirects` assertion:

```javascript
    expect(list.length).toBe(33);  // 3 named seed rows + 30 migrated from AEM (#752)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/admin-homepage-crud.test.js`
Expected: FAIL — `expected 3 to be 33` (CSV not yet extended).

- [ ] **Step 3: Append the 30 rows to the CSV**

Append to `db/data/com.sap.developers.ims-LegacyRedirects.csv` (header + 3 existing rows stay; do not renumber `...001`–`...003`). Use IDs `66333900-1eaa-0001-0001-000000000004` … `...033`. Transcribe `fromPath` verbatim from `D:\tmp\redirects\exportRedirectRules-dev-folder.txt` per the spec's two Rule Inventory tables. **External rows (11):**

```
66333900-1eaa-0001-0001-000000000004;/leonardo-iot;https://community.sap.com/topics/leonardo;301;false;true
66333900-1eaa-0001-0001-000000000005;/topics/leonardo-iot\.html;https://community.sap.com/topics/leonardo;301;false;true
66333900-1eaa-0001-0001-000000000006;/open-source;https://opensource.sap.com/;301;false;true
66333900-1eaa-0001-0001-000000000007;^/open-source..html$;https://www.sap.com/about/company/innovation/open-source.html;301;true;true
66333900-1eaa-0001-0001-000000000008;^/devtoberfest..html$;https://community.sap.com/t5/devtoberfest/gh-p/Devtoberfest;301;true;true
66333900-1eaa-0001-0001-000000000009;/topics/s4hana-cloud-sdk.html;https://community.sap.com/topics/cloud-sdk;301;false;true
66333900-1eaa-0001-0001-000000000010;^/(africa|australia|austria|belgie|belgique|brazil|bulgaria|canada|canada-fr|china|central-asia-caucasus|croatia|cz|denmark|estonia|finland|france|germany|greece|hk|hungary|india|israel|italy|japan|korea|latinamerica|latvia|lithuania|mena|mena-ar|netherlands|norway|poland|portugal|romania|sea|sk|slovenia|spain|sweden|suisse|swiss|taiwan|turkey|uk|ukraine|westbalkans)/topics/s4hana-cloud-sdk.html$;https://community.sap.com/topics/cloud-sdk;301;true;true
66333900-1eaa-0001-0001-000000000011;^/(africa|australia|austria|belgie|belgique|brazil|bulgaria|canada|canada-fr|china|central-asia-caucasus|croatia|cz|denmark|estonia|finland|france|germany|greece|hk|hungary|india|israel|italy|japan|korea|latinamerica|latvia|lithuania|mena|mena-ar|netherlands|norway|poland|portugal|romania|sea|sk|slovenia|spain|sweden|suisse|swiss|taiwan|turkey|uk|ukraine|westbalkans)/topics/s4hana-cloud-sdk\.(.*).html$;https://community.sap.com/topics/cloud-sdk#$2;301;true;true
66333900-1eaa-0001-0001-000000000012;/trials-downloads.html;https://www.sap.com/products/try-sap/trials-downloads.html;301;false;true
66333900-1eaa-0001-0001-000000000013;/topics/cloud-platform\.html;https://pages.community.sap.com/topics/business-technology-platform;301;false;true
66333900-1eaa-0001-0001-000000000014;/mobile;https://help.sap.com/doc/f53c64b93e5140918d676b927a3cd65b/Cloud/en-US/docs-en/index.html;301;false;true
```

**Same-origin rows (19):**

```
66333900-1eaa-0001-0001-000000000015;^/(de|es|zh)$;/;301;true;true
66333900-1eaa-0001-0001-000000000016;^/(de|es|zh)/(.*)$;/$2;301;true;true
66333900-1eaa-0001-0001-000000000017;^/cloud-sdk$;/topics/cloud-sdk.html;301;false;true
66333900-1eaa-0001-0001-000000000018;^/abap$;/topics/abap-platform.html;301;false;true
66333900-1eaa-0001-0001-000000000019;^/abapxml$;/topics/abap-platform.html;301;false;true
66333900-1eaa-0001-0001-000000000020;^/datahub$;/group.datahub-docker.html;301;false;true
66333900-1eaa-0001-0001-000000000021;^/tutorials/ml-fs-sapui5-series-changepoint-detection.html$;/group.ml-fs-api-hub.html;301;false;true
66333900-1eaa-0001-0001-000000000022;^/tutorials/ml-fs-java-series-changepoint-detection.html$;/group.ml-fs-api-hub.html;301;false;true
66333900-1eaa-0001-0001-000000000023;^/group.ml-fs-java.html$;/group.ml-fs-api-hub.html;301;false;true
66333900-1eaa-0001-0001-000000000024;^/group.ml-fs-sapui5.html$;/group.ml-fs-api-hub.html;301;false;true
66333900-1eaa-0001-0001-000000000025;^/ml$;/topics/machine-learning.html;301;false;true
66333900-1eaa-0001-0001-000000000026;^/api$;/topics/api.html;301;false;true
66333900-1eaa-0001-0001-000000000027;^/cloud$;/topics/cloud-platform.html;301;false;true
66333900-1eaa-0001-0001-000000000028;^/hanaexpress$;/products/hana/express-trial.html;301;false;true
66333900-1eaa-0001-0001-000000000029;^/hana-express$;/products/hana/express-trial.html;301;false;true
66333900-1eaa-0001-0001-000000000030;^/hana$;/topics/hana.html;301;false;true
66333900-1eaa-0001-0001-000000000031;^/sapui5$;/topics/ui5.html;301;false;true
66333900-1eaa-0001-0001-000000000032;^/ios-sdk$;/topics/cloud-platform-sdk-for-ios.html;301;false;true
66333900-1eaa-0001-0001-000000000033;^/webide$;/topics/sap-webide.html;301;false;true
```

> **Escaping caution:** exact-match rows with `\.` (e.g. row 5, 13) are stored
> `isPattern:false` — the resolver's exact map matches the literal string
> including the backslash. Verify against the source file: if AEM used
> `^/topics/leonardo-iot\.html$` as a *literal* vanity, store the plain path
> `/topics/leonardo-iot.html` with `isPattern:false` (no backslash) so the
> exact-map key matches inbound `/topics/leonardo-iot.html`. **Decision rule:**
> a row is `isPattern:false` only if its `fromPath` is a plain path with no
> regex metacharacters; strip AEM's `^…$` anchors and `\` escapes for those.
> Rows with alternation/`(.*)`/`$n` stay `isPattern:true` with the regex intact.
> Re-derive each row's final form with this rule before writing — do not blindly
> paste anchors into `isPattern:false` rows.

- [ ] **Step 4: Run the CRUD + resolver tests**

Run: `npx vitest run --project unit test/unit/admin-homepage-crud.test.js test/unit/legacy-redirects-resolver.test.js`
Expected: PASS — row count 33, no resolver row silently dropped (all 11 external targets are allowlisted; if any drops, the host isn't on the list — fix the CSV, not the allowlist).

- [ ] **Step 5: Sanity-check no row is dropped by the guard**

Run this one-off assertion (paste into a scratch test or `node` REPL against the resolver):

```javascript
import { buildIndex } from './srv/lib/legacy-redirects-resolver.js';
import { parse } from 'csv-parse/sync'; // or split manually on ';'
// load CSV rows → objects, buildIndex, assert exactMap.size + patterns.length === 30
```

Expected: 30 active migrated rows survive `buildIndex` (3 seed already counted separately). If fewer, a `toPath` host is off-allowlist or a `fromPath` regex is invalid — fix the offending row.

- [ ] **Step 6: Commit**

```bash
git add db/data/com.sap.developers.ims-LegacyRedirects.csv test/unit/admin-homepage-crud.test.js
git commit -m "feat(#752): seed 30 migrated AEM redirects (11 external, 19 same-origin)"
```

---

### Task 5: MTA build copy + smoke coverage

**Files:**
- Modify: `mta.yaml` (~line 107, before-all `cp` steps)
- Modify: `test/smoke/redirects.test.js`

**Interfaces:**
- Consumes: the deployed `LegacyRedirects` rows + the resolver/allowlist in the approuter.
- Produces: build parity (approuter has `redirect-allowlist.js`) and deploy-time smoke assertions.

- [ ] **Step 1: Add the cp step to `mta.yaml`**

After the existing line (`- cp srv/lib/legacy-redirects-resolver.js approuter/lib/legacy-redirects-resolver.js`), add:

```yaml
        - cp srv/lib/redirect-allowlist.js approuter/lib/redirect-allowlist.js
```

Match the surrounding indentation exactly (it's a list item under `before-all` custom builder commands).

- [ ] **Step 2: Verify YAML is valid**

Run: `yq '.build-parameters.before-all[0].commands[] | select(. == "*redirect-allowlist*")' mta.yaml`
Expected: prints the new cp line (confirms it parsed under the right key). If the path differs, run `yq '.. | select(tag == "!!str" and test("legacy-redirects-resolver"))' mta.yaml` to find the exact location and mirror it.

- [ ] **Step 3: Add smoke assertions**

Append to `test/smoke/redirects.test.js` (follows the existing `fetchWithRetry` pattern in that file):

```javascript
describe('Migrated AEM redirects (#752)', () => {
  it('GET /leonardo-iot 301s to SAP Community', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/leonardo-iot`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://community.sap.com/topics/leonardo');
  });

  it('GET /abap 301s to the same-origin topic page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/abap`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/topics/abap-platform.html');
  });
});
```

- [ ] **Step 4: Run the full unit suite (smoke needs a deploy — don't run here)**

Run: `npx vitest run --project unit`
Expected: PASS — whole unit project green. Smoke tests run post-deploy (`npm run test:smoke` against a `BASE_URL`), not in this task.

- [ ] **Step 5: Commit**

```bash
git add mta.yaml test/smoke/redirects.test.js
git commit -m "build(#752): copy redirect-allowlist to approuter; add migration smoke tests"
```

---

### Task 6: Full-suite verification + branch finish

- [ ] **Step 1: Run the entire unit project**

Run: `npx vitest run --project unit`
Expected: PASS, no regressions. Pay attention to any other test asserting the LegacyRedirects seed count.

- [ ] **Step 2: Resolver mirror parity check**

Run: `diff -q srv/lib/legacy-redirects-resolver.js approuter/lib/legacy-redirects-resolver.js && diff -q srv/lib/redirect-allowlist.js approuter/lib/redirect-allowlist.js`
Expected: no output (both pairs identical).

- [ ] **Step 3: Push branch and open a draft PR**

```bash
git push -u origin feat/752-aem-redirect-migration
gh pr create --draft --repo sap-tutorials/tutorials-ims \
  --title "feat(#752): migrate AEM redirects into LegacyRedirects (+ external allowlist)" \
  --body "Implements the design in docs/superpowers/specs/2026-07-24-aem-redirect-migration-design.md. Extracts 30 valid redirects from the AEM RewriteRule export (11 external, 19 same-origin; 1 malformed rule dropped and documented) and adds an allowlisted external-redirect capability while preserving the #891 open-redirect guard. Closes part of #752 (mechanism 1 only; per-page sling:redirect export still pending)."
```

---

## Self-Review

**Spec coverage:**
- External allowlist support → Tasks 1, 2, 3. ✓
- 11 external + 19 same-origin rows seeded → Task 4. ✓
- Malformed rule dropped + documented → in spec (Excluded Rules); no seed row. ✓
- Both resolver copies + save validator swapped → Tasks 2, 3. ✓
- Build-time mirror of the new module → Task 5. ✓
- #891 guard preserved (capture-group re-check) → Task 2 Step 1 smuggle test + Step 3 keeps `isSameOriginPath`. ✓
- Location emission unchanged → noted in spec §Location; no task needed (verified `approuter/server.js:74`). ✓
- Existing seed-count test would break → Task 4 Step 1 fixes it. ✓

**Placeholder scan:** No TBD/TODO. The one judgment step (Task 4 escaping caution) gives an explicit decision rule, not a vague "handle escaping." ✓

**Type/name consistency:** `isAllowedTarget` / `ALLOWED_HOSTS` used identically across Tasks 1–3. `buildIndex`/`resolveRedirect` signatures unchanged. UUID scheme `…004`–`…033` = 30 rows, reconciles with row count 33. ✓

**Open risk flagged for executor:** Task 4's `isPattern`/escaping derivation is the highest-judgment step; the decision rule + the Step 5 "no row dropped" sanity check are the guardrails.
