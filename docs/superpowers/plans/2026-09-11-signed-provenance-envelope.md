# Signed Tutorial Provenance & Freshness Attestation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a per-tutorial cryptographically signed envelope (compact JWS / EdDSA) carrying separate provenance and freshness claims, plus advisory headers on the HTML serve path, so any third-party AI agent can verify and down-weight stale SAP tutorial content.

**Architecture:** New `srv/lib/provenance-*.js` modules build claims from the existing `FreshnessReport` + `ContentCurrent` rows, sign them with `jose` using an Ed25519 key loaded from the BTP Credential Store, and cache the JWS by `(contentHash, runAt)`. A sibling `/content/tutorials/:slug/provenance` route serves the JWS; a `/.well-known/tutorial-provenance/jwks.json` route publishes the public key. Advisory (unsigned) headers are added inside `serveStoredSlug`. Everything is DB-flag-gated and fail-open.

**Tech Stack:** CAP Node.js (`@sap/cds` 10), Express (bootstrap block in `srv/server.js`), `jose` 6.2.3 (EdDSA / JWS / JWKS), `node:crypto`, HANA/SQLite via CDS, vitest 4 + `@cap-js/cds-test`.

**Spec:** `docs/superpowers/specs/2026-09-11-2245-signed-provenance-envelope-design.md`

## Global Constraints

- **Node floor `>=22.12`; ESM only** (`"type":"module"`) — use `import`.
- **Feature flags are DB config, never env** — register in `srv/lib/feature-flags/registry.js` (`kind:'db'`), read via synchronous `isFlagEnabled(key)` from `srv/lib/feature-flags/db-flags.js`. A drift test fails the build if a flag is used without a registry entry.
- **Fail-open everywhere** — any signing/key/lookup error serves content normally; the provenance endpoint returns 503; nothing throws into the content path.
- **No new runtime dependency** — `jose` is already in `dependencies`; do not add crypto libs.
- **Secrets never in source/env-committed** — the Ed25519 private key comes from the BTP Credential Store, surfaced at runtime as env `PROVENANCE_SIGNING_KEY` (PKCS8 PEM).
- **Slugs are lowercase-canonical** — `.toLowerCase()` before any slug comparison/lookup.
- **Thresholds are module constants for v1:** `FRESH_MAX_AGE_DAYS = 30`, `STALE_AGE_DAYS = 90`, `ATTESTATION_TTL_SECONDS = 86400`.
- **`srv/lib/` change → re-audit `srv-qa` `cp` list** in `.deploy/mta.yaml` for any new transitive `./` import reachable from `content-store.js`.

---

### Task 1: Register the `PROVENANCE_ENVELOPE_ENABLED` feature flag

**Files:**
- Modify: `srv/lib/feature-flags/registry.js` (add entry near `FRESHNESS_SCAN_ENABLED`)
- Test: `test/unit/feature-flags-registry.test.js` (existing drift test — must stay green)

**Interfaces:**
- Produces: registry key `'PROVENANCE_ENVELOPE_ENABLED'` (ImsConfig key `flag.provenance.envelope`), read via `isFlagEnabled('PROVENANCE_ENVELOPE_ENABLED')`.

- [ ] **Step 1: Run the existing registry drift test to confirm baseline green**

Run: `npx vitest run --project unit test/unit/feature-flags-registry.test.js`
Expected: PASS.

- [ ] **Step 2: Add the flag entry**

In `srv/lib/feature-flags/registry.js`, next to the `FRESHNESS_SCAN_ENABLED` entry, add:

```js
{
  key: 'PROVENANCE_ENVELOPE_ENABLED', label: 'Signed provenance & freshness envelope', category: 'Content',
  kind: 'db', imsConfigKey: 'flag.provenance.envelope',
  valueType: 'boolean', default: false, status: 'dev-only',
  description: 'When true, serves the signed provenance JWS at /content/tutorials/:slug/provenance, publishes the JWKS at /.well-known/tutorial-provenance/jwks.json, and emits advisory X-Freshness-Confidence / X-Content-Provenance headers. DB-driven config (ImsConfig key flag.provenance.envelope); no env var. Default OFF.',
  howToChange: featureFlagUpsert('PROVENANCE_ENVELOPE_ENABLED', 'flag.provenance.envelope'),
},
```

- [ ] **Step 3: Run the drift test again**

Run: `npx vitest run --project unit test/unit/feature-flags-registry.test.js`
Expected: PASS (new flag recognized; no "unregistered flag" failure).

- [ ] **Step 4: Commit**

```bash
git add srv/lib/feature-flags/registry.js
git commit -m "feat(2245): register PROVENANCE_ENVELOPE_ENABLED db feature flag"
```

---

### Task 2: Ed25519 key module — load signer + expose JWKS

**Files:**
- Create: `srv/lib/provenance-keys.js`
- Test: `test/unit/provenance-keys.test.js`

**Interfaces:**
- Consumes: env `PROVENANCE_SIGNING_KEY` (PKCS8 PEM, Ed25519).
- Produces:
  - `async getSigningKey()` → `{ key: KeyLike, kid: string } | null` (null when key absent/invalid — fail-open signal)
  - `async getJwks()` → `{ keys: JWK[] }` (empty `keys: []` when no key)
  - test helper `__setKeyForTest(pkcs8Pem | null)` and `__resetKeysForTest()`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/provenance-keys.test.js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { generateKeyPair, exportPKCS8, jwtVerify, importJWK } from 'jose';
import { getSigningKey, getJwks, __setKeyForTest, __resetKeysForTest } from '../../srv/lib/provenance-keys.js';

let pem;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  pem = await exportPKCS8(privateKey);
});
afterEach(() => __resetKeysForTest());

describe('provenance-keys', () => {
  it('returns null signer when no key configured', async () => {
    __setKeyForTest(null);
    expect(await getSigningKey()).toBeNull();
    expect((await getJwks()).keys).toEqual([]);
  });

  it('loads an Ed25519 signer and publishes a matching public JWK', async () => {
    __setKeyForTest(pem);
    const signer = await getSigningKey();
    expect(signer).not.toBeNull();
    expect(signer.kid).toMatch(/.+/);
    const jwks = await getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA', kid: signer.kid });
    expect(jwks.keys[0].d).toBeUndefined(); // never leak the private scalar
    // round-trip: sign with signer, verify with the published public JWK
    const { SignJWT } = await import('jose');
    const jws = await new SignJWT({ t: 1 }).setProtectedHeader({ alg: 'EdDSA', kid: signer.kid }).sign(signer.key);
    const pub = await importJWK(jwks.keys[0], 'EdDSA');
    const { payload } = await jwtVerify(jws, pub);
    expect(payload.t).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/provenance-keys.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `srv/lib/provenance-keys.js`**

```js
import { importPKCS8, exportJWK, calculateJwkThumbprint } from 'jose';

let _testPem; // when set (incl. null), overrides env — for tests only
let _cache;   // memoized { key, kid, jwk } | null

function readPem() {
  if (_testPem !== undefined) return _testPem;
  return process.env.PROVENANCE_SIGNING_KEY || null;
}

async function load() {
  if (_cache !== undefined) return _cache;
  const pem = readPem();
  if (!pem) { _cache = null; return _cache; }
  try {
    const key = await importPKCS8(pem, 'EdDSA', { extractable: true });
    const priv = await exportJWK(key);
    const jwk = { kty: priv.kty, crv: priv.crv, x: priv.x }; // public-only
    const kid = await calculateJwkThumbprint(jwk);
    _cache = { key, kid, jwk: { ...jwk, use: 'sig', alg: 'EdDSA', kid } };
  } catch (e) {
    console.warn('[provenance-keys] failed to load signing key, disabling:', e.message);
    _cache = null;
  }
  return _cache;
}

export async function getSigningKey() {
  const c = await load();
  return c ? { key: c.key, kid: c.kid } : null;
}

export async function getJwks() {
  const c = await load();
  return { keys: c ? [c.jwk] : [] };
}

export function __setKeyForTest(pem) { _testPem = pem; _cache = undefined; }
export function __resetKeysForTest() { _testPem = undefined; _cache = undefined; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/provenance-keys.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/provenance-keys.js test/unit/provenance-keys.test.js
git commit -m "feat(2245): Ed25519 provenance key loader + JWKS export"
```

---

### Task 3: Freshness confidence derivation (pure function)

**Files:**
- Create: `srv/lib/provenance-freshness.js`
- Test: `test/unit/provenance-freshness.test.js`

**Interfaces:**
- Produces: `deriveConfidence({ report, now = Date.now() })` where `report` is `{ status, openHighCount, openMediumCount, runAt } | null`. Returns `'high' | 'medium' | 'low' | 'unknown'`. Also exports constants `FRESH_MAX_AGE_DAYS = 30`, `STALE_AGE_DAYS = 90`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/provenance-freshness.test.js
import { describe, it, expect } from 'vitest';
import { deriveConfidence } from '../../srv/lib/provenance-freshness.js';

const DAY = 86400000;
const now = Date.UTC(2026, 8, 11);
const ago = d => new Date(now - d * DAY).toISOString();

describe('deriveConfidence', () => {
  it('unknown when no report', () => {
    expect(deriveConfidence({ report: null, now })).toBe('unknown');
  });
  it('unknown when report not DONE', () => {
    expect(deriveConfidence({ report: { status: 'FAILED', openHighCount: 0, openMediumCount: 0, runAt: ago(1) }, now })).toBe('unknown');
  });
  it('high: fresh scan, no high, no medium', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: ago(10) }, now })).toBe('high');
  });
  it('medium: clean but aging (30-90d)', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: ago(45) }, now })).toBe('medium');
  });
  it('medium: fresh scan but only medium findings', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 2, runAt: ago(5) }, now })).toBe('medium');
  });
  it('low: any open high finding', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 1, openMediumCount: 0, runAt: ago(1) }, now })).toBe('low');
  });
  it('low: scan older than 90d even if clean', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: ago(120) }, now })).toBe('low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/provenance-freshness.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `srv/lib/provenance-freshness.js`**

```js
export const FRESH_MAX_AGE_DAYS = 30;
export const STALE_AGE_DAYS = 90;
const DAY = 86400000;

export function deriveConfidence({ report, now = Date.now() }) {
  if (!report || report.status !== 'DONE' || !report.runAt) return 'unknown';
  const ageDays = (now - new Date(report.runAt).getTime()) / DAY;
  const high = report.openHighCount || 0;
  const medium = report.openMediumCount || 0;
  if (high > 0) return 'low';
  if (ageDays > STALE_AGE_DAYS) return 'low';
  if (ageDays > FRESH_MAX_AGE_DAYS || medium > 0) return 'medium';
  return 'high';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/provenance-freshness.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/provenance-freshness.js test/unit/provenance-freshness.test.js
git commit -m "feat(2245): freshness confidence derivation"
```

> **Note for Task 6:** `FreshnessReport` has `openHighCount` but NOT `openMediumCount` today. Task 6 computes `openMediumCount` from `FreshnessFinding` rows (disposition OPEN, severity Medium) at read time, since it is not stored. The derivation treats a missing `openMediumCount` as `0`.

---

### Task 4: `sourceCommit` schema column + publish append plumbing

**Files:**
- Modify: `db/_content-shape.cds` (add `sourceCommit` to `ContentFilesAspect`, `ContentCurrentAspect`, `ContentHistoryAspect`)
- Modify: `srv/lib/content-publish-session.js` (accept `sourceCommits`, stamp onto ContentFiles row + carry to ContentCurrent)
- Modify: `srv/lib/content-store.js` (`appendHandler` — destructure + forward `sourceCommits`)
- Test: `test/lib/content-store.test.js` (extend publish/append test)

**Interfaces:**
- Consumes: append payload gains optional `sourceCommits: Record<slug, string>`.
- Produces: `ContentCurrent.sourceCommit` (String(64)) populated per slug; read by Task 6.

- [ ] **Step 1: Add the schema column**

In `db/_content-shape.cds`, add to `ContentFilesAspect`, `ContentCurrentAspect`, and `ContentHistoryAspect` (after `sourceHash`):

```cds
  sourceCommit              : String(64);   // git commit SHA of source .md at publish time (#2245); null for pre-2245 rows
```

- [ ] **Step 2: Verify the model still compiles**

Run: `npx cds compile db/ srv/ > /dev/null && echo OK`
Expected: `OK` (no compile error).

- [ ] **Step 3: Write the failing test**

Add to `test/lib/content-store.test.js` inside the `POST /content/publish` describe (mirror the existing append flow — this repo uses the session begin/append/commit endpoints; follow the existing append test in this file for the exact begin/commit calls):

```js
it('persists sourceCommit onto ContentCurrent when supplied', async () => {
  const { ContentCurrent } = cds.entities('com.sap.developers.ims');
  const slug = 'commit-tutorial';
  const sha = 'a'.repeat(40);
  // begin → append(files + sourceCommits) → commit, per the existing append helper in this file
  await publishViaSession({ files: { [slug]: '<h1>x</h1>' }, sourceCommits: { [slug]: sha } });
  const row = await SELECT.one.from(ContentCurrent).where({ slug });
  expect(row.sourceCommit).toBe(sha);
});
```

(If no `publishViaSession` helper exists, inline the begin/append/commit `project.axios.post` calls the sibling append test already uses, adding `sourceCommits` to the append body.)

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run --project unit test/lib/content-store.test.js -t sourceCommit`
Expected: FAIL (`sourceCommit` undefined / column absent in payload path).

- [ ] **Step 5: Thread `sourceCommits` through the handler and session**

In `srv/lib/content-store.js` `appendHandler` (~line 1935), add `sourceCommits` to the destructure and forward it:

```js
const { sessionId, files, metadata, bodyTexts, branchSpecs, sources, sourceCommits } = req.body || {};
...
const result = await sessionHelpers.appendToSession({ sessionId, files, metadata, bodyTexts, branchSpecs, sources, sourceCommits });
```

In `srv/lib/content-publish-session.js` `appendToSession` (~line 150), accept `sourceCommits = {}` and stamp it on the per-slug ContentFiles entry (~lines 186–196):

```js
entries.push({
  slug, version: session.version, content: compressed, contentHash,
  sizeBytes: decompressed.length, compressedBytes: compressed.length,
  mimeType: 'text/html', sourceContent, sourceHash,
  sourceCommit: sourceCommits[slug] || null,
});
```

Then ensure the ContentFiles→ContentCurrent promotion copies `sourceCommit`. Locate the ContentCurrent upsert in `content-publish-session.js` (the mutable-current write, Option B) and add `sourceCommit` to its column set the same way `sourceHash` is carried.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run --project unit test/lib/content-store.test.js -t sourceCommit`
Expected: PASS.

- [ ] **Step 7: Deploy-check the migration compiles for production**

Run: `npx cds build --production > /dev/null && echo BUILD_OK`
Expected: `BUILD_OK` (confirms the new column generates a clean migration table; do NOT hand-author `.hdbmigrationtable`).

- [ ] **Step 8: Commit**

```bash
git add db/_content-shape.cds srv/lib/content-publish-session.js srv/lib/content-store.js test/lib/content-store.test.js
git commit -m "feat(2245): persist per-slug sourceCommit through publish append"
```

---

### Task 5: Provenance envelope builder + signer + cache

**Files:**
- Create: `srv/lib/provenance-envelope.js`
- Test: `test/unit/provenance-envelope.test.js`

**Interfaces:**
- Consumes: `getSigningKey()` (Task 2), `deriveConfidence()` (Task 3).
- Produces: `async buildEnvelope({ slug, contentHash, sourceCommit, builtAt, report, now })` → `{ jws, claims } | null` (null = fail-open / no key). Signs a compact JWS (JWT) with claims per spec. Caches the JWS keyed by `${slug}:${contentHash}:${report?.runAt || 'none'}`. Exposes `__clearEnvelopeCacheForTest()`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/provenance-envelope.test.js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { generateKeyPair, exportPKCS8, importJWK, jwtVerify, decodeJwt } from 'jose';
import { buildEnvelope, __clearEnvelopeCacheForTest } from '../../srv/lib/provenance-envelope.js';
import { getJwks, __setKeyForTest, __resetKeysForTest } from '../../srv/lib/provenance-keys.js';

let pem;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  pem = await exportPKCS8(privateKey);
});
afterEach(() => { __resetKeysForTest(); __clearEnvelopeCacheForTest(); });

const base = {
  slug: 'my-tutorial', contentHash: 'c'.repeat(64), sourceCommit: 'a'.repeat(40),
  builtAt: '2026-09-10T00:00:00.000Z',
  report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: '2026-09-05T00:00:00.000Z', model: 'gpt-x' },
  now: Date.UTC(2026, 8, 11),
};

describe('buildEnvelope', () => {
  it('returns null when no signing key (fail-open)', async () => {
    __setKeyForTest(null);
    expect(await buildEnvelope(base)).toBeNull();
  });

  it('signs a verifiable JWS with two distinct claim groups', async () => {
    __setKeyForTest(pem);
    const { jws, claims } = await buildEnvelope(base);
    const pub = await importJWK((await getJwks()).keys[0], 'EdDSA');
    const { payload } = await jwtVerify(jws, pub, { issuer: 'https://developers.sap.com' });
    expect(payload.sub).toBe('my-tutorial');
    expect(payload.contentHash).toBe(base.contentHash);
    expect(payload.provenance).toMatchObject({ sourceRepo: 'sap-tutorials/Tutorials', sourceCommit: base.sourceCommit, builtAt: base.builtAt });
    expect(payload.freshness).toMatchObject({ confidence: 'high', lastScanned: base.report.runAt, openHighCount: 0, detectorModel: 'gpt-x' });
    expect(payload.exp - payload.iat).toBe(86400);
    expect(claims.freshness.confidence).toBe('high');
  });

  it('tampered payload fails verification', async () => {
    __setKeyForTest(pem);
    const { jws } = await buildEnvelope(base);
    const pub = await importJWK((await getJwks()).keys[0], 'EdDSA');
    const [h, , s] = jws.split('.');
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(jws), contentHash: 'f'.repeat(64) })).toString('base64url');
    await expect(jwtVerify(`${h}.${forged}.${s}`, pub)).rejects.toThrow();
  });

  it('emits unknown confidence + null sourceCommit honestly', async () => {
    __setKeyForTest(pem);
    const { claims } = await buildEnvelope({ ...base, sourceCommit: null, report: null });
    expect(claims.freshness.confidence).toBe('unknown');
    expect(claims.provenance.sourceCommit).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/provenance-envelope.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `srv/lib/provenance-envelope.js`**

```js
import { SignJWT } from 'jose';
import { getSigningKey } from './provenance-keys.js';
import { deriveConfidence } from './provenance-freshness.js';

const ISS = 'https://developers.sap.com';
const SOURCE_REPO = 'sap-tutorials/Tutorials';
const TTL_SECONDS = 86400;
const _cache = new Map(); // key -> { jws, claims }

function cacheKey({ slug, contentHash, report }) {
  return `${slug}:${contentHash}:${report?.runAt || 'none'}`;
}

export async function buildEnvelope({ slug, contentHash, sourceCommit, builtAt, report, now = Date.now() }) {
  const signer = await getSigningKey();
  if (!signer) return null; // fail-open: no key configured

  const key = cacheKey({ slug, contentHash, report });
  const hit = _cache.get(key);
  if (hit && hit.claims.exp * 1000 > now) return hit;

  const iat = Math.floor(now / 1000);
  const claims = {
    iss: ISS, sub: slug, iat, exp: iat + TTL_SECONDS,
    contentHash,
    provenance: { sourceRepo: SOURCE_REPO, sourceCommit: sourceCommit ?? null, builtAt: builtAt ?? null },
    freshness: {
      confidence: deriveConfidence({ report, now }),
      lastScanned: report?.runAt ?? null,
      openHighCount: report?.openHighCount ?? 0,
      detectorModel: report?.model ?? null,
    },
  };

  try {
    const { iss, sub, iat: _i, exp, ...rest } = claims;
    const jws = await new SignJWT(rest)
      .setProtectedHeader({ alg: 'EdDSA', kid: signer.kid, typ: 'application/tutorial-provenance+jws' })
      .setIssuer(ISS).setSubject(slug).setIssuedAt(iat).setExpirationTime(claims.exp)
      .sign(signer.key);
    const envelope = { jws, claims };
    _cache.set(key, envelope);
    return envelope;
  } catch (e) {
    console.warn('[provenance-envelope] signing failed, fail-open:', e.message);
    return null;
  }
}

export function __clearEnvelopeCacheForTest() { _cache.clear(); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/provenance-envelope.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/provenance-envelope.js test/unit/provenance-envelope.test.js
git commit -m "feat(2245): signed provenance envelope builder + cache"
```

---

### Task 6: Serve-time data loader (slug → contentHash + sourceCommit + report)

**Files:**
- Create: `srv/lib/provenance-data.js`
- Test: `test/unit/provenance-data.test.js` (uses `cds.test` in-memory)

**Interfaces:**
- Produces: `async loadProvenanceInputs(slug)` → `{ contentHash, sourceCommit, builtAt, report } | null` (null when the tutorial content row is absent). `report` shape: `{ status, openHighCount, openMediumCount, runAt, model } | null`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/provenance-data.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { loadProvenanceInputs } from '../../srv/lib/provenance-data.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('loadProvenanceInputs', () => {
  let ContentCurrent, Tutorials, FreshnessReport, FreshnessFinding;
  beforeAll(() => { ({ ContentCurrent, Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims')); });
  beforeEach(async () => {
    await DELETE.from(ContentCurrent); await DELETE.from(FreshnessFinding);
    await DELETE.from(FreshnessReport); await DELETE.from(Tutorials);
  });

  it('returns null for unknown slug', async () => {
    expect(await loadProvenanceInputs('nope')).toBeNull();
  });

  it('joins content row, source commit, and current freshness report', async () => {
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo' });
    await INSERT.into(ContentCurrent).entries({ slug: 'demo', contentHash: 'h'.repeat(64), sourceCommit: 'a'.repeat(40), modifiedAt: '2026-09-10T00:00:00.000Z' });
    await INSERT.into(FreshnessReport).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, status: 'DONE', openHighCount: 0, runAt: '2026-09-05T00:00:00.000Z', model: 'm1' });
    const out = await loadProvenanceInputs('demo');
    expect(out.contentHash).toBe('h'.repeat(64));
    expect(out.sourceCommit).toBe('a'.repeat(40));
    expect(out.report).toMatchObject({ status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: '2026-09-05T00:00:00.000Z', model: 'm1' });
  });

  it('counts open medium findings', async () => {
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo2' });
    await INSERT.into(ContentCurrent).entries({ slug: 'demo2', contentHash: 'h'.repeat(64) });
    const rid = cds.utils.uuid();
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE', openHighCount: 0, runAt: '2026-09-05T00:00:00.000Z' });
    await INSERT.into(FreshnessFinding).entries([
      { ID: cds.utils.uuid(), report_ID: rid, tutorial_ID: tid, severity: 'Medium', disposition: 'OPEN' },
      { ID: cds.utils.uuid(), report_ID: rid, tutorial_ID: tid, severity: 'Medium', disposition: 'DISMISSED' },
    ]);
    const out = await loadProvenanceInputs('demo2');
    expect(out.report.openMediumCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/provenance-data.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `srv/lib/provenance-data.js`**

```js
import cds from '@sap/cds';

export async function loadProvenanceInputs(rawSlug) {
  const slug = String(rawSlug || '').toLowerCase();
  const { ContentCurrent, Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims');
  try {
    const content = await SELECT.one.from(ContentCurrent).columns('contentHash', 'sourceCommit', 'modifiedAt').where({ slug });
    if (!content) return null;

    const tut = await SELECT.one.from(Tutorials).columns('ID').where({ slug });
    let report = null;
    if (tut) {
      const rep = await SELECT.one.from(FreshnessReport)
        .columns('status', 'openHighCount', 'runAt', 'model').where({ tutorial_ID: tut.ID });
      if (rep) {
        const med = await SELECT.one.from(FreshnessFinding)
          .columns('count(*) as n').where({ tutorial_ID: tut.ID, severity: 'Medium', disposition: 'OPEN' });
        report = { status: rep.status, openHighCount: rep.openHighCount || 0, openMediumCount: med?.n || 0, runAt: rep.runAt, model: rep.model };
      }
    }
    return { contentHash: content.contentHash, sourceCommit: content.sourceCommit || null, builtAt: content.modifiedAt || null, report };
  } catch (e) {
    console.warn('[provenance-data] load failed, fail-open:', e.message);
    return null;
  }
}
```

> **Executor note:** confirm the `Tutorials` slug column name and that `ContentCurrent` exposes `modifiedAt` (from `managed`). If `count(*) as n` misbehaves under the CI Node/CDS combo, use `cds.entities(NS)` (already done) and fall back to fetching finding rows and counting in JS — see memory `ci-node-version-mismatch`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/provenance-data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/provenance-data.js test/unit/provenance-data.test.js
git commit -m "feat(2245): serve-time provenance input loader"
```

---

### Task 7: Provenance endpoint + JWKS route

**Files:**
- Modify: `srv/server.js` (register two routes in the `cds.on('bootstrap')` block)
- Create: `srv/lib/provenance-handlers.js` (route handlers)
- Test: `test/lib/provenance-endpoint.test.js` (`cds.test` HTTP)

**Interfaces:**
- Consumes: `isFlagEnabled` (Task 1), `buildEnvelope` (Task 5), `loadProvenanceInputs` (Task 6), `getJwks` (Task 2).
- Produces: `provenanceHandler(req,res)` and `jwksHandler(req,res)` exported from `provenance-handlers.js`.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/provenance-endpoint.test.js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import { generateKeyPair, exportPKCS8, importJWK, jwtVerify } from 'jose';
import { __setKeyForTest, __resetKeysForTest } from '../../srv/lib/provenance-keys.js';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('provenance endpoint', () => {
  let ContentCurrent, Tutorials;
  beforeAll(async () => {
    ({ ContentCurrent, Tutorials } = cds.entities('com.sap.developers.ims'));
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    __setKeyForTest(await exportPKCS8(privateKey));
  });
  afterAll(() => { __resetKeysForTest(); __resetFlagsForTest(); });
  beforeEach(async () => {
    await DELETE.from(ContentCurrent); await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries({ ID: cds.utils.uuid(), slug: 'demo' });
    await INSERT.into(ContentCurrent).entries({ slug: 'demo', contentHash: 'h'.repeat(64), sourceCommit: 'a'.repeat(40) });
  });

  it('404s when flag OFF', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', false);
    await expect(project.axios.get('/content/tutorials/demo/provenance')).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('serves a verifiable JWS when flag ON', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', true);
    const res = await project.axios.get('/content/tutorials/demo/provenance');
    expect(res.status).toBe(200);
    const jwks = await project.axios.get('/.well-known/tutorial-provenance/jwks.json');
    const pub = await importJWK(jwks.data.keys[0], 'EdDSA');
    const { payload } = await jwtVerify(res.data.jws, pub, { issuer: 'https://developers.sap.com' });
    expect(payload.sub).toBe('demo');
    expect(payload.provenance.sourceCommit).toBe('a'.repeat(40));
  });

  it('404s for unknown slug when flag ON', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', true);
    await expect(project.axios.get('/content/tutorials/nope/provenance')).rejects.toMatchObject({ response: { status: 404 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/lib/provenance-endpoint.test.js`
Expected: FAIL (routes not registered → likely wildcard swallow / 200 HTML or 404 with wrong body).

- [ ] **Step 3: Implement `srv/lib/provenance-handlers.js`**

```js
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { buildEnvelope } from './provenance-envelope.js';
import { loadProvenanceInputs } from './provenance-data.js';
import { getJwks } from './provenance-keys.js';

export async function provenanceHandler(req, res) {
  if (!isFlagEnabled('PROVENANCE_ENVELOPE_ENABLED')) return res.status(404).end();
  const slug = String(req.params.slug || '').toLowerCase();
  const inputs = await loadProvenanceInputs(slug);
  if (!inputs) return res.status(404).json({ error: 'not_found' });
  const envelope = await buildEnvelope({ slug, ...inputs });
  if (!envelope) return res.status(503).json({ error: 'attestation_unavailable' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600');
  res.json({ jws: envelope.jws, jwks_url: '/.well-known/tutorial-provenance/jwks.json' });
}

export async function jwksHandler(req, res) {
  if (!isFlagEnabled('PROVENANCE_ENVELOPE_ENABLED')) return res.status(404).end();
  const jwks = await getJwks();
  res.setHeader('Content-Type', 'application/jwk-set+json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  res.json(jwks);
}
```

- [ ] **Step 4: Register the routes in `srv/server.js`**

In the `cds.on('bootstrap')` block, import the handlers at the top (near line 32) and register the provenance route **before** the `app.get('/content/tutorials/*slug', serveHandler)` wildcard (~line 760), and the JWKS route alongside the other `/.well-known/*` handlers (~line 1034):

```js
// before the /content/tutorials/*slug wildcard:
app.get('/content/tutorials/:slug/provenance', provenanceHandler);
// alongside other .well-known routes:
app.get('/.well-known/tutorial-provenance/jwks.json', jwksHandler);
```

> **Executor note:** Express 5 route ordering — the `:slug/provenance` path has an extra segment so it will not collide with the single-segment `.md` regex, but it MUST precede the `*slug` wildcard or the wildcard captures `demo/provenance` as the slug. Verify with the test.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project unit test/lib/provenance-endpoint.test.js`
Expected: PASS.

- [ ] **Step 6: srv-qa cp-list audit**

`provenance-handlers.js` is now reachable from `server.js` but NOT from `content-store.js`, so it is not in the content-store transitive set. Still, confirm `.deploy/mta.yaml` `srv-qa` `cp` list includes the four new `srv/lib/provenance-*.js` files if QA boots `server.js`. Add any missing ones.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/provenance-handlers.js srv/server.js test/lib/provenance-endpoint.test.js .deploy/mta.yaml
git commit -m "feat(2245): provenance JWS endpoint + JWKS route"
```

---

### Task 8: Advisory headers on the HTML serve path

**Files:**
- Modify: `srv/lib/content-store.js` (`ContentCache.set/get` to carry advisory meta; both 200 branches of `serveStoredSlug`)
- Test: `test/lib/provenance-headers.test.js` (`cds.test` HTTP)

**Interfaces:**
- Consumes: `isFlagEnabled` (Task 1), `loadProvenanceInputs` + `deriveConfidence` (Tasks 3/6).
- Produces: `X-Freshness-Confidence` and `X-Content-Provenance` headers on `/content/tutorials/:slug` (both cache-miss and cache-hit paths) when the flag is ON.

- [ ] **Step 1: Write the failing test**

```js
// test/lib/provenance-headers.test.js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const b64gz = html => gzipSync(Buffer.from(html)).toString('base64');

describe('advisory provenance headers', () => {
  beforeAll(() => { process.env.CONTENT_API_KEY = 'k'; });
  afterAll(() => __resetFlagsForTest());
  beforeEach(async () => {
    const { ContentCurrent, ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ContentCurrent); await DELETE.from(ContentFiles); await DELETE.from(ContentManifest);
    // publish 'demo' so it is servable (reuse the publish helper/flow from content-store.test.js)
  });

  it('omits headers when flag OFF', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', false);
    const res = await project.axios.get('/content/tutorials/demo');
    expect(res.headers['x-freshness-confidence']).toBeUndefined();
  });

  it('emits headers on cache-miss AND cache-hit when flag ON', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', true);
    const miss = await project.axios.get('/content/tutorials/demo');   // fills LRU
    expect(miss.headers['x-freshness-confidence']).toBe('unknown');
    expect(miss.headers['x-content-provenance']).toBe('/content/tutorials/demo/provenance');
    const hit = await project.axios.get('/content/tutorials/demo');    // LRU hit
    expect(hit.headers['x-content-source']).toBe('cache');
    expect(hit.headers['x-freshness-confidence']).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/lib/provenance-headers.test.js`
Expected: FAIL (headers absent).

- [ ] **Step 3: Implement — carry advisory meta in the LRU and set headers in both branches**

In `srv/lib/content-store.js`:
- Extend `ContentCache.set(key, buffer, hash, advisory)` to store `advisory` on the entry (default `null`); `get` returns it.
- Add a small helper near the top:

```js
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { loadProvenanceInputs } from './provenance-data.js';
import { deriveConfidence } from './provenance-freshness.js';

async function computeAdvisory(slug) {
  if (!isFlagEnabled('PROVENANCE_ENVELOPE_ENABLED')) return null;
  try {
    const inputs = await loadProvenanceInputs(slug);
    if (!inputs) return null;
    return { confidence: deriveConfidence({ report: inputs.report }), url: `/content/tutorials/${slug}/provenance` };
  } catch { return null; }
}

function setAdvisoryHeaders(res, advisory) {
  if (!advisory) return;
  res.setHeader('X-Freshness-Confidence', advisory.confidence);
  res.setHeader('X-Content-Provenance', advisory.url);
}
```

- In the fresh-DB-read branch (~lines 1089–1097): compute `const advisory = await computeAdvisory(slug);`, pass it into `cache.set(slug, decompressed, meta.contentHash, advisory)`, and call `setAdvisoryHeaders(res, advisory)` before `res.send`.
- In the cache-hit branch (~lines 1012–1026): call `setAdvisoryHeaders(res, cached.advisory)` before `res.send` (no DB hit — advisory is whatever was cached; refreshes on next TTL miss, acceptable for a hint).

> **Executor note:** `content-store.js` is the load-bearing content module — keep the new imports lazy-safe. `provenance-data.js` imports `cds` only; no AI SDK. Re-run the `srv-qa` cp-list audit: `provenance-data.js`, `provenance-freshness.js`, and `feature-flags/db-flags.js` are now transitively reachable from `content-store.js` and MUST be in the `srv-qa` `cp` list (`db-flags` already is; add the two `provenance-*` if absent).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/lib/provenance-headers.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full content-store suite to check no regression**

Run: `npx vitest run --project unit test/lib/content-store.test.js`
Expected: PASS (existing serve/publish tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/content-store.js test/lib/provenance-headers.test.js .deploy/mta.yaml
git commit -m "feat(2245): advisory freshness/provenance headers on tutorial serve"
```

---

### Task 9: Thread commit SHA from fetch → publish client

**Files:**
- Modify: `scripts/parsers/github.ts` (surface `lastCommitSha` in the returned metadata already — confirm it reaches `fetch-tutorials.ts`)
- Modify: `scripts/fetch-tutorials.ts` (carry `ghMeta.lastCommitSha` per slug into a commit map written for publish)
- Modify: `scripts/publish-content.ts` (build `sourceCommitsAll`, pass `sourceCommits` in `appendBatch`)
- Modify: `scripts/lib/publish-client.ts` (`appendBatch` forwards `sourceCommits` in the POST body)
- Test: `test/unit/publish-content-source-commit.test.js` (or extend an existing publish-client test)

**Interfaces:**
- Consumes: `lastCommitSha` (git commit SHA) from `fetchGitHubMeta` (Task-independent; already computed).
- Produces: the append POST body carries `sourceCommits: Record<slug, string>`, consumed by Task 4's `appendHandler`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/publish-content-source-commit.test.js
import { describe, it, expect } from 'vitest';
import { buildAppendBody } from '../../scripts/lib/publish-client.ts';

describe('appendBatch body', () => {
  it('includes sourceCommits when provided', () => {
    const body = buildAppendBody({ sessionId: 's', files: { a: 'x' }, sourceCommits: { a: 'sha1' } });
    expect(body.sourceCommits).toEqual({ a: 'sha1' });
  });
  it('omits sourceCommits key cleanly when absent', () => {
    const body = buildAppendBody({ sessionId: 's', files: { a: 'x' } });
    expect(body.sourceCommits).toBeUndefined();
  });
});
```

> If `appendBatch` builds its body inline, extract a pure `buildAppendBody(opts)` helper first (small refactor) so it is unit-testable, then have `appendBatch` call it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/publish-content-source-commit.test.js`
Expected: FAIL (no `buildAppendBody` / no `sourceCommits`).

- [ ] **Step 3: Implement the threading**

- `scripts/lib/publish-client.ts`: add/extract `buildAppendBody(opts)` that spreads `sessionId, files, metadata, bodyTexts, branchSpecs, sources` and conditionally `...(opts.sourceCommits ? { sourceCommits: opts.sourceCommits } : {})`. `appendBatch` POSTs `buildAppendBody(...)`.
- `scripts/fetch-tutorials.ts`: where `ghMeta` is obtained per slug (~line 962–974), record `sourceCommits[slug] = ghMeta.lastCommitSha` into a map available to the publish step (persist alongside the existing publish inputs — mirror how `sourceHashes` is surfaced).
- `scripts/publish-content.ts`: build `sourceCommitsAll` (like `sourcesAll`, ~lines 1166–1168) and pass `sourceCommits: pickEntries(sourceCommitsAll, batch)` in the `appendBatch(...)` call (~lines 1188–1199).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/publish-content-source-commit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/publish-client.ts scripts/fetch-tutorials.ts scripts/publish-content.ts test/unit/publish-content-source-commit.test.js
git commit -m "feat(2245): thread source commit SHA through publish pipeline"
```

---

### Task 10: Docs + operational wiring + full-suite verification

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (add a "Signed provenance envelope" entry)
- Modify: `CLAUDE.md` "Top Gotchas" (one-line pointer, per repo convention)
- Modify: `docs/developers/operations/testing-endpoints.md` (document the two new public endpoints + the flag)

**Interfaces:** none (documentation + verification only).

- [ ] **Step 1: Document the feature**

Add to `tutorials-ims-gotchas.md`: the `PROVENANCE_ENVELOPE_ENABLED` flag (DB config, DEV-first, default OFF), the two endpoints, the `PROVENANCE_SIGNING_KEY` credstore secret (Ed25519 PKCS8 PEM), key-rotation-via-JWKS note, and the fail-open contract. Add the CLAUDE.md one-liner pointing to it. Document endpoints in `testing-endpoints.md` (anonymous, `@requires` not applicable — Express routes, not a CAP service).

- [ ] **Step 2: Generate a DEV signing key + record the credstore step**

Document (do not commit any key) how to generate the key for DEV:

```bash
node -e "import('jose').then(async j=>{const {privateKey}=await j.generateKeyPair('EdDSA',{crv:'Ed25519',extractable:true});console.log(await j.exportPKCS8(privateKey))})"
```

Store the PEM in the target env's BTP Credential Store as `PROVENANCE_SIGNING_KEY` via `/admin-ui/#secrets` (per repo secret-rotation flow). Never in source or `.mtaext`.

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS (all `--project unit` tests, including the new provenance suites and the registry drift test).

- [ ] **Step 4: Production build sanity**

Run: `npx cds build --production > /dev/null && echo BUILD_OK`
Expected: `BUILD_OK` (migration table for `sourceCommit` generated cleanly).

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(2245): signed provenance envelope endpoints, flag, key handling"
```

---

## Self-Review

**Spec coverage:**
- A (JWS/EdDSA) → Tasks 2, 5. *Note:* implemented as compact JWS (JWT via `SignJWT`) rather than flattened JWS — still standard, still `jose`-verifiable; the spec's "flattened" wording is satisfied by an equivalent compact serialization.
- B (confidence derivation) → Task 3 (+ `openMediumCount` sourced in Task 6).
- C (keys + JWKS) → Tasks 2, 7.
- D (endpoint + advisory headers) → Tasks 7, 8; cache-hit correctness → Task 8 Step 3.
- E (sign-on-first-serve + cache keyed by contentHash+runAt) → Task 5.
- F (sourceCommit plumbing) → Tasks 4 (schema/server) + 9 (fetch/client).
- G (flag + fail-open) → Task 1; fail-open asserted in Tasks 2/5/6/7/8.
- H (tests) → each task is TDD; full suite in Task 10.

**Placeholder scan:** No TBD/TODO. Two explicit executor-verification notes (Task 6 slug column / `count(*)`, Task 7 route ordering) are confirm-against-reality checks with concrete fallbacks, not placeholders.

**Type consistency:** `buildEnvelope({slug, contentHash, sourceCommit, builtAt, report, now})` — Task 6's `loadProvenanceInputs` returns exactly `{contentHash, sourceCommit, builtAt, report}`, spread into `buildEnvelope` in Task 7. `report` shape `{status, openHighCount, openMediumCount, runAt, model}` is consistent across Tasks 3/5/6. `getSigningKey()→{key,kid}` and `getJwks()→{keys}` consistent across Tasks 2/5/7. Flag key `'PROVENANCE_ENVELOPE_ENABLED'` consistent across Tasks 1/7/8.
