# GitHub PAT → App Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three classic GitHub PATs with a `sap-tutorials-builder` GitHub App that mints 1-hour installation tokens, across CI (already scaffolded) and the CAP runtime (new code).

**Architecture:** One new `srv/lib/github-app-token.js` module signs an RS256 App JWT (via the existing `jose` dep) and exchanges it for a cached installation token. A single `resolveGithubToken(fallbackAlias)` helper gates on the `USE_GITHUB_APP` env flag — App token first, classic PAT fallback (fail-open). Three runtime consumers (`rebuild-trigger.js`, `fetch-samples-job.js`, `fetch-help-docs-job.js`) call the helper. CI activation is a config-only variable flip against merged scaffolding.

**Tech Stack:** Node ≥20 (native `fetch`), `@sap/cds`, `jose@6.2.3` (production dep — `SignJWT` + `importPKCS8`), Vitest, existing `secret-resolver.js` + `credstore.js`.

## Global Constraints

- **No new dependencies** — `jose@6.2.3` is already a production dep and exports `SignJWT` + `importPKCS8`.
- **Native `fetch` only** — no octokit, no axios (project baseline Node ≥20).
- **Fail-open everywhere** — any App-token fault returns `null`; callers fall back to the PAT. Never throw from token resolution.
- **globalThis-Symbol singleton** for any module cache — `Symbol.for('com.sap.developers.ims:<name>')` — matching `secret-resolver.js:25` / `credstore.js:47` (Vitest+CDS module multiplicity defense).
- **Warn once per TTL window**, never per call — matching `secret-resolver.js:80-84`.
- **Feature flag name is exactly `USE_GITHUB_APP`** (string `'true'`) — same name as the CI repo variable; runtime reads `process.env.USE_GITHUB_APP`.
- **Secret aliases are exact:** `TUTORIALS_APP_ID`, `TUTORIALS_APP_INSTALLATION_ID`, `TUTORIALS_APP_PRIVATE_KEY`, plus existing `GITHUB_DISPATCH_TOKEN`, `TUTORIALS_GITHUB_TOKEN`.
- **App JWT claims:** `iss = appId`, `iat = now - 60` (clock-skew guard), `exp = now + 540` (9 min; GitHub caps at 10). Header `alg: RS256`.
- Spec: `docs/superpowers/specs/2026-07-22-1154-github-app-migration-design.md`.

## File Structure

- **Create** `srv/lib/github-app-token.js` — App-JWT → installation-token minting + `resolveGithubToken` helper. One responsibility: produce a usable GitHub token honoring the flag.
- **Create** `test/unit/github-app-token.test.js` — unit suite (throwaway RSA keypair + mocked fetch).
- **Modify** `srv/lib/rebuild-trigger.js:67-69` — `getDispatchToken` delegates to helper.
- **Modify** `srv/jobs/fetch-samples-job.js:99-112` — token block delegates to helper.
- **Modify** `srv/jobs/fetch-help-docs-job.js:145-155` — token block delegates to helper.
- **Modify** `scripts/seed-secrets.cjs` — add 3 `TUTORIALS_APP_*` registry rows.
- **Modify** `.github/workflows/notify-qa.yml.template` — Phase 3 App-token step.
- **Modify** `docs/developers/operations/github-app-setup.md` — Phase 2/3 runbook + credstore loading.
- **Modify** `docs/historic/github-app-migration.md` — status → Active.
- **Extend** `test/unit/rebuild-trigger.test.js`, `test/unit/srv/fetch-samples-job.test.js`, `test/unit/srv/fetch-help-docs-job.test.js` — flag-on/off paths.

---

### Task 1: `github-app-token.js` — mint + cache installation token

**Files:**
- Create: `srv/lib/github-app-token.js`
- Test: `test/unit/github-app-token.test.js`

**Interfaces:**
- Consumes: `resolveSecret(alias, opts)` from `srv/lib/secret-resolver.js` (existing; returns `Promise<string|null>`).
- Produces:
  - `getInstallationToken() → Promise<string|null>` — cached 1h token, or null (fail-open).
  - `resolveGithubToken(fallbackAlias, opts?) → Promise<string|null>` — flag-gated: App token when `USE_GITHUB_APP==='true'` and available, else `resolveSecret(fallbackAlias)`.
  - `invalidateInstallationToken() → void` — force-flush cache.
  - `_resetForTests() → void`, `_primeForTests(token, expiresAtMs) → void` — test seams.

- [ ] **Step 1: Write the failing test (mint + JWT claims + cache)**

```javascript
// test/unit/github-app-token.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, jwtVerify, importSPKI, exportSPKI } from 'jose';

// secret-resolver is the only dependency — mock it so no credstore/env needed.
vi.mock('../../srv/lib/secret-resolver.js', () => ({
  resolveSecret: vi.fn(),
}));
import { resolveSecret } from '../../srv/lib/secret-resolver.js';
import {
  getInstallationToken, resolveGithubToken,
  invalidateInstallationToken, _resetForTests,
} from '../../srv/lib/github-app-token.js';

let publicPem, privatePem;
beforeEach(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  publicPem = await exportSPKI(publicKey);
  privatePem = await exportPKCS8(privateKey);
  _resetForTests();
  resolveSecret.mockReset();
  delete process.env.USE_GITHUB_APP;
});

function primeAppCreds() {
  resolveSecret.mockImplementation(async (alias) => {
    if (alias === 'TUTORIALS_APP_ID') return '123456';
    if (alias === 'TUTORIALS_APP_INSTALLATION_ID') return '789';
    if (alias === 'TUTORIALS_APP_PRIVATE_KEY') return privatePem;
    return null;
  });
}

it('mints an installation token with a correctly-signed RS256 App JWT', async () => {
  primeAppCreds();
  let sentAuthHeader, sentUrl;
  global.fetch = vi.fn(async (url, init) => {
    sentUrl = url; sentAuthHeader = init.headers.Authorization;
    return { ok: true, status: 201, json: async () => ({
      token: 'ghs_installationtoken', expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }) };
  });

  const tok = await getInstallationToken();
  expect(tok).toBe('ghs_installationtoken');
  expect(sentUrl).toBe('https://api.github.com/app/installations/789/access_tokens');

  const jwt = sentAuthHeader.replace('Bearer ', '');
  const pub = await importSPKI(publicPem, 'RS256');
  const { payload, protectedHeader } = await jwtVerify(jwt, pub);
  expect(protectedHeader.alg).toBe('RS256');
  expect(payload.iss).toBe('123456');
  expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/github-app-token.test.js -t "mints an installation token"`
Expected: FAIL — cannot resolve module `../../srv/lib/github-app-token.js`.

- [ ] **Step 3: Write the module**

```javascript
// srv/lib/github-app-token.js
//
// GitHub App installation-token minting for #1154. Signs an RS256 App JWT
// with the App private key (resolved via secret-resolver, credstore-first),
// exchanges it for a 1-hour installation token, and caches that token on a
// globalThis Symbol singleton until ~5 min before its real expiry.
//
// resolveGithubToken() is the single flag-gated entry point every runtime
// GitHub consumer calls: App token when USE_GITHUB_APP==='true' and
// available, classic PAT fallback otherwise. Fail-open on every fault.
//
// Spec: docs/superpowers/specs/2026-07-22-1154-github-app-migration-design.md

import { SignJWT, importPKCS8 } from 'jose';
import { resolveSecret } from './secret-resolver.js';

const GITHUB_API = 'https://api.github.com';
const EARLY_EXPIRY_MS = 5 * 60 * 1000;   // refresh 5 min before real expiry
const WARN_WINDOW_MS = 5 * 60 * 1000;

const STATE_KEY = Symbol.for('com.sap.developers.ims:github-app-token');
const _state = (globalThis[STATE_KEY] ??= {
  token: null,
  expiresAt: 0,        // ms epoch, already minus EARLY_EXPIRY_MS
  warnedWindowAt: 0,
});

function warnOnce(msg) {
  const now = Date.now();
  if (now - _state.warnedWindowAt > WARN_WINDOW_MS) {
    console.warn(`[github-app-token] ${msg}`);
    _state.warnedWindowAt = now;
  }
}

/**
 * Get a cached GitHub App installation token, minting a fresh one if the
 * cache is empty or within EARLY_EXPIRY_MS of expiry. Fail-open: returns
 * null on any fault (missing App creds, sign failure, non-2xx, network).
 * @returns {Promise<string|null>}
 */
export async function getInstallationToken() {
  if (_state.token && Date.now() < _state.expiresAt) {
    return _state.token;
  }
  try {
    const [appId, installationId, privateKeyPem] = await Promise.all([
      resolveSecret('TUTORIALS_APP_ID', { logTag: '[github-app-token]' }),
      resolveSecret('TUTORIALS_APP_INSTALLATION_ID', { logTag: '[github-app-token]' }),
      resolveSecret('TUTORIALS_APP_PRIVATE_KEY', { logTag: '[github-app-token]' }),
    ]);
    if (!appId || !installationId || !privateKeyPem) {
      warnOnce('App credentials incomplete (need TUTORIALS_APP_ID + _INSTALLATION_ID + _PRIVATE_KEY) — falling back.');
      return null;
    }

    const key = await importPKCS8(privateKeyPem, 'RS256');
    const nowSec = Math.floor(Date.now() / 1000);
    const appJwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(String(appId))
      .setIssuedAt(nowSec - 60)          // clock-skew guard
      .setExpirationTime(nowSec + 540)   // 9 min (GitHub caps at 10)
      .sign(key);

    const url = `${GITHUB_API}/app/installations/${installationId}/access_tokens`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      warnOnce(`installation-token exchange ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    if (!json?.token) {
      warnOnce('installation-token response missing token field');
      return null;
    }
    const realExpiryMs = json.expires_at ? Date.parse(json.expires_at) : (Date.now() + 3600_000);
    _state.token = json.token;
    _state.expiresAt = realExpiryMs - EARLY_EXPIRY_MS;
    return _state.token;
  } catch (err) {
    warnOnce(`mint failed (falling back): ${err.message ?? err}`);
    return null;
  }
}

/**
 * Single flag-gated GitHub-token entry point for runtime consumers.
 * @param {string} fallbackAlias — PAT alias when App is off/unavailable.
 * @param {object} [opts] — { logTag } forwarded to resolveSecret fallback.
 * @returns {Promise<string|null>}
 */
export async function resolveGithubToken(fallbackAlias, opts = {}) {
  if (process.env.USE_GITHUB_APP === 'true') {
    const appTok = await getInstallationToken();
    if (appTok) return appTok;
    // fail-open: fall through to PAT
  }
  return resolveSecret(fallbackAlias, opts);
}

/** Force-flush the cached installation token (admin rotation hook). */
export function invalidateInstallationToken() {
  _state.token = null;
  _state.expiresAt = 0;
}

/** Test-only: clear cache + warn window. */
export function _resetForTests() {
  _state.token = null;
  _state.expiresAt = 0;
  _state.warnedWindowAt = 0;
}

/** Test-only: prime the cache without minting. */
export function _primeForTests(token, expiresAtMs) {
  _state.token = token;
  _state.expiresAt = expiresAtMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/github-app-token.test.js -t "mints an installation token"`
Expected: PASS.

- [ ] **Step 5: Add the caching + fail-open + flag tests**

```javascript
it('caches the token — second call within TTL does not re-POST', async () => {
  primeAppCreds();
  const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({
    token: 'ghs_cached', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }) }));
  global.fetch = fetchMock;
  await getInstallationToken();
  await getInstallationToken();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('re-mints when cached token is within 5 min of expiry', async () => {
  primeAppCreds();
  const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({
    token: 'ghs_fresh', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }) }));
  global.fetch = fetchMock;
  _primeForTests('ghs_stale', Date.now() - 1);   // already past early-expiry
  const tok = await getInstallationToken();
  expect(tok).toBe('ghs_fresh');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('fails open to null on non-2xx', async () => {
  primeAppCreds();
  global.fetch = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'forbidden' }));
  expect(await getInstallationToken()).toBeNull();
});

it('fails open to null when App creds are missing', async () => {
  resolveSecret.mockResolvedValue(null);
  global.fetch = vi.fn();
  expect(await getInstallationToken()).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

it('resolveGithubToken returns PAT (no mint) when USE_GITHUB_APP is off', async () => {
  resolveSecret.mockImplementation(async (a) => a === 'MY_PAT' ? 'pat-value' : null);
  global.fetch = vi.fn();
  const tok = await resolveGithubToken('MY_PAT');
  expect(tok).toBe('pat-value');
  expect(global.fetch).not.toHaveBeenCalled();
});

it('resolveGithubToken prefers App token when USE_GITHUB_APP=true', async () => {
  process.env.USE_GITHUB_APP = 'true';
  primeAppCreds();
  global.fetch = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({
    token: 'ghs_app', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }) }));
  expect(await resolveGithubToken('TUTORIALS_GITHUB_TOKEN')).toBe('ghs_app');
});

it('resolveGithubToken falls back to PAT when App token is null even with flag on', async () => {
  process.env.USE_GITHUB_APP = 'true';
  resolveSecret.mockImplementation(async (a) => a === 'TUTORIALS_GITHUB_TOKEN' ? 'pat-fallback' : null);
  global.fetch = vi.fn();   // creds missing → getInstallationToken returns null without fetch
  expect(await resolveGithubToken('TUTORIALS_GITHUB_TOKEN')).toBe('pat-fallback');
});
```

- [ ] **Step 6: Run the full suite for this file**

Run: `npx vitest run test/unit/github-app-token.test.js`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/github-app-token.js test/unit/github-app-token.test.js
git commit -m "feat(#1154): github-app-token module — mint + cache installation token, flag-gated resolveGithubToken"
```

---

### Task 2: Wire `rebuild-trigger.js` to `resolveGithubToken`

**Files:**
- Modify: `srv/lib/rebuild-trigger.js:22-27` (import), `:67-69` (`getDispatchToken`)
- Test: `test/unit/rebuild-trigger.test.js` (extend)

**Interfaces:**
- Consumes: `resolveGithubToken(fallbackAlias, opts)` from Task 1.
- Produces: no signature change — `getDispatchToken()` still returns `Promise<string|null>`.

- [ ] **Step 1: Write the failing test (App-token path)**

Add to `test/unit/rebuild-trigger.test.js`. It already `vi.mock`s `credstore.js`; add a spy on the new module. Insert after the existing imports (line 15):

```javascript
// Flag-on path: rebuild-trigger should dispatch using the App installation token.
vi.mock('../../srv/lib/github-app-token.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getInstallationToken: vi.fn() };
});
import { getInstallationToken } from '../../srv/lib/github-app-token.js';
```

New test in the describe block:

```javascript
it('dispatches with the App installation token when USE_GITHUB_APP=true', async () => {
  process.env.USE_GITHUB_APP = 'true';
  getInstallationToken.mockResolvedValue('ghs_appdispatch');
  const seen = [];
  const dispatch = vi.fn(async (inputs, token) => { seen.push(token); return { status: 204 }; });
  _resetForTests({ dispatchFn: dispatch, debounceMs: 10 });   // note: no `token:` — force real resolution
  await scheduleRebuild('admin-write', { mode: 'catalog-only' });
  await new Promise(r => setTimeout(r, 30));
  expect(seen).toEqual(['ghs_appdispatch']);
  delete process.env.USE_GITHUB_APP;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/rebuild-trigger.test.js -t "App installation token"`
Expected: FAIL — dispatch receives the credstore/env PAT (or null), not `ghs_appdispatch`.

- [ ] **Step 3: Edit the import block**

In `srv/lib/rebuild-trigger.js`, add to the imports (after line 27):

```javascript
import { resolveGithubToken, invalidateInstallationToken } from './github-app-token.js';
```

- [ ] **Step 4: Delegate `getDispatchToken`**

Replace lines 67-69:

```javascript
async function getDispatchToken() {
  return resolveGithubToken('GITHUB_DISPATCH_TOKEN', { logTag: '[rebuild-trigger]' });
}
```

- [ ] **Step 5: Also flush the App token on admin rotation**

Replace `invalidateDispatchTokenCache` (lines 233-235) so a UI rotation flushes both caches:

```javascript
export function invalidateDispatchTokenCache() {
  invalidateSecret('GITHUB_DISPATCH_TOKEN');
  invalidateInstallationToken();
}
```

- [ ] **Step 6: Run the full rebuild-trigger suite**

Run: `npx vitest run test/unit/rebuild-trigger.test.js`
Expected: PASS — new App-token test passes; all pre-existing tests (flag unset → PAT path) still pass.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/rebuild-trigger.js test/unit/rebuild-trigger.test.js
git commit -m "feat(#1154): rebuild-trigger dispatches via App token when USE_GITHUB_APP=true"
```

---

### Task 3: Wire both fetch crons to `resolveGithubToken`

**Files:**
- Modify: `srv/jobs/fetch-samples-job.js:36` (import), `:99-112` (token block)
- Modify: `srv/jobs/fetch-help-docs-job.js:38` (import), `:145-155` (token block)
- Test: `test/unit/srv/fetch-samples-job.test.js`, `test/unit/srv/fetch-help-docs-job.test.js` (extend)

**Interfaces:**
- Consumes: `resolveGithubToken(fallbackAlias, opts)` from Task 1.
- Produces: no external change — `runFetchSamples` / `runFetchHelpDocs` signatures unchanged; `opts.apiKeyOverride` seam preserved.

- [ ] **Step 1: Write the failing test (samples cron, flag-on)**

Add to `test/unit/srv/fetch-samples-job.test.js`. Mock the new module and assert the corpus fetcher receives the App token when the flag is on and no `apiKeyOverride` is passed:

```javascript
vi.mock('../../../srv/lib/github-app-token.js', () => ({
  resolveGithubToken: vi.fn(),
}));
import { resolveGithubToken } from '../../../srv/lib/github-app-token.js';

it('uses the App token from resolveGithubToken when no apiKeyOverride is given', async () => {
  process.env.USE_GITHUB_APP = 'true';
  resolveGithubToken.mockResolvedValue('ghs_appsamples');
  let seenKey;
  const summary = await runFetchSamples(null, {
    // no apiKeyOverride → falls through to resolver
    sinceIsoOverride: '2020-01-01T00:00:00Z',
    // stub the corpus fetch by spying via the existing test's fetch mock;
    // capture the apiKey the fetcher was called with.
    // (match the existing suite's mechanism for stubbing fetchSapSamplesCorpus)
  }).catch(() => ({}));
  expect(resolveGithubToken).toHaveBeenCalledWith('TUTORIALS_GITHUB_TOKEN', expect.any(Object));
  delete process.env.USE_GITHUB_APP;
});
```

> Implementer note: the existing suite already stubs `fetchSapSamplesCorpus` — reuse that stub to capture the `apiKey` argument and assert it equals `'ghs_appsamples'`. The assertion above on `resolveGithubToken` being called with the alias is the minimum; add the apiKey-capture assertion using the suite's existing corpus stub.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/fetch-samples-job.test.js -t "App token from resolveGithubToken"`
Expected: FAIL — `resolveGithubToken` not imported by the job yet (spy never called).

- [ ] **Step 3: Edit fetch-samples-job.js import + token block**

Replace the import at line 36:

```javascript
import { resolveGithubToken } from '../lib/github-app-token.js';
```

Replace the token block (lines 99-112):

```javascript
    // 2. API key. opts.apiKeyOverride wins (test seam / explicit override).
    //    Otherwise resolveGithubToken honors USE_GITHUB_APP (App token first,
    //    TUTORIALS_GITHUB_TOKEN PAT fallback), then env GITHUB_TOKEN as last resort.
    let apiKey = opts.apiKeyOverride;
    if (apiKey === undefined) {
      apiKey = await resolveGithubToken('TUTORIALS_GITHUB_TOKEN', { logTag: 'fetch-samples' })
        .catch(() => null)
        || process.env.GITHUB_TOKEN
        || process.env.TUTORIALS_GITHUB_TOKEN;
    }
    if (!apiKey || apiKey === '') {
      LOG.error('fetch-samples: TUTORIALS_GITHUB_TOKEN missing; cannot reach GitHub API.');
      summary.errors++;
      return summary;
    }
```

- [ ] **Step 4: Edit fetch-help-docs-job.js import + token block**

Replace the import at line 38:

```javascript
import { resolveGithubToken } from '../lib/github-app-token.js';
```

Replace the token block (lines 145-155):

```javascript
    let apiKey = opts.apiKeyOverride;
    if (apiKey === undefined) {
      apiKey = await resolveGithubToken('TUTORIALS_GITHUB_TOKEN', { logTag: 'fetch-help-docs' })
        .catch(() => null)
        || process.env.GITHUB_TOKEN
        || process.env.TUTORIALS_GITHUB_TOKEN
        || null;
    }
    if (!apiKey) {
      LOG.warn('fetch-help-docs: TUTORIALS_GITHUB_TOKEN unavailable; cap-cloud-sap + architecture-sap-com fetchers will fail (help.sap.com + ui5.sap.com still fetch).');
    }
```

- [ ] **Step 5: Add the mirror test to fetch-help-docs-job.test.js**

```javascript
vi.mock('../../../srv/lib/github-app-token.js', () => ({
  resolveGithubToken: vi.fn(),
}));
import { resolveGithubToken } from '../../../srv/lib/github-app-token.js';

it('resolves the GitHub token via resolveGithubToken (flag-aware)', async () => {
  process.env.USE_GITHUB_APP = 'true';
  resolveGithubToken.mockResolvedValue('ghs_apphelp');
  await runFetchHelpDocs(null, { manualTrigger: true }).catch(() => ({}));
  expect(resolveGithubToken).toHaveBeenCalledWith('TUTORIALS_GITHUB_TOKEN', expect.any(Object));
  delete process.env.USE_GITHUB_APP;
});
```

- [ ] **Step 6: Run both cron suites**

Run: `npx vitest run test/unit/srv/fetch-samples-job.test.js test/unit/srv/fetch-help-docs-job.test.js`
Expected: PASS — new flag tests pass; pre-existing `apiKeyOverride: 'fake-token'` tests unaffected (override still short-circuits before the resolver).

- [ ] **Step 7: Commit**

```bash
git add srv/jobs/fetch-samples-job.js srv/jobs/fetch-help-docs-job.js \
  test/unit/srv/fetch-samples-job.test.js test/unit/srv/fetch-help-docs-job.test.js
git commit -m "feat(#1154): fetch-samples + fetch-help-docs crons resolve GitHub token flag-aware"
```

---

### Task 4: Register the three `TUTORIALS_APP_*` secrets

**Files:**
- Modify: `scripts/seed-secrets.cjs` (`INITIAL_SECRETS` array, after the `TUTORIALS_GITHUB_TOKEN` entry ~line 123)

**Interfaces:**
- Consumes: nothing (metadata-only registry rows).
- Produces: three new rows the admin Secrets UI surfaces for value entry.

- [ ] **Step 1: Add the three registry rows**

Insert after the `TUTORIALS_GITHUB_TOKEN` object (closing brace ~line 123), before `AI_AUTHOR_AICORE_SERVICE_KEY`:

```javascript
  {
    key: 'TUTORIALS_APP_ID',
    description: 'GitHub App ID for sap-tutorials-builder (#1154). Runtime: srv/lib/github-app-token.js mints installation tokens when USE_GITHUB_APP=true. Also stored as a GitHub Actions secret for CI. Non-secret numeric ID, tracked here for completeness + rotation visibility.',
    kind: 'github-app-config',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: 'https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/github-app-setup.md',
    expiresAt: null,
  },
  {
    key: 'TUTORIALS_APP_INSTALLATION_ID',
    description: 'GitHub App installation ID for sap-tutorials-builder on the sap-tutorials org (#1154). Runtime: srv/lib/github-app-token.js targets POST /app/installations/{id}/access_tokens. Non-secret numeric ID.',
    kind: 'github-app-config',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: 'https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/github-app-setup.md',
    expiresAt: null,
  },
  {
    key: 'TUTORIALS_APP_PRIVATE_KEY',
    description: 'GitHub App RSA private key (PEM) for sap-tutorials-builder (#1154). SECRET. Runtime: srv/lib/github-app-token.js signs the RS256 App JWT with it. Also stored as a GitHub Actions secret for CI (create-github-app-token@v1). Rotate by generating a new key on the App settings page and revoking the old one.',
    kind: 'github-app-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: 'https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/github-app-setup.md',
    expiresAt: null,
  },
```

- [ ] **Step 2: Verify the file parses**

Run: `node -e "require('./scripts/seed-secrets.cjs')" 2>&1 | head -3 || node --check scripts/seed-secrets.cjs && echo OK`
Expected: `OK` (no syntax error). (The script guards execution behind `--commit`; a bare require/`--check` just validates parse.)

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-secrets.cjs
git commit -m "feat(#1154): register TUTORIALS_APP_ID/INSTALLATION_ID/PRIVATE_KEY in secret registry"
```

---

### Task 5: Phase 3 — App-token step in the Contribution-repo template

**Files:**
- Modify: `.github/workflows/notify-qa.yml.template`

**Interfaces:**
- Consumes: repo variable `USE_GITHUB_APP` + Actions secrets `TUTORIALS_APP_ID`, `TUTORIALS_APP_PRIVATE_KEY` (present in each Contribution repo).
- Produces: `repository_dispatch` fired with an App token when the flag is on, PAT otherwise.

- [ ] **Step 1: Add the App-token step + swap the dispatch token**

Replace the `Fire repository_dispatch` job steps (current lines 11-31) with:

```yaml
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Determine changed slug
        id: slug
        run: |
          changed=$(git diff --name-only ${{ github.event.before }} ${{ github.sha }} \
            | awk -F/ '/^tutorials\//{print $2}' | sort -u)
          count=$(echo "$changed" | wc -l)
          if [ "$count" = "1" ] && [ -n "$changed" ]; then
            echo "slug=$changed" >> "$GITHUB_OUTPUT"
          else
            echo "slug=" >> "$GITHUB_OUTPUT"
          fi
      # GitHub App token (preferred). Activates when this Contribution repo has
      # USE_GITHUB_APP=true and the TUTORIALS_APP_* secrets populated. Falls
      # back to the classic TUTORIALS_POC_DISPATCH_TOKEN PAT while unset.
      # Requires the App to hold Contents:write on sap-tutorials/tutorials-ims
      # (repository_dispatch permission). See docs/developers/operations/github-app-setup.md.
      - name: Generate GitHub App token
        id: app-token
        if: ${{ vars.USE_GITHUB_APP == 'true' }}
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.TUTORIALS_APP_ID }}
          private-key: ${{ secrets.TUTORIALS_APP_PRIVATE_KEY }}
          owner: sap-tutorials
          repositories: tutorials-ims
      - name: Fire repository_dispatch
        uses: peter-evans/repository-dispatch@v3
        with:
          token: ${{ steps.app-token.outputs.token || secrets.TUTORIALS_POC_DISPATCH_TOKEN }}
          repository: sap-tutorials/tutorials-ims
          event-type: tutorial-qa-updated
          client-payload: '{"repo": "${{ github.repository }}", "slug": "${{ steps.slug.outputs.slug }}", "sha": "${{ github.sha }}"}'
```

- [ ] **Step 2: Lint the YAML**

Run: `npx yaml-lint .github/workflows/notify-qa.yml.template 2>/dev/null || yq '.' .github/workflows/notify-qa.yml.template > /dev/null && echo "valid YAML"`
Expected: `valid YAML` (parses cleanly).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/notify-qa.yml.template
git commit -m "feat(#1154): Phase 3 — notify-qa template mints App token, PAT fallback"
```

---

### Task 6: Docs — Phase 2/3 runbook + status flip

**Files:**
- Modify: `docs/developers/operations/github-app-setup.md`
- Modify: `docs/historic/github-app-migration.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Update the App permission set + add Phase 2/3 sections in `github-app-setup.md`**

In §1.1 (Register the App), change the Repository permissions block to add Actions and note the Phase-3 write:

```markdown
   - **Repository permissions:**
     - `Contents`: **Read-only** (Phase 3 note: bump to **Read and write** only if you migrate `TUTORIALS_POC_DISPATCH_TOKEN` — needed for `repository_dispatch`)
     - `Metadata`: **Read-only** (auto-selected)
     - `Actions`: **Read and write** (runtime `workflow_dispatch` from the CAP app — Phase 2)
     - everything else: **No access**
```

Append two new sections before `## Rollback`:

```markdown
## Part 3 — Runtime activation (Phase 2)

The CAP app (`tutorials-srv`) mints its own installation token via
`srv/lib/github-app-token.js` for the rebuild dispatcher and the two fetch
crons. This needs the App secrets in the **BTP Credential Store** (not just
GitHub Actions) plus a runtime flag.

### 3.1 Load the App secrets into the Credential Store

At `/admin-ui/#secrets-display` on the target env's approuter, set values for
the three registry rows (seeded by `scripts/seed-secrets.cjs`):

| Alias | Value |
|---|---|
| `TUTORIALS_APP_ID` | App ID from 1.3 |
| `TUTORIALS_APP_INSTALLATION_ID` | Installation ID from 1.4 |
| `TUTORIALS_APP_PRIVATE_KEY` | Full `.pem` contents from 1.2 (multi-line, incl. BEGIN/END) |

### 3.2 Flip the runtime flag

```bash
cf set-env tutorials-srv USE_GITHUB_APP true && cf restart tutorials-srv
```

Verify: trigger an admin save (fires a debounced `workflow_dispatch`) and
confirm `rebuild-content` ran; check srv logs for `[github-app-token]` warnings
(none expected on success). Roll back with `cf set-env tutorials-srv USE_GITHUB_APP false && cf restart tutorials-srv` — the PAT path resumes.

## Part 4 — Contribution-repo migration (Phase 3)

Each `*-Contribution` repo fires `repository_dispatch` at `tutorials-ims` via
`notify-qa.yml`. To migrate off `TUTORIALS_POC_DISPATCH_TOKEN`:

1. Ensure the App is **installed on the Contribution repo** and holds
   **Contents: write** on `tutorials-ims` (dispatch permission).
2. Add `TUTORIALS_APP_ID` + `TUTORIALS_APP_PRIVATE_KEY` Actions secrets to the
   Contribution repo.
3. Set repo variable `USE_GITHUB_APP=true` on the Contribution repo.
4. Push a tutorial change; confirm a `tutorial-qa-updated` dispatch reaches
   `tutorials-ims`.
5. After a clean run, delete `TUTORIALS_POC_DISPATCH_TOKEN` from that repo.

Roll out per-repo; each is independent.
```

- [ ] **Step 2: Flip status in `github-app-migration.md`**

Change the status line (line 3):

```markdown
**Status:** Active — runtime + CI code merged (#1154). Awaiting org-admin App registration to flip `USE_GITHUB_APP` on.
```

- [ ] **Step 3: Commit**

```bash
git add docs/developers/operations/github-app-setup.md docs/historic/github-app-migration.md
git commit -m "docs(#1154): Phase 2/3 runbook (runtime credstore + Contribution migration), status → Active"
```

---

### Task 7: Full-suite regression gate

**Files:** none (verification only).

- [ ] **Step 1: Run the affected unit suites together**

Run: `npx vitest run test/unit/github-app-token.test.js test/unit/rebuild-trigger.test.js test/unit/srv/fetch-samples-job.test.js test/unit/srv/fetch-help-docs-job.test.js`
Expected: all PASS.

- [ ] **Step 2: Run the broader unit suite to catch import-graph regressions**

Run: `npm test`
Expected: PASS (no regressions from the new import in three runtime files).

- [ ] **Step 3: Confirm no stray App token leaks to logs**

Run: `grep -rn "console.log.*token\|echo.*app-token" srv/lib/github-app-token.js`
Expected: no matches (only `warnOnce` messages, none of which print the token value).

- [ ] **Step 4: Push branch + open draft PR**

```bash
git push -u origin worktree-1154-github-app-migration
gh pr create --draft --title "feat(#1154): migrate GitHub PATs to sap-tutorials-builder App (runtime + Phase 3 template)" \
  --body "Implements #1154 Phases 2 & 3 (runtime code) atop the merged Phase 1 CI scaffolding. See docs/superpowers/specs/2026-07-22-1154-github-app-migration-design.md. Inert until USE_GITHUB_APP flags flip; PAT fallback intact until cleanup."
```

---

## Self-Review

**Spec coverage:**
- `github-app-token.js` module → Task 1 ✓
- `USE_GITHUB_APP` flag + `resolveGithubToken` helper → Task 1 ✓
- rebuild-trigger wiring (Actions:write) → Task 2 ✓
- both crons wiring → Task 3 ✓
- secret registry rows (credstore + CI) → Task 4 ✓
- Phase 3 template + scope-widening note → Task 5, Task 6 ✓
- manual runbook (Phase 2 credstore, Phase 3 per-repo) → Task 6 ✓
- status flip → Task 6 ✓
- testing (module + 3 consumers + regression) → Tasks 1-3, 7 ✓
- Phase 1 CI activation = config-only (no code) — correctly no task; covered in runbook ✓
- `deploy.yml` untouched — correctly no task ✓

**Placeholder scan:** One deliberate implementer-note in Task 3 Step 1 (corpus-stub reuse) — acceptable because it points at the existing suite's mechanism rather than hand-waving; the `resolveGithubToken` call assertion is concrete and sufficient to gate the task. No TBD/TODO elsewhere.

**Type consistency:** `getInstallationToken` / `resolveGithubToken` / `invalidateInstallationToken` / `_resetForTests` / `_primeForTests` used identically in Tasks 1-3. Alias strings (`TUTORIALS_APP_ID`, `TUTORIALS_APP_INSTALLATION_ID`, `TUTORIALS_APP_PRIVATE_KEY`, `GITHUB_DISPATCH_TOKEN`, `TUTORIALS_GITHUB_TOKEN`) consistent across module, wiring, and registry.
