# Credstore-Backed Runtime Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate MTA env-var deploy for all runtime-tunable configuration. All five SMTP transport fields (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`, `SMTP_PASS`) live in BTP Credential Store, managed via `/admin-ui/#secrets-display`. `REBUILD_TARGET_ENV` mtaext leftover is deleted (already DB-backed via `TenantSettings`). The `process.env` fallbacks in `tenant-settings.js` and `display-settings.js` resolvers are stripped so the admin UI is the sole source of truth.

**Architecture:** Three independent migrations, all using established patterns. (a) Mail client extends the credstore-first lookup it already uses for `SMTP_PASS` to the other 4 SMTP fields via the shared `resolveSecret()` helper. (b) `TenantSettings` and `DisplaySettings` resolvers drop their env-var fallback layer — they were never used in production (the admin tiles have been live since #463) and contradict the "no runtime config from MTA env" principle. (c) The mtaext + GitHub Actions secret + envsubst plumbing for `SMTP_HOST/PORT/USER/FROM` and `REBUILD_TARGET_ENV` is fully removed.

**Tech Stack:** Node.js 22, `@sap/cds` 8, `nodemailer`, BTP Credential Store (mTLS + payload encryption), Vitest, MTA deployment.

---

## Background

The Secrets admin UI at `/admin-ui/#secrets-display` is a generic key/value store backed by BTP Credential Store. The `Secrets` HANA entity at `db/schema.cds:768` stores metadata (key, description, kind, expires, owner). The actual value lives encrypted in credstore and is fetched at runtime via `srv/lib/secret-resolver.js` (credstore → env → cache, 5-min TTL).

Currently only `SMTP_PASS` is wired this way for the mail client. `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` are still read via `process.env.*` in `srv/lib/mail-client.js` — sourced from GitHub Actions secrets, injected into `deploy/<env>.mtaext` via `envsubst` at deploy time. PR #580 shipped with a TODO to consolidate; that follow-up never landed.

A separate gap: `REBUILD_TARGET_ENV` is *already* DB-backed in `TenantSettings` (via #463) — but the mtaext entries for it weren't removed when the resolver was wired. Same for `DASHBOARD_URL`, `ALLOWED_CORS_ORIGINS`, `TECH_USERS`, `TECH_USERS_MAPPING`: the DB tiles exist and are authoritative, but `tenant-settings.js` and `display-settings.js` still consult `process.env` as a fallback. The fallback means a stale env var can mask a fresh admin UI write — confusing, and not what you want.

References:
- Memory: `[[feedback_credstore_preferred_for_all_secrets_and_config]]` — Tom's stated preference (2026-06-23, #545 design): "I want to keep as much of this as possible in the Credstore… Other options are less secure and/or more maintenance overhead."
- Spec: [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](../specs/2026-06-20-runtime-config-research-design.md) — Tier B/C inventory.
- Open follow-up from PR #580 noted in `[[feedback_credstore_preferred_for_all_secrets_and_config]]`.

## What is NOT in scope

- New admin UI work — the Secrets UI is already generic and handles arbitrary keys.
- Changing the `Secrets` entity shape.
- Tier A entities already migrated (`KnowledgeGraphSettings`, `ChatSettings`, `UiEventsSettings`, etc.).
- `EXPOSE_CAP_UI` — DEV-only gate read at boot, not a runtime tunable.
- `CHAT_MODEL_NAME` / `CHAT_DEPLOYMENT_ID` — already DB-backed via `ChatSettings`.
- `SUBMISSION_SALT_SECRET` / `CONTENT_API_KEY` / `GITHUB_DISPATCH_TOKEN` / `TUTORIALS_GITHUB_TOKEN` / `AI_AUTHOR_AICORE_SERVICE_KEY` — already credstore-backed or CI-only.

---

## File Structure

**Modified files:**

| Path | Responsibility | Change |
|---|---|---|
| `srv/lib/mail-client.js` | SMTP transport + send/retry logic | Read all 5 SMTP fields via `resolveSecret()`. Port coerces to number with 587 fallback. |
| `srv/lib/runtime-config/tenant-settings.js` | CORS / rebuild-target-env / tech-users config | Drop `process.env.*` fallback layer. DB → DEFAULTS only. |
| `srv/lib/runtime-config/display-settings.js` | Dashboard URL | Drop `process.env.DASHBOARD_URL` fallback. DB → DEFAULTS only. |
| `scripts/seed-secrets.cjs` | Tracked-secret registry bootstrap | Add 4 SMTP transport rows (HOST/PORT/USER/FROM). **Already applied in this branch.** |
| `mta.yaml` | Base MTA descriptor | Remove `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`, `REBUILD_TARGET_ENV` properties from `tutorials-srv` and `tutorials-srv-qa`. |
| `deploy/dev.mtaext` | DEV env overrides | Remove all 5 entries above. |
| `deploy/qa.mtaext` | QA env overrides | Remove all 5 entries above. |
| `deploy/prod.mtaext` | PROD env overrides | Remove all 5 entries above. |
| `.github/workflows/deploy.yml` | CI deploy pipeline | Remove `SMTP_*` placeholders from `envsubst` allowlist + `env:` block. Remove dummy SMTP test values from non-deploy validate jobs. |
| `docs/developers/operations/smtp-credentials-rotation.md` | SMTP rotation runbook | Rewrite "Non-secret vs Secret" split to "All five fields in credstore." Update troubleshooting table. Remove "redeploy" fix paths. |
| `docs/developers/getting-started.md` | Local dev env var docs | Update SMTP_* row to note credstore as canonical source; env vars are local-dev convenience only. |
| `docs/developers/operations/mta-deployment.md` | MTA deploy runbook | Update the `envsubst` example to drop the 4 SMTP placeholders. |
| `test/unit/mail-client-credstore.test.js` | Unit tests for credstore-first SMTP lookup | Add cases for HOST/PORT/USER/FROM credstore-resolution + env-fallback paths. |
| `test/hybrid/credstore-smtp.test.js` | Hybrid integration test | Extend to assert all 5 fields are read via `resolveSecret()`, not `process.env`. |

**Created files:** None. All work is in existing files.

**Deleted files:** None.

---

## Pre-flight: data state for DEV

**Already done in this branch (do NOT repeat):**

- `scripts/seed-secrets.cjs` has been updated to include 4 new `smtp-config` rows: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`.
- The seed script was executed against DEV HANA (`cf target: tutorial-system / dev`, schema `AC9753D6C4764F5ABE3B3CA4E88233C0`) via `npx cds bind --exec -- node scripts/seed-secrets.cjs --commit`. 4 rows were inserted. They are visible at `/admin-ui/#secrets-display` immediately.

**Verify the inserts succeeded** (use this command before starting Task 1, and before Task 4 deletes the mtaext):

```bash
npx cds bind --exec -- node -e "(async()=>{const cds=require('@sap/cds');const db=await cds.connect.to('db');const rows=await db.run(\"SELECT \\\"KEY\\\" FROM COM_SAP_DEVELOPERS_IMS_SECRETS WHERE \\\"KEY\\\" LIKE 'SMTP_%' ORDER BY \\\"KEY\\\"\");console.log(rows);process.exit(0)})()"
```

Expected output: 5 rows — `SMTP_FROM`, `SMTP_HOST`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_USER`. If any of the 4 new rows are missing, re-run the seed.

**Verify TenantSettings has a `rebuildTargetEnv` row in each environment** (Task 4 deletes the mtaext line that previously set this; the resolver now falls through to `DEFAULTS.rebuildTargetEnv = 'dev'` if the DB row is missing — which would mis-route PROD rebuild dispatches to DEV):

```bash
npx cds bind --exec -- node -e "(async()=>{const cds=require('@sap/cds');const db=await cds.connect.to('db');const rows=await db.run('SELECT REBUILDTARGETENV FROM COM_SAP_DEVELOPERS_IMS_TENANTSETTINGS');console.log(rows);process.exit(0)})()"
```

Run this against DEV / QA / PROD bindings in turn. Expected values:
- DEV: `'dev'`
- QA: `'qa'`
- PROD: `'prod'`

If any environment's row is null/empty or absent, **Task 4 MUST NOT delete the corresponding mtaext line for that env until the DB row is populated via `/admin-ui/#tenantsettings-display`.** This is a hard pre-flight gate.

**The values are not yet pasted in.** The mail-client change in Task 1 below changes the read path; until it ships, the rows are inert metadata-only. After Task 1 deploys, Tom (or whoever owns the rotation) pastes the real values into each row via the admin UI.

For QA and PROD, the seed script runs at deploy time (it's idempotent on `key`, so re-running on a system that already has the rows is a safe no-op).

---

## Task 1: Mail client reads all 5 SMTP fields via credstore-first resolver

**Files:**
- Modify: `srv/lib/mail-client.js:28-72,84-94,128-160`
- Modify: `test/unit/mail-client-credstore.test.js` (add 4 new test cases)

### Background

Today, `srv/lib/mail-client.js` reads `SMTP_PASS` through `resolveSecret('SMTP_PASS', ...)` but reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` straight from `process.env`. We extend the same resolver pattern to all 5 fields. The shared resolver at `srv/lib/secret-resolver.js` already handles cache TTL, credstore-first ordering, env fallback, and warn-once-per-window logging — we just call it 4 more times.

One nuance: `SMTP_PORT` is a number, not a string. Credstore stores strings. The existing code does `Number(process.env.SMTP_PORT) || 587` — we keep that coercion, applied to the resolver's string return.

The transport cache (`_state.transporter`) currently keys off "host is set." After the change, the host is a credstore lookup result. The cache logic stays — but we revalidate every TTL window, so a change in credstore propagates within 5 minutes without restart.

Sub-skill: @superpowers:test-driven-development

- [ ] **Step 1: Write failing test — credstore HOST/PORT/USER/FROM resolution**

Add a new `describe` block to `test/unit/mail-client-credstore.test.js`:

```javascript
describe('mail-client — all 5 SMTP fields via credstore', () => {
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    // Clear all SMTP_* env vars — force credstore as the only source
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_PASS;
    _resetForTests();
    _resetResolver();
    const nodemailer = await import('nodemailer');
    nodemailer.createTransport.mockClear();
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
  });

  it('reads SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM, SMTP_PASS from credstore', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    const nodemailer = await import('nodemailer');
    credstore.readSecret.mockImplementation(async (alias) => ({
      SMTP_HOST: 'relay.credstore.example.com',
      SMTP_PORT: '2587',
      SMTP_USER: 'cs-user',
      SMTP_FROM: 'cs-from@example.com',
      SMTP_PASS: 'cs-pass',
    }[alias] ?? null));

    await _getTransporterForTests();

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport.mock.calls[0][0]).toMatchObject({
      host: 'relay.credstore.example.com',
      port: 2587,
      secure: false,
      auth: { user: 'cs-user', pass: 'cs-pass' },
    });
  });

  it('falls through to process.env when credstore returns null for a non-password field', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    const nodemailer = await import('nodemailer');
    credstore.readSecret.mockResolvedValue(null);
    process.env.SMTP_HOST = 'env.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'env-user';
    process.env.SMTP_FROM = 'env-from@example.com';
    process.env.SMTP_PASS = 'env-pass';

    await _getTransporterForTests();

    expect(nodemailer.createTransport.mock.calls[0][0]).toMatchObject({
      host: 'env.example.com',
      port: 465,
      secure: true,    // 465 is the implicit-TLS port
      auth: { user: 'env-user', pass: 'env-pass' },
    });
  });

  it('returns null transport when SMTP_HOST is missing from both credstore and env', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockResolvedValue(null);
    // process.env.SMTP_HOST is already deleted in beforeEach

    const transport = await _getTransporterForTests();
    expect(transport).toBeNull();
  });

  it('coerces non-numeric SMTP_PORT to default 587', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    const nodemailer = await import('nodemailer');
    credstore.readSecret.mockImplementation(async (alias) => ({
      SMTP_HOST: 'relay.example.com',
      SMTP_PORT: 'not-a-number',
      SMTP_USER: 'u',
      SMTP_FROM: 'f@e.com',
      SMTP_PASS: 'p',
    }[alias] ?? null));

    await _getTransporterForTests();

    expect(nodemailer.createTransport.mock.calls[0][0]).toMatchObject({
      port: 587,
      secure: false,
    });
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
npx vitest run test/unit/mail-client-credstore.test.js
```

Expected: the 4 new tests fail with assertion errors showing `host: 'smtp.example.com'` (the leftover env-var-only read from existing tests' `beforeEach`) instead of the credstore mock values. The pre-existing 4 tests still pass.

- [ ] **Step 3: Implement — extend `_state` with `fromAddress` (Edit A)**

In `srv/lib/mail-client.js`, find the `_state` initializer block (currently lines 19-22):

```javascript
const _state = (globalThis[STATE_KEY] ??= {
  transporter: null,
  resolvedAt: 0,
});
```

Replace with:

```javascript
const _state = (globalThis[STATE_KEY] ??= {
  transporter: null,
  resolvedAt: 0,
  fromAddress: null,
});
```

- [ ] **Step 4: Implement — replace `resolveSmtpPassword` and `getTransporter` body (Edit B)**

Find this block in `srv/lib/mail-client.js` (currently lines 24-72 — the helper plus the entire `getTransporter` function):

```javascript
/**
 * Resolve the SMTP password via the shared secret-resolver (credstore-first,
 * env fallback, 5-min TTL cache, warn-once-per-window logging).
 */
async function resolveSmtpPassword() {
  return resolveSecret('SMTP_PASS', { ttlMs: SMTP_TTL_MS, logTag: '[mail]' });
}

async function getTransporter() {
  if (_state.transporter && Date.now() - _state.resolvedAt < SMTP_TTL_MS) {
    return _state.transporter;
  }

  const host = process.env.SMTP_HOST;
  if (host) {
    const password = await resolveSmtpPassword();
    if (!password) return null;
    _state.transporter = createTransport({
      host,
      // Default port shifts from 1025 (MailHog dev default) to 587 (SMTP
      // submission). Local dev still works by setting SMTP_PORT=1025 explicitly.
      // Spec edge case #8 covers the MailHog flow.
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: password },
    });
    _state.resolvedAt = Date.now();
    return _state.transporter;
  }

  // Legacy fallback: managed mail-service binding tagged 'mail'. No project
  // today binds one — kept as an escape hatch if SAP Cloud Mail Service or a
  // similar managed offering ever appears in the subaccount entitlements.
  try {
    const xsenv = await import('@sap/xsenv');
    xsenv.default.loadEnv();
    const creds = xsenv.default.serviceCredentials({ tag: 'mail' });
    _state.transporter = createTransport({
      host: creds.mail_host,
      port: creds.mail_port,
      secure: creds.mail_port === 465,
      auth: { user: creds.mail_user, pass: creds.mail_password },
    });
    _state.resolvedAt = Date.now();
    return _state.transporter;
  } catch {
    return null;
  }
}
```

Replace with:

```javascript
const SMTP_ALIASES = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_FROM', 'SMTP_PASS'];

/**
 * Resolve all 5 SMTP transport fields via the shared secret-resolver (credstore-first,
 * env fallback, 5-min TTL cache, warn-once-per-window logging). Returns `null` for any
 * field the resolver couldn't find.
 */
async function resolveSmtpConfig() {
  const entries = await Promise.all(
    SMTP_ALIASES.map((alias) =>
      resolveSecret(alias, { ttlMs: SMTP_TTL_MS, logTag: '[mail]' }).then((v) => [alias, v]),
    ),
  );
  return Object.fromEntries(entries);
}

async function getTransporter() {
  if (_state.transporter && Date.now() - _state.resolvedAt < SMTP_TTL_MS) {
    return _state.transporter;
  }

  const cfg = await resolveSmtpConfig();
  if (cfg.SMTP_HOST) {
    if (!cfg.SMTP_PASS) return null;
    // Default port shifts from 1025 (MailHog dev default) to 587 (SMTP submission).
    // Local dev still works by setting SMTP_PORT=1025 in the resolver source.
    const port = Number(cfg.SMTP_PORT) || 587;
    _state.transporter = createTransport({
      host: cfg.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    });
    _state.fromAddress = cfg.SMTP_FROM || DEFAULT_FROM;
    _state.resolvedAt = Date.now();
    return _state.transporter;
  }

  // Legacy fallback: managed mail-service binding tagged 'mail'. No project
  // today binds one — kept as an escape hatch if SAP Cloud Mail Service or a
  // similar managed offering ever appears in the subaccount entitlements.
  try {
    const xsenv = await import('@sap/xsenv');
    xsenv.default.loadEnv();
    const creds = xsenv.default.serviceCredentials({ tag: 'mail' });
    _state.transporter = createTransport({
      host: creds.mail_host,
      port: creds.mail_port,
      secure: creds.mail_port === 465,
      auth: { user: creds.mail_user, pass: creds.mail_password },
    });
    _state.fromAddress = DEFAULT_FROM;
    _state.resolvedAt = Date.now();
    return _state.transporter;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Implement — replace `from: process.env.SMTP_FROM` in `sendNotificationEmail` (Edit C)**

Find the `sendNotificationEmail` function's `mailOptions` block (currently line 88-94 area):

```javascript
  const mailOptions = {
    from: process.env.SMTP_FROM || DEFAULT_FROM,
    to: Array.isArray(to) ? to.join(', ') : to,
```

Replace with:

```javascript
  // getTransporter() populates _state.fromAddress before returning. If we
  // got here via the no-transport-configured path, fromAddress stays null
  // and DEFAULT_FROM kicks in (matches pre-refactor behavior).
  const transport = await getTransporter();
  const mailOptions = {
    from: _state.fromAddress || DEFAULT_FROM,
    to: Array.isArray(to) ? to.join(', ') : to,
```

Then, lower in the same function, find:

```javascript
  try {
    const transport = await getTransporter();
    if (!transport) {
```

And remove the `const transport = await getTransporter();` line (since we moved it above the mailOptions block). The result is:

```javascript
  try {
    if (!transport) {
```

- [ ] **Step 6: Implement — replace `from: process.env.SMTP_FROM` in `retryFailedEmails` (Edit D)**

In `retryFailedEmails`, find the per-message send block (currently lines 140-147 area):

```javascript
    try {
      const transport = await getTransporter();
      await transport.sendMail({
        from: process.env.SMTP_FROM || DEFAULT_FROM,
        to: msg.to,
```

Replace with:

```javascript
    try {
      const transport = await getTransporter();
      await transport.sendMail({
        from: _state.fromAddress || DEFAULT_FROM,
        to: msg.to,
```

- [ ] **Step 7: Implement — extend `_resetForTests` (Edit E)**

Find the test-only reset function (currently lines 163-166):

```javascript
/** Test-only: clear cached transporter so unit tests can swap credstore mocks. */
export function _resetForTests() {
  _state.transporter = null;
  _state.resolvedAt = 0;
}
```

Replace with:

```javascript
/** Test-only: clear cached transporter so unit tests can swap credstore mocks. */
export function _resetForTests() {
  _state.transporter = null;
  _state.resolvedAt = 0;
  _state.fromAddress = null;
}
```

- [ ] **Step 8: Run all mail-client tests; verify both new and old pass**

```bash
npx vitest run test/unit/mail-client-credstore.test.js
```

Expected: all 8 tests pass (4 original + 4 new).

**Why the existing 4 tests still pass:** they set `process.env.SMTP_HOST/USER/FROM` in the file-level `beforeEach` and mock `credstore.readSecret` to return null (or a specific `SMTP_PASS`). After the refactor, `resolveSecret('SMTP_HOST', ...)` hits the resolver's env-fallback path and returns the same env value the old `process.env.SMTP_HOST` read did. The behavior is identical at the test seam — only the read mechanism moved.

- [ ] **Step 9: Run the full unit suite**

```bash
npx vitest run
```

Expected: green. If anything else relied on the `process.env.SMTP_FROM` read path inside `sendNotificationEmail` / `retryFailedEmails`, fix the test (it should set the env var the resolver reads, or use `_primeForTests` from the resolver).

- [ ] **Step 10: Commit**

```bash
git add srv/lib/mail-client.js test/unit/mail-client-credstore.test.js
git commit -m "feat(mail): resolve all 5 SMTP fields via credstore-first resolver"
```

---

## Task 2: Hybrid test — credstore-only SMTP resolution against real binding

**Files:**
- Modify: `test/hybrid/credstore-smtp.test.js`

### Background

The existing hybrid test ([test/hybrid/credstore-smtp.test.js](../../../test/hybrid/credstore-smtp.test.js)) is the canonical end-to-end credstore guard for this project — it write/read/delete-round-trips a single test alias against the REAL BTP credstore binding to catch JWE / mTLS / payload-encryption drift. The file is small (70 lines) and intentionally generic — the alias name `SMTP_PASS_HYBRID_TEST` is historical, not load-bearing.

We add ONE new `it()` block: a real-credstore round-trip that proves all 5 SMTP aliases can be written and read back through the same code path the mail-client uses. We deliberately use real `writeSecret` / `readSecret` (NOT `_primeForTests`) so the test exercises mTLS + payload encryption — that's the entire point of the hybrid suite and the lesson from the 5-PR Secrets spiral.

**Important: no `skipIf` guard exists in this file today.** If credstore is unreachable from the test runner, the test fails (which is correct — CI runs against a live binding via `cds bind --exec`, and a missing binding there is a real failure). For local runs without a binding, developers skip the hybrid suite entirely via `npm test` rather than `npm run test:hybrid`.

The write-safety guard at `test/hybrid/_guard.js` requires `ALLOW_HYBRID_WRITES=true` before any test writes. The existing tests in this file already write — so the guard either passes for the whole file or skips it. The new test inherits that behavior.

- [ ] **Step 1: Read the existing hybrid test to confirm the patterns**

```bash
cat test/hybrid/credstore-smtp.test.js
```

Note:
- `beforeAll` imports credstore dynamically (avoids module-load failures when binding is absent).
- `afterAll` calls `deleteSecret(TEST_ALIAS)` — best-effort cleanup, idempotent.
- Tests use a unique `TEST_ALIAS` (currently `SMTP_PASS_HYBRID_TEST`) per file to avoid clashing with real aliases.

- [ ] **Step 2: Append a new `it()` block exercising all 5 SMTP aliases**

Append after the existing `it('round-trips a multi-line value...')` block, BEFORE the closing `});` of the `describe`:

```javascript
it('write→read round-trips all 5 SMTP transport aliases (mail-client surface area)', async () => {
  // Five aliases mirroring the production set. Using __TEST__ prefix + pid so
  // these don't clash with real SMTP_HOST/PORT/USER/FROM/PASS rows in the
  // credstore (which production tutorials-srv reads at startup).
  const aliases = [
    `__TEST__SMTP_HOST_${process.pid}`,
    `__TEST__SMTP_PORT_${process.pid}`,
    `__TEST__SMTP_USER_${process.pid}`,
    `__TEST__SMTP_FROM_${process.pid}`,
    `__TEST__SMTP_PASS_${process.pid}`,
  ];
  const values = [
    'hybrid.smtp.example.com',
    '2587',
    'hybrid-user',
    'hybrid-from@example.com',
    'hybrid-pass-secret',
  ];
  try {
    // Write all 5 sequentially. Parallel would shave a few hundred ms but
    // would also exercise the credstore's rate-limit; serial keeps this
    // test boring and reliable.
    for (let i = 0; i < aliases.length; i++) {
      await credstore.writeSecret(aliases[i], values[i]);
    }
    // Read all 5 back; assert exact-match.
    for (let i = 0; i < aliases.length; i++) {
      const got = await credstore.readSecret(aliases[i]);
      expect(got).toBe(values[i]);
    }
  } finally {
    // Best-effort cleanup — even if an assertion above fails, we want the
    // test aliases gone so the next run isn't polluted. deleteSecret is
    // idempotent.
    for (const alias of aliases) {
      try { await credstore.deleteSecret(alias); } catch { /* swallow */ }
    }
  }
});
```

This test specifically asserts the credstore round-trip for 5 distinct aliases. It does NOT call into the mail-client (that's Task 1's unit-test job). Its purpose is to ensure platform plumbing (mTLS, JWE payload encryption, namespace scoping) works for ALL 5 keys, not just the one historically-tested alias.

- [ ] **Step 3: Run the hybrid suite against the live binding**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- credstore-smtp 2>&1 | tail -30
```

Expected: 5 tests pass (4 existing + 1 new). If credstore is unreachable from your local network, the test will fail with a connect error (not skip — that's the contract for hybrid tests).

If you see `wrong_content_type_for_jwe` or `415` errors, the binding is on a newer subaccount that requires payload-encryption-enabled JWE bodies; `srv/lib/credstore.js` already handles this (PR #588), so a failure here is a regression to investigate before merging.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/credstore-smtp.test.js
git commit -m "test(hybrid): round-trip all 5 SMTP aliases through live credstore"
```

---

## Task 3: Strip env-var fallback from TenantSettings + DisplaySettings resolvers

**Files:**
- Modify: `srv/lib/runtime-config/tenant-settings.js:50-77`
- Modify: `srv/lib/runtime-config/display-settings.js:46-61`
- Modify: `test/unit/` — new file `test/unit/tenant-settings-resolver.test.js` if it does not exist; otherwise update.
- Modify: `test/unit/` — new file `test/unit/display-settings-resolver.test.js` if it does not exist; otherwise update.

### Background

These two resolvers are the live consumers for Tier B config. Today their chain is `DB row → env var → hardcoded default`. The env-var fallback contradicts the "admin UI is sole source of truth" principle: an operator could set a stale `cf set-env ALLOWED_CORS_ORIGINS ...` that masks a fresh write through the admin UI for up to the next restart. Stripping the env layer removes that confusion class entirely.

After the change, the chain is `DB row → hardcoded default`. The default values stay as they are today — they're the same literal strings the resolvers ship with, used at very-cold-boot when the DB itself is unreachable.

Sub-skill: @superpowers:test-driven-development

- [ ] **Step 1: Write failing test — tenant-settings env fallback removed**

Create or update `test/unit/tenant-settings-resolver.test.js`. The test should:

1. Mock `cds.connect.to('db')` and `cds.entities` so `readRow()` returns `null` (no DB row).
2. Set `process.env.ALLOWED_CORS_ORIGINS = 'http://from-env'`.
3. Call `resolveTenantSettings()`.
4. Expect `allowedCorsOrigins` to equal the DEFAULT, NOT `'http://from-env'`.

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@sap/cds', async () => {
  const actual = await vi.importActual('@sap/cds');
  return {
    ...actual,
    default: {
      ...actual.default,
      log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      entities: () => { throw new Error('no entities'); }, // force fallback path
      connect: { to: vi.fn(async () => ({ run: vi.fn(async () => []) })) },
    },
  };
});

import { resolveTenantSettings, _resetCacheForTests } from '../../srv/lib/runtime-config/tenant-settings.js';

describe('tenant-settings resolver — env fallback removed', () => {
  beforeEach(() => {
    _resetCacheForTests();
    delete process.env.ALLOWED_CORS_ORIGINS;
    delete process.env.REBUILD_TARGET_ENV;
    delete process.env.TECH_USERS;
    delete process.env.TECH_USERS_MAPPING;
  });

  it('returns hardcoded default when DB has no row, ignoring env vars', async () => {
    process.env.ALLOWED_CORS_ORIGINS = 'http://from-env';
    process.env.REBUILD_TARGET_ENV = 'prod-from-env';
    const settings = await resolveTenantSettings();
    expect(settings.allowedCorsOrigins).toBe('http://localhost:1313,http://localhost:5000,http://localhost:4004');
    expect(settings.rebuildTargetEnv).toBe('dev');
  });
});
```

- [ ] **Step 2: Run; verify failure (env-fallback still active)**

```bash
npx vitest run test/unit/tenant-settings-resolver.test.js
```

Expected: assertion fails — `allowedCorsOrigins` resolves to `'http://from-env'` because today's resolver still consults `process.env`.

- [ ] **Step 3: Implement — strip env fallback from tenant-settings.js**

Edit `srv/lib/runtime-config/tenant-settings.js`:

1. Delete the `envString()` helper at lines 50-53 (no longer used).
2. Remove the `?? envString('ALLOWED_CORS_ORIGINS')` etc. clauses at lines 63, 67, 71, 75. The chain becomes `pick(row, ...) ?? DEFAULTS.<field>` directly.

After the edit, lines 60-77 should read:

```javascript
const settings = {
  allowedCorsOrigins:
    pick(row, 'allowedCorsOrigins', 'ALLOWEDCORSORIGINS')
    ?? DEFAULTS.allowedCorsOrigins,
  rebuildTargetEnv:
    pick(row, 'rebuildTargetEnv', 'REBUILDTARGETENV')
    ?? DEFAULTS.rebuildTargetEnv,
  techUsers:
    pick(row, 'techUsers', 'TECHUSERS')
    ?? DEFAULTS.techUsers,
  techUsersMapping:
    pick(row, 'techUsersMapping', 'TECHUSERSMAPPING')
    ?? DEFAULTS.techUsersMapping,
};
```

Add a top-of-file comment explaining the shape change:

```javascript
// srv/lib/runtime-config/tenant-settings.js
// Resolves the tenant-wide config bag: CORS origins, rebuild target env,
// tech-user JSON config, tech-user mapping. Special-shape fields stored
// as raw String/LargeString — consumers keep their existing parse logic.
//
// CHAIN: DB row -> hardcoded DEFAULTS. NO env-var fallback (deliberately
// removed in #<this PR>). The admin UI at /admin-ui/#tenantsettings-display
// is the sole source of truth for these values; env vars would create a
// silent-shadow class of bug where a stale `cf set-env` could mask a fresh
// admin-UI write until the next app restart.
```

- [ ] **Step 4: Run tenant-settings tests; verify green**

```bash
npx vitest run test/unit/tenant-settings-resolver.test.js
```

Expected: pass.

- [ ] **Step 5: Repeat steps 1-4 for `display-settings.js`**

Create `test/unit/display-settings-resolver.test.js` with the analogous test (mock no DB row, set `process.env.DASHBOARD_URL = 'http://env-dashboard'`, expect the resolver to return the hardcoded default URL — explicitly `'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard'`, NOT `'http://env-dashboard'`).

Then strip the env-fallback from `display-settings.js:46-61` the same way — delete `envString`, drop the `?? envString('DASHBOARD_URL')` clause, leave only `pick(row, ...) ?? DEFAULTS.dashboardUrl`.

- [ ] **Step 6: Run the full unit suite**

```bash
npx vitest run
```

Expected: green. Look specifically for any tests that *relied* on the env fallback being live — they'll surface here and need updates to set the value through the DB-row mock instead.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/runtime-config/tenant-settings.js srv/lib/runtime-config/display-settings.js \
        test/unit/tenant-settings-resolver.test.js test/unit/display-settings-resolver.test.js
git commit -m "refactor(runtime-config): remove env-var fallback from tenant + display resolvers"
```

---

## Task 4: Remove SMTP_* and REBUILD_TARGET_ENV from MTA descriptors

**Files:**
- Modify: `mta.yaml:90-110`
- Modify: `.deploy/mta.yaml:80-90` (same shape, second copy)
- Modify: `deploy/dev.mtaext`
- Modify: `deploy/qa.mtaext`
- Modify: `deploy/prod.mtaext`

### Background

`mta.yaml` declares property defaults for the `tutorials-srv` (and `tutorials-srv-qa`) modules. `deploy/<env>.mtaext` overrides them at deploy time. MTA's descriptor-merge rules require a base property to exist in `mta.yaml` before an mtaext can set it — and the `cf deploy -e` flow processes each mtaext through `envsubst` first, so an unsubstituted `${SMTP_HOST}` survives in the YAML and parses as a literal string.

After the SMTP fields move to credstore, none of these declarations are needed. Removing them simplifies the descriptor and avoids the "did I forget to set the GitHub Actions secret?" footgun.

The `.deploy/mta.yaml` file is a duplicate that's used by some manual local-build flows — keep both copies in sync.

- [ ] **Step 1: Edit `mta.yaml` — `tutorials-srv` module**

Remove these lines (~line 90-110):

```yaml
      REBUILD_TARGET_ENV: ""
      # Author-nudge SMTP transport (#545). Empty defaults mean the cron is
      # dormant — mail-client.js's resolveSmtpConfig returns null, the
      # sendNotificationEmail path queues to FailedEmails, and the 4-hour
      # retry cron picks up once mtaext + credstore supply real values.
      # Non-secret knobs ride here; SMTP_PASS lives in credstore (alias same name).
      SMTP_HOST: ""
      SMTP_PORT: "587"
      SMTP_USER: ""
      SMTP_FROM: "developers@sap.com"
```

- [ ] **Step 2: Verify the `tutorials-srv-qa` module is unaffected**

Despite there being a `tutorials-srv-qa` module in `mta.yaml`, the SMTP_* / REBUILD_TARGET_ENV properties only ever existed in the `tutorials-srv` module (the QA srv doesn't send mail and doesn't dispatch rebuilds). Confirm with:

```bash
sed -n '/^  - name: tutorials-srv-qa$/,/^  - name:/p' mta.yaml | grep -E "SMTP_|REBUILD_TARGET_ENV" || echo "OK — no SMTP/REBUILD lines in tutorials-srv-qa"
```

Expected output: `OK — no SMTP/REBUILD lines in tutorials-srv-qa`. If anything matches, delete those lines too.

- [ ] **Step 3: Repeat the verification + (if needed) deletion in `.deploy/mta.yaml`**

The `.deploy/mta.yaml` is a separate copy used by some manual local-build flows. Check both modules:

```bash
grep -nE "SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_FROM|REBUILD_TARGET_ENV" .deploy/mta.yaml
```

Delete the matching lines (likely only in `tutorials-srv`, mirror the Step 1 edit).

- [ ] **Step 4: Edit `deploy/dev.mtaext`**

Today (lines 11-15):

```yaml
      REBUILD_TARGET_ENV: dev
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USER: ${SMTP_USER}
      SMTP_FROM: ${SMTP_FROM}
```

Remove all 5 lines.

- [ ] **Step 5: Edit `deploy/qa.mtaext` and `deploy/prod.mtaext`**

Same removal — find lines 11-15 (qa) and 12-16 (prod) and delete the same 5 entries.

- [ ] **Step 6: Verify the mtaext files still parse**

```bash
for f in deploy/dev.mtaext deploy/qa.mtaext deploy/prod.mtaext; do
  echo "=== $f ==="
  yq '.' "$f" | head -30
done
```

Expected: each file shows valid YAML with the SMTP / REBUILD_TARGET_ENV entries gone; the GITHUB_DISPATCH_TOKEN, CONTENT_API_KEY (if present), and KNOWLEDGE_GRAPH_ENABLED entries are unchanged.

- [ ] **Step 7: Commit**

```bash
git add mta.yaml .deploy/mta.yaml deploy/dev.mtaext deploy/qa.mtaext deploy/prod.mtaext
git commit -m "chore(mta): remove SMTP_* and REBUILD_TARGET_ENV env-var declarations"
```

---

## Task 5: Clean up GitHub Actions deploy workflow

**Files:**
- Modify: `.github/workflows/deploy.yml`

### Background

The deploy workflow has TWO `envsubst` invocations:
- **Line 42** — validate job (`Verify envsubst resolves all known placeholders`). This one CURRENTLY includes `$SMTP_HOST $SMTP_PORT $SMTP_USER $SMTP_FROM` and needs the SMTP placeholders removed.
- **Line 368** — actual deploy step. This one is ALREADY clean (only references `$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN`). **Do not modify.**

There's also a `secrets.SMTP_*` block at line 358-361 (the deploy job's env block) that needs the 4 SMTP lines removed, and a dummy SMTP block at line 34-37 (validate job's env block) supplying placeholder values to satisfy envsubst — those become orphans once line 42 is fixed.

- [ ] **Step 1: Remove SMTP placeholders from line 42 (validate job's `envsubst` allowlist)**

The file today has TWO `envsubst` lines. The one at **line 42** reads:

```yaml
            envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN $SMTP_HOST $SMTP_PORT $SMTP_USER $SMTP_FROM' \
```

Replace with:

```yaml
            envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
```

The other `envsubst` (line 368) is already clean — leave it alone. If your `Edit` operation fails on non-unique `old_string`, that's because both lines now have identical content; that's fine, both should match the new form, and `replace_all: true` would be safe here.

- [ ] **Step 2: Remove dummy SMTP values from the validate job's `env:` block (lines 34-37)**

Today the validate job has dummy values to keep envsubst from failing on undefined placeholders:

```yaml
          SMTP_HOST: dummy-smtp.example.com
          SMTP_PORT: "587"
          SMTP_USER: dummy-user
          SMTP_FROM: dummy@example.com
```

With Step 1 done, these placeholders are no longer in the envsubst allowlist. Delete all 4 lines.

- [ ] **Step 3: Remove `SMTP_*` from the deploy job's `env:` block (lines 358-361)**

Today the deploy job has:

```yaml
          SMTP_HOST: ${{ secrets.SMTP_HOST }}
          SMTP_PORT: ${{ secrets.SMTP_PORT }}
          SMTP_USER: ${{ secrets.SMTP_USER }}
          SMTP_FROM: ${{ secrets.SMTP_FROM }}
```

Delete all 4 lines.

- [ ] **Step 4: Grep for any other SMTP_HOST/PORT/USER/FROM reference in the workflow**

```bash
grep -n "SMTP_HOST\|SMTP_PORT\|SMTP_USER\|SMTP_FROM" .github/workflows/deploy.yml
```

Expected: empty output. If anything remains, it's likely a comment — remove for cleanliness.

- [ ] **Step 5: Validate the workflow syntactically**

```bash
yq '.jobs | keys' .github/workflows/deploy.yml
```

Expected: lists all jobs without error. (`actionlint` is even better if installed.)

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "chore(ci): drop SMTP_* placeholders from envsubst allowlist + secrets"
```

The GitHub Actions repository secrets (`SMTP_HOST/PORT/USER/FROM`) are no longer referenced by any workflow after this commit. They can be archived/deleted from the repo Settings → Secrets and variables → Actions UI in a separate housekeeping pass. The `SMTP_PASS` secret was never in the workflow (it lives in credstore today).

---

## Task 6: Update SMTP credentials rotation runbook

**Files:**
- Modify: `docs/developers/operations/smtp-credentials-rotation.md`

### Background

The runbook currently documents the "non-secret vs secret" split. After this PR, all 5 fields are credstore-resident. Rewrite the relevant sections.

- [ ] **Step 1: Replace the intro (lines 1-16)**

Replace with:

```markdown
# SMTP Credentials Rotation Runbook

The author-nudge cron in `tutorials-srv` sends mail via SMTP. All five
transport fields — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`,
and `SMTP_PASS` — live in BTP Credential Store and are managed through
the admin Secrets UI at `/admin-ui/#secrets-display`. No values are
sourced from `cf set-env`, mtaext, or GitHub Actions secrets in normal
operation; those paths exist only as emergency overrides (see
"Disaster recovery" below).

The mail client at [srv/lib/mail-client.js](../../../srv/lib/mail-client.js)
reads all 5 fields via the shared
[secret-resolver](../../../srv/lib/secret-resolver.js): credstore-first,
process-env fallback, 5-min TTL cache, warn-once-per-window logging. A
rotation through the admin UI propagates within 5 minutes — no app
restart needed.
```

- [ ] **Step 2: Rewrite the troubleshooting table (lines 65-72)**

Replace the "Update GitHub Actions secret + redeploy" guidance with credstore-UI rewrites:

```markdown
| Symptom | Likely cause | Fix |
|---|---|---|
| `535 Authentication failed` | Wrong `SMTP_PASS` in credstore | Re-paste, ensure no trailing whitespace |
| `535` with the right password | Wrong username in `SMTP_USER` | Update `SMTP_USER` row in /admin-ui/#secrets-display |
| `ECONNREFUSED` | Wrong relay host or port | Update `SMTP_HOST` / `SMTP_PORT` row in /admin-ui/#secrets-display |
| `550 sender rejected` | Wrong `SMTP_FROM`, not authorized to send as that address | Update `SMTP_FROM` row in /admin-ui/#secrets-display |
| `No mail transport configured` log | Credstore returned null for SMTP_HOST AND env has no fallback | Confirm /admin-ui/#secrets-display has a non-empty SMTP_HOST value |
```

- [ ] **Step 3: Rewrite the "First-time cutover" section (lines 87-99)**

```markdown
## First-time cutover (when SMTP fields do not yet exist)

This is the one-time sequence for enabling author-nudge emails on a fresh deploy:

1. Open `/admin-ui/#secrets-display` and confirm rows for `SMTP_HOST`, `SMTP_PORT`,
   `SMTP_USER`, `SMTP_FROM`, `SMTP_PASS` exist. (They are seeded by
   `scripts/seed-secrets.cjs` at deploy time. If missing, run
   `npx cds bind --exec -- node scripts/seed-secrets.cjs --commit` once.)
2. Paste real values into each row via "Set Value" / "Update Value."
3. Verify with the "Test Notification Email" action (see Step 3 above).
4. Flip the `isNotificationSendingAllowed` flag in `/admin-ui/#operations-display`.
```

- [ ] **Step 4: Rewrite the "Disaster recovery" section (lines 101-109)**

```markdown
## Disaster recovery — credstore is down

The mail-client falls through to `process.env.SMTP_HOST` etc. if credstore
throws. If you absolutely must send mail during a credstore outage:

```bash
cf set-env tutorials-srv SMTP_HOST <value>
cf set-env tutorials-srv SMTP_PORT <value>
cf set-env tutorials-srv SMTP_USER <value>
cf set-env tutorials-srv SMTP_FROM <value>
cf set-env tutorials-srv SMTP_PASS <value>
cf restart tutorials-srv
```

Once credstore is back, remove the overrides:

```bash
cf unset-env tutorials-srv SMTP_HOST
# ... repeat for the other 4 fields
cf restart tutorials-srv
```

The credstore values resume precedence within 5 minutes.

> **Caveat:** `cf set-env` values do NOT survive the next MTA redeploy
> ([feedback_cf_set_env_drops_on_redeploy](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cf_set_env_drops_on_redeploy.md)).
> Use only as a short-term emergency override.
```

- [ ] **Step 5: Verify the docs build with no dead links**

```bash
npm run docs:build 2>&1 | tail -30
```

Expected: no `404` / `dead link` errors. The VitePress dead-link check runs in `predocs:build`.

- [ ] **Step 6: Commit**

```bash
git add docs/developers/operations/smtp-credentials-rotation.md
git commit -m "docs(smtp): rewrite runbook for all-credstore configuration"
```

---

## Task 7: Update getting-started + MTA deployment docs

**Files:**
- Modify: `docs/developers/getting-started.md`
- Modify: `docs/developers/operations/mta-deployment.md`

### Background

`getting-started.md` lists `SMTP_HOST/PORT/USER/PASS` as env vars for local dev — keep the entry but reframe: env vars are still the easy way to wire MailHog locally; in deployed environments, all values live in credstore.

`mta-deployment.md` has an `envsubst` example that includes `$SMTP_HOST` etc. — drop those from the example.

- [ ] **Step 1: Update `getting-started.md` SMTP row (line 75)**

Replace:

```markdown
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | No | — | SMTP transport for local email testing (e.g., MailHog) |
```

With:

```markdown
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | No | — | SMTP transport for local email testing (e.g., MailHog). In deployed environments these live in BTP Credential Store, managed via /admin-ui/#secrets-display — see [SMTP rotation runbook](operations/smtp-credentials-rotation.md). |
```

- [ ] **Step 2: Update `mta-deployment.md` envsubst example (line 216)**

Find:

```bash
GITHUB_DISPATCH_TOKEN="" SMTP_HOST="" ... envsubst '...' < deploy/dev.mtaext > deploy/dev.resolved.mtaext
```

Replace the entire example with the simpler post-cleanup form:

```bash
GITHUB_DISPATCH_TOKEN="$YOUR_PAT" \
CONTENT_API_KEY="$YOUR_CONTENT_KEY" \
REBUILD_API_KEY="$YOUR_REBUILD_KEY" \
APPROUTER_URL="$YOUR_APPROUTER_URL" \
envsubst '$GITHUB_DISPATCH_TOKEN $CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext
```

Add a note immediately below the example:

```markdown
> **Note (2026-06-25):** SMTP transport config (`SMTP_HOST/PORT/USER/FROM/PASS`)
> and `REBUILD_TARGET_ENV` formerly rode through `envsubst` here. They now live
> in BTP Credential Store / `TenantSettings`, respectively, and are managed via
> the admin UI. The envsubst allowlist above is the complete remaining set.
```

- [ ] **Step 3: Verify the docs site builds**

```bash
npm run docs:build 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add docs/developers/getting-started.md docs/developers/operations/mta-deployment.md
git commit -m "docs: update getting-started + MTA deployment for credstore-only SMTP"
```

---

## Task 8: Pre-deploy data state for QA + PROD

**Files:** None modified. Operational task.

### Background

DEV is already seeded (4 SMTP_* rows). QA and PROD haven't been touched. The `scripts/seed-secrets.cjs` change in this branch will be picked up when the PR merges and the next deploy runs — but we need the metadata rows in place on QA + PROD *before* the mail-client change takes effect there, otherwise the admin UI won't show the rows to paste into.

The seed script is idempotent on `key`, so it's safe to run against any environment.

This task documents the operational sequence; it does NOT modify code.

- [ ] **Step 1: After merge and DEV deploy, verify the 4 rows still exist**

```bash
cf target -s dev
# Open https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/#secrets-display
# Confirm SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM rows visible.
```

- [ ] **Step 2: Paste real values into the 4 DEV rows (Tom)**

For each row: click → "Set Value" → paste the real value → Save. Suggested values (mirror what's in the current GitHub Actions secrets):

| Key | DEV value |
|---|---|
| `SMTP_HOST` | (the smtpauth.mail.net.sap host) |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | (the relay user) |
| `SMTP_FROM` | `developers@sap.com` |

- [ ] **Step 3: Trigger the DEV deploy** (or wait for the merge to trigger it).

- [ ] **Step 4: Verify post-deploy that mail still works**

```bash
curl -X POST "$DEV_APPROUTER_URL/admin/testNotificationEmail" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "thomas.jung@sap.com", "level": 0}'
```

Expected: `{"success": true, "error": ""}`. Check inbox.

- [ ] **Step 5: Repeat steps 1-4 for QA**

For QA, after the seed runs at deploy time, paste QA-specific values (same `SMTP_HOST/USER/FROM`; QA might use a different sender address — confirm with Tom).

- [ ] **Step 6: Repeat steps 1-4 for PROD when cutover is approved**

PROD cutover is scheduled for end-of-July 2026 per `[[project_prod_cutover_july_2026]]`. Coordinate with Tom before running.

- [ ] **Step 7: No commit — operational only**

---

## Verification

After all 8 tasks ship:

- [ ] **Unit tests green:** `npx vitest run` — all 8 mail-client tests + new resolver tests pass.
- [ ] **Hybrid tests green:** `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- credstore-smtp tenant-settings display-settings` — credstore round-trip works against real binding.
- [ ] **Smoke tests green** (post-deploy): `SMOKE_BASE_URL=<approuter> SMOKE_SRV_URL=<srv> npm run test:smoke`.
- [ ] **Live SMTP send works:** `POST /admin/testNotificationEmail` returns `{success: true}`, mail arrives.
- [ ] **Admin UI rotation propagates within 5 min:** change `SMTP_FROM` in the UI, wait 5 min, send a test email, confirm the From-header reflects the new value (no restart).
- [ ] **No env-var fallback active:** `cf env tutorials-srv | grep -E "SMTP_|REBUILD_TARGET_ENV"` shows the SMTP / REBUILD_TARGET_ENV vars are NOT in the application's environment.
- [ ] **No drift in CI:** the GitHub Actions `SMTP_*` secrets can be archived/deleted; the next deploy succeeds without them.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Cold-boot before credstore values are pasted | The mail-client returns `null` transport, queues to `FailedEmails`, 4-hour retry cron picks up once values land. No crash. |
| Tom forgets to paste values on QA after deploy | Smoke test `POST /admin/testNotificationEmail` against QA explicitly fails the post-deploy smoke step. Add to deploy.yml's post-deploy smoke if not already. |
| TTL cache hides a fresh paste for up to 5 min | Admin handler at `srv/admin-service.js:1318-1413` already calls `invalidateSecret(row.key)` on every set/rotate/clear — propagation is immediate, not 5-min. |
| Existing tests setting `process.env.SMTP_HOST` and relying on it | These keep working: the resolver's env-fallback path returns the same value the old `process.env.SMTP_HOST` read did. The read mechanism moved; the seam didn't. |
| QA + PROD `SMTP_PASS` already in credstore (from #545) — won't be affected | Confirmed: the 4 new entries are net-new rows; existing `SMTP_PASS` row stays untouched. |
| Task 4 deletes `REBUILD_TARGET_ENV` mtaext lines before DB rows are populated | Pre-flight check in the "Pre-flight: data state" section verifies `TenantSettings.rebuildTargetEnv` per environment. **DO NOT proceed past Task 4 Step 4 for a given env without this check passing.** |

---

## Notes for the implementer

- This is a multi-file refactor across srv/, test/, deploy/, .github/, and docs/. **Work in a worktree** per `[[feedback_use_worktree_for_multi_step_parser_fixes]]`. The plan was written in worktree `credstore-runtime-config`; you can continue there or start fresh.
- **Approuter is unaffected.** The `tutorials-approuter` module in `mta.yaml` has no SMTP / REBUILD_TARGET_ENV properties today. All edits in Task 4 target the `tutorials-srv` module only.
- The mail-client refactor in Task 1 introduces a `_state.fromAddress` cache field. Verify the `_resetForTests` export resets it, or test isolation will leak between cases.
- The `_primeForTests` helper on the secret-resolver is the recommended way to inject test values in unit tests; in the hybrid test (Task 2), use the REAL `writeSecret`/`readSecret` path so platform plumbing (mTLS, JWE) is exercised.
- Don't run `npm run publish-content` mid-PR — it's unrelated to this change and would auto-verify the catalog you may not have rebuilt. If you must run it, use `--dry-run` first.
- Smoke check after deploy: `curl -s "$BASE/admin/secretWarnings"` should show the 4 SMTP_* rows without any new `CRITICAL` severities (they have no `expiresAt` by default).

## Out-of-scope follow-ups (NOT this PR)

- Audit the remaining Tier B env vars (`TECH_USERS`, `TECH_USERS_MAPPING`, `DASHBOARD_URL`, `ALLOWED_CORS_ORIGINS`) to confirm none are still set via `cf set-env` anywhere. The resolver change in Task 3 makes any such overrides ineffective — but loud removal is cleaner.
- Add a `@kind:` enum constraint on `Secrets.kind` so values like `smtp-config` and `smtp-credential` are validated at write-time, not free-form strings.
- Consider whether `secrets-display` admin tile should group by `kind` for easier scanning when the registry grows past ~20 rows.
