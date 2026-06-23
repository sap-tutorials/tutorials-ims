# Author-Nudge Emails — Credstore-Fronted SMTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-coded but dormant author-nudge cron in CAP `tutorials-srv` actually deliver mail, with the SMTP password sourced from credstore (not plaintext `cf env`), three timing knobs admin-tunable via `ImsConfig`, the 4 HTML templates cleaned of IMS-era rot, and a new `testNotificationEmail` admin action as the operational gate before flipping `isNotificationSendingAllowed=true` in PROD.

**Architecture:** Add a private `resolveSmtpConfig()` helper to [srv/lib/mail-client.js](../../srv/lib/mail-client.js) that mirrors [srv/lib/rebuild-trigger.js:60-86](../../srv/lib/rebuild-trigger.js#L60-L86)'s credstore-first + env fallback + 5-min TTL cache pattern. Promote 3 hardcoded constants in [srv/lib/contributor-notifications.js](../../srv/lib/contributor-notifications.js) (`STALE_DAYS_DEFAULT`, `RESEND_INTERVAL_DAYS`, `MAX_NOTIFICATION_LEVEL`) to `ImsConfig` reads. Widen the scheduler's `variables` payload. Touch 4 templates. Add 1 new admin action. Add 4 env vars to mtaext + envsubst whitelist + new doc.

**Tech Stack:** Node.js (ESM), `@sap/cds`, `nodemailer`, BTP Credential Store via [srv/lib/credstore.js](../../srv/lib/credstore.js), Vitest, SAP Fiori Elements admin shell (`/admin-ui/#operations-display`).

**Spec:** `docs/superpowers/specs/2026-06-23-author-nudge-emails-design.md`
**Branch:** `feat/author-nudge-emails-credstore` (created; spec already committed at `ab565f69`)
**Tracks:** [#545](https://github.com/sap-tutorials/tutorials-ims/issues/545)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| [srv/lib/mail-client.js](../../srv/lib/mail-client.js) | **Modify** (rewrite `getTransporter()`, add `resolveSmtpConfig`, `_resetForTests`, `_state`) | Tier-0 credstore lookup for `SMTP_PASS`; 5-min TTL cache; non-secret knobs from env; same export surface (`sendNotificationEmail`, `retryFailedEmails`, `loadTemplate`, `resolveTemplate`). |
| [srv/lib/contributor-notifications.js](../../srv/lib/contributor-notifications.js) | **Modify** (add `resolveTimingKnobs`, accept full knob payload in `computeStaleNotifications`) | Config-driven timing: read 3 `ImsConfig` rows, parse-guard, fall back to hardcoded defaults. **Helper name is `resolveTimingKnobs` NOT `getNotificationConfig`** to avoid collision with the existing CDS function name `getNotificationConfig()` in [srv/admin-service.cds:200](../../srv/admin-service.cds#L200). |
| [srv/jobs/scheduler.js](../../srv/jobs/scheduler.js) | **Modify** (line 149 area: call `resolveTimingKnobs`, widen `variables` payload at line 169) | Pipe the new knobs into `computeStaleNotifications`; pass `tutorialTitle`, `staleDaysThreshold`, `lastReviewedDate` to `sendNotificationEmail.variables`. |
| [srv/admin-service.js](../../srv/admin-service.js) `sendContributorNotifications` handler (line 876-897) | **Modify** | The admin "Send Contributor Notifications" action has the **same hardcoded `computeStaleNotifications(90)`** and **same thin `variables: { dashboardUrl }` payload** as the cron. Update both call sites in the same way so admin-triggered sends use the new templates correctly. |
| [srv/templates/notification/first.html](../../srv/templates/notification/first.html) | **Modify** | Strip rot; parameterize numbers. |
| [srv/templates/notification/second.html](../../srv/templates/notification/second.html) | **Modify** | Same. |
| [srv/templates/notification/third.html](../../srv/templates/notification/third.html) | **Modify** | Same. |
| [srv/templates/notification/final.html](../../srv/templates/notification/final.html) | **Modify** | Same (this one has Riley's signature + SIX team mention). |
| [srv/admin-service.cds](../../srv/admin-service.cds) | **Modify** (near line 200, after existing notification actions) | Add `action testNotificationEmail(to: String, level: Integer) returns {success: Boolean; error: String;};`. |
| [srv/admin-service.js](../../srv/admin-service.js) | **Modify** (add `this.on('testNotificationEmail', ...)` near the existing `sendContributorNotifications` handler around line 876) | Implement the action: synthesize a test payload, call `sendNotificationEmail`, return the result. |
| [.deploy/mta.yaml](../../.deploy/mta.yaml) | **Modify** (under `tutorials-srv.properties`) | Default values for `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` (and a placeholder `SMTP_PASS` env var for local dev — production uses credstore). |
| [deploy/dev.mtaext](../../deploy/dev.mtaext) + [deploy/qa.mtaext](../../deploy/qa.mtaext) + [deploy/prod.mtaext](../../deploy/prod.mtaext) | **Modify** | Override SMTP env vars per environment (mostly the relay host + sender mailbox). |
| [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) | **Modify** (line 38 area) | Add `$SMTP_HOST $SMTP_PORT $SMTP_USER $SMTP_FROM` to the envsubst whitelist guard. |
| `db/data/com.sap.developers.ims-ImsConfig.csv` | **Create** (file does not exist on `main`) | Seed 3 rows for the timing knobs. `ImsConfig` is `cuid, LegacyKeyed` (NOT `managed`); only `ID;legacyId;key;value` columns. |
| `test/unit/mail-client-credstore.test.js` | **Create** | 4 unit tests covering Tier-0 lookup + 5-min TTL cache. |
| `test/unit/notification-timing-knobs.test.js` | **Create** | Unit tests for the new `resolveTimingKnobs` helper. |
| `test/unit/templates-notification.test.js` | **Create** | Source-string assertions that the 4 templates have placeholders + no legacy rot. |
| `test/unit/scheduler-variables-payload.test.js` | **Create** | Unit test asserting the widened `variables` payload is passed correctly. |
| `test/hybrid/credstore-smtp.test.js` | **Create** | Hybrid write/read/delete round-trip against real credstore (skipped without `cds bind`). |
| `docs/developers/operations/smtp-credentials-rotation.md` | **Create** | Rotation runbook (write to credstore → run testNotificationEmail → flip flag). |
| `docs/superpowers/plans/2026-06-23-author-nudge-emails.md` | **(this file)** | The plan itself. |

**Total: 7 source files + 4 mtaext/yaml/csv files + 5 test files + 2 docs = 18 files touched/created.**

> **srv-qa cp-list check (per [feedback_srv_qa_cp_list_recurring](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_srv_qa_cp_list_recurring.md)):** [.deploy/mta.yaml](../../.deploy/mta.yaml)'s `srv-qa` `cp` list **does NOT** include `mail-client.js`, `contributor-notifications.js`, or `scheduler.js` — srv-qa is a content-preview channel that has no cron and never sent author-nudge emails. No srv-qa cp-list changes needed for this PR. Verified by inspection; revisit if srv-qa ever grows mail consumers.

The implementation is broken into **10 tasks** below. Tasks 2-5 follow strict TDD (red → green → commit). Tasks 6-10 are mostly mechanical edits with verification.

---

## Task 1: Sanity-check worktree state

**Files:** none (verification only)

- [ ] **Step 1: Confirm worktree and branch**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/author-nudge-emails
git branch --show-current
```

Expected: `feat/author-nudge-emails-credstore`

- [ ] **Step 2: Confirm spec is committed**

```bash
git log --oneline -2
```

Expected: top commit is `ab565f69 docs(spec): author-nudge emails — credstore-fronted SMTP for tutorials-srv (#545)`.

- [ ] **Step 3: Confirm clean tree**

```bash
git status --short
```

Expected: empty output (no unstaged or staged changes).

If the tree is dirty or the branch is wrong, stop and report.

---

## Task 2: Credstore Tier-0 SMTP password resolver

**Files:**
- Modify: [srv/lib/mail-client.js](../../srv/lib/mail-client.js) (current shape: 130 lines; replace `getTransporter`, add `resolveSmtpConfig`, `_resetForTests`)
- Create: `test/unit/mail-client-credstore.test.js`

### Step 1: Write the failing tests

Create `test/unit/mail-client-credstore.test.js`:

```javascript
/**
 * Unit tests for Tier-0 credstore lookup in mail-client.js (#545).
 *
 * Mirrors the pattern from test/unit/rebuild-trigger.test.js: vi.mock the
 * credstore module so we don't need a real BTP binding. The mail-client uses
 * a 5-min TTL cache for the resolved SMTP password, identical shape to
 * srv/lib/rebuild-trigger.js:60-86.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../srv/lib/credstore.js', () => ({
  readSecret: vi.fn().mockResolvedValue(null),
}));

// Mock nodemailer so we can assert on the transport config without making real network calls.
const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'test' });
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

// Avoid real DB writes from sendNotificationEmail's failure path.
vi.mock('@sap/cds', async () => {
  const actual = await vi.importActual('@sap/cds');
  return {
    default: {
      ...actual.default,
      log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      entities: () => ({
        FailedEmails: { name: 'FailedEmails' },
      }),
    },
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    entities: () => ({ FailedEmails: { name: 'FailedEmails' } }),
  };
});

import { _resetForTests, _getTransporterForTests } from '../../srv/lib/mail-client.js';

const ORIGINAL_ENV = { ...process.env };

describe('mail-client — Tier-0 credstore lookup', () => {
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SMTP_PASS;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'notifier';
    process.env.SMTP_FROM = 'noreply@example.com';
    _resetForTests();
    createTransportMock.mockClear();
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uses credstore password when credstore returns a value (credstore wins over env)', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockResolvedValue('from-credstore');
    process.env.SMTP_PASS = 'from-env';

    await _getTransporterForTests();

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock.mock.calls[0][0]).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'notifier', pass: 'from-credstore' },
    });
  });

  it('falls through to env SMTP_PASS when credstore throws, and logs a WARN', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockRejectedValue(new Error('credstore offline'));
    process.env.SMTP_PASS = 'from-env';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await _getTransporterForTests();

    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({
      auth: { user: 'notifier', pass: 'from-env' },
    }));
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/credstore lookup failed/);
    warnSpy.mockRestore();
  });

  it('returns null when both credstore and env have no password', async () => {
    delete process.env.SMTP_PASS;
    const transport = await _getTransporterForTests();
    expect(transport).toBeNull();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('caches the resolved password for 5 minutes (second call does not re-read credstore)', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockResolvedValue('cached-value');

    await _getTransporterForTests();
    await _getTransporterForTests();

    expect(credstore.readSecret).toHaveBeenCalledTimes(1);
  });
});
```

### Step 2: Run the test to verify it fails

```bash
npx vitest run test/unit/mail-client-credstore.test.js --reporter=default
```

Expected: all 4 tests FAIL because `_resetForTests` and `_getTransporterForTests` aren't exported from mail-client.js yet, and the new Tier-0 logic doesn't exist.

### Step 3: Rewrite the `getTransporter` function in `srv/lib/mail-client.js`

Replace the existing `let transporter = null;` declaration and `async function getTransporter()` body at the top of the file with the following. The exports of `loadTemplate`, `resolveTemplate`, `sendNotificationEmail`, `retryFailedEmails` stay unchanged.

Add these constants right after the existing imports (replace the existing `let transporter = null;` line and the existing `const DEFAULT_FROM = 'developers@sap.com';` line on line 10):

```javascript
const SMTP_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FROM = 'developers@sap.com';

// State on globalThis so the module-singleton-multiplicity issue on Vitest+CDS
// (Windows) doesn't yield divergent caches. Same pattern as credstore.js.
// See feedback_module_singletons_in_vitest_cds memory entry.
const STATE_KEY = Symbol.for('com.sap.developers.ims:mail-client');
const _state = (globalThis[STATE_KEY] ??= {
  transporter: null,
  resolvedAt: 0,
  warnedWindowAt: 0,
});
```

> `DEFAULT_FROM` stays as a top-level `const`. It is NOT inside the `_state` object. The `_state` object only carries cache fields (`transporter`, `resolvedAt`, `warnedWindowAt`).

Replace the existing `async function getTransporter()` with:

```javascript
/**
 * Resolve the SMTP password with credstore-first + env fallback + 5-min TTL
 * cache. Returns null if neither source has a value.
 *
 * Pattern mirrors srv/lib/rebuild-trigger.js:60-86's getDispatchToken().
 */
async function resolveSmtpPassword() {
  let password = null;
  try {
    const { readSecret } = await import('./credstore.js');
    password = await readSecret('SMTP_PASS');
  } catch (err) {
    // Credstore unavailable (no BTP binding / network blip / decryption failure).
    // Log once per cache window so we see the gap without flooding.
    const now = Date.now();
    if (now - _state.warnedWindowAt > SMTP_TTL_MS) {
      console.warn(`[mail] credstore lookup failed (falling back to env): ${err.message ?? err}`);
      _state.warnedWindowAt = now;
    }
  }
  if (!password) {
    password = process.env.SMTP_PASS ?? null;
  }
  return password;
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

Add at the bottom of the file (after `retryFailedEmails`):

```javascript
/** Test-only: clear cached transporter so unit tests can swap credstore mocks. */
export function _resetForTests() {
  _state.transporter = null;
  _state.resolvedAt = 0;
  _state.warnedWindowAt = 0;
}

/** Test-only: expose getTransporter so unit tests can assert on the resolved transport. */
export async function _getTransporterForTests() {
  return getTransporter();
}
```

Also update the existing `DEFAULT_FROM` reference inside `sendNotificationEmail` so the `from:` address respects `SMTP_FROM` env when present:

Change line ~58 from `from: DEFAULT_FROM,` to `from: process.env.SMTP_FROM || DEFAULT_FROM,` (do this in **both** the main send path AND the `retryFailedEmails` path on line ~111).

### Step 4: Run tests to verify they pass

```bash
npx vitest run test/unit/mail-client-credstore.test.js --reporter=default
```

Expected: 4/4 PASS.

### Step 5: Commit

```bash
git add srv/lib/mail-client.js test/unit/mail-client-credstore.test.js
git commit -m "feat(mail): credstore-first SMTP password resolver with 5-min TTL cache

Adds Tier-0 credstore lookup for SMTP_PASS, mirroring the pattern in
srv/lib/rebuild-trigger.js:60-86. Non-secret knobs (host/port/user/from)
continue to flow via env. The xsenv mail-tagged binding fallback is
preserved as an escape hatch.

Part of #545 — author-nudge emails."
```

---

## Task 3: Config-driven timing knobs

**Files:**
- Modify: [srv/lib/contributor-notifications.js](../../srv/lib/contributor-notifications.js)
- Create: `test/unit/notification-timing-knobs.test.js`

### Step 1: Write the failing tests

Create `test/unit/notification-timing-knobs.test.js`:

```javascript
/**
 * Unit tests for resolveTimingKnobs in contributor-notifications.js (#545).
 *
 * The 3 knobs (staleDaysThreshold, resendIntervalDays, maxNotificationLevel)
 * are read from ImsConfig with hardcoded defaults as fallback. Invalid values
 * (non-numeric, missing rows) fall back to defaults and emit a WARN with the
 * bad value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';

// In-memory CDS bootstrap. db/schema.cds carries ImsConfig.
import { resolveTimingKnobs } from '../../srv/lib/contributor-notifications.js';

const DB = './db/schema.cds';

beforeEach(async () => {
  await cds.deploy(DB).to('sqlite::memory:');
});

afterEach(async () => {
  // Drop the in-memory connection so each test gets a fresh DB. Without this,
  // the global cds.db singleton can leak ImsConfig rows between tests when
  // Vitest reuses the same worker process. Same defensive pattern as other
  // unit tests in this project that touch CDS via cds.deploy().
  if (cds.db) {
    try { await cds.disconnect(); } catch { /* best-effort */ }
  }
});

async function seedImsConfig(rows) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ImsConfig);
  for (const [key, value] of Object.entries(rows)) {
    await INSERT.into(ImsConfig).entries({ key, value });
  }
}

describe('resolveTimingKnobs', () => {
  it('returns DB values when all three rows are valid integers', async () => {
    await seedImsConfig({
      staleDaysThreshold: '120',
      resendIntervalDays: '14',
      maxNotificationLevel: '5',
    });
    const knobs = await resolveTimingKnobs();
    expect(knobs).toEqual({ staleDays: 120, resendIntervalDays: 14, maxLevel: 5 });
  });

  it('falls back to hardcoded defaults when rows are missing', async () => {
    await seedImsConfig({});
    const knobs = await resolveTimingKnobs();
    expect(knobs).toEqual({ staleDays: 90, resendIntervalDays: 30, maxLevel: 3 });
  });

  it('falls back to defaults and logs WARN on unparseable values', async () => {
    await seedImsConfig({
      staleDaysThreshold: 'forty-two',
      resendIntervalDays: '14',
      maxNotificationLevel: '',
    });
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));

    const knobs = await resolveTimingKnobs();

    console.warn = origWarn;
    expect(knobs.staleDays).toBe(90);
    expect(knobs.resendIntervalDays).toBe(14);
    expect(knobs.maxLevel).toBe(3);
    expect(warns.some(w => w.includes('staleDaysThreshold') && w.includes('forty-two'))).toBe(true);
    expect(warns.some(w => w.includes('maxNotificationLevel'))).toBe(true);
  });

  it('rejects negative or zero values, falling back to default', async () => {
    await seedImsConfig({
      staleDaysThreshold: '-5',
      resendIntervalDays: '0',
      maxNotificationLevel: '3',
    });
    const knobs = await resolveTimingKnobs();
    expect(knobs.staleDays).toBe(90);
    expect(knobs.resendIntervalDays).toBe(30);
    expect(knobs.maxLevel).toBe(3);
  });
});
```

### Step 2: Run the test to verify it fails

```bash
npx vitest run test/unit/notification-timing-knobs.test.js --reporter=default
```

Expected: import fails because `resolveTimingKnobs` isn't exported yet from `contributor-notifications.js`.

### Step 3: Implement `resolveTimingKnobs` in `srv/lib/contributor-notifications.js`

Add this function near the top of the file, just after the existing constants block:

```javascript
const TIMING_KNOBS = [
  { key: 'staleDaysThreshold',   field: 'staleDays',           defaultValue: STALE_DAYS_DEFAULT },
  { key: 'resendIntervalDays',   field: 'resendIntervalDays',  defaultValue: RESEND_INTERVAL_DAYS },
  { key: 'maxNotificationLevel', field: 'maxLevel',            defaultValue: MAX_NOTIFICATION_LEVEL },
];

/**
 * Resolve the 3 author-nudge timing knobs from ImsConfig, falling back to
 * hardcoded defaults on missing/invalid rows. Emits a WARN per bad value so
 * ops can see the fallback in logs.
 *
 * @returns {Promise<{staleDays: number, resendIntervalDays: number, maxLevel: number}>}
 */
export async function resolveTimingKnobs() {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const out = {};
  for (const { key, field, defaultValue } of TIMING_KNOBS) {
    const row = await SELECT.one.from(ImsConfig).where({ key });
    const raw = row?.value;
    const parsed = raw != null && raw !== '' ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      out[field] = parsed;
    } else {
      if (raw != null && raw !== '') {
        console.warn(`[contributor-notifications] ImsConfig.${key}="${raw}" is not a positive integer; using default ${defaultValue}`);
      }
      out[field] = defaultValue;
    }
  }
  return out;
}
```

Also widen the `computeStaleNotifications` signature so it can use the new knobs. Replace the current signature:

```javascript
export async function computeStaleNotifications(staleDaysThreshold = STALE_DAYS_DEFAULT) {
```

With:

```javascript
export async function computeStaleNotifications(opts = {}) {
  const staleDaysThreshold = opts.staleDays ?? STALE_DAYS_DEFAULT;
  const resendIntervalDays = opts.resendIntervalDays ?? RESEND_INTERVAL_DAYS;
  const maxLevel = opts.maxLevel ?? MAX_NOTIFICATION_LEVEL;
```

Then replace the two uses of `RESEND_INTERVAL_DAYS` and `MAX_NOTIFICATION_LEVEL` later in the function with `resendIntervalDays` and `maxLevel` (these are local variables now).

Specifically — the line:
```javascript
const resendCutoff = new Date(Date.now() - RESEND_INTERVAL_DAYS * 86400000).toISOString();
```
becomes:
```javascript
const resendCutoff = new Date(Date.now() - resendIntervalDays * 86400000).toISOString();
```

And:
```javascript
notificationNumber: { '<=': MAX_NOTIFICATION_LEVEL }
```
becomes:
```javascript
notificationNumber: { '<=': maxLevel }
```

### Step 4: Run tests to verify they pass

```bash
npx vitest run test/unit/notification-timing-knobs.test.js --reporter=default
```

Expected: 4/4 PASS.

### Step 5: Commit

```bash
git add srv/lib/contributor-notifications.js test/unit/notification-timing-knobs.test.js
git commit -m "feat(notifications): config-driven timing knobs via ImsConfig

Promotes 3 hardcoded constants (staleDaysThreshold, resendIntervalDays,
maxNotificationLevel) to ImsConfig reads with hardcoded defaults as
fallback. parseInt + positive-integer guard rejects garbage with a WARN.

Helper is named resolveTimingKnobs to avoid colliding with the existing
admin CDS function getNotificationConfig() at admin-service.cds:200.

Part of #545."
```

---

## Task 4: Scheduler + admin-action wiring — pass the knobs + widen variables payload

**Files:**
- Modify: [srv/jobs/scheduler.js](../../srv/jobs/scheduler.js) (line 142-195 area)
- Modify: [srv/admin-service.js](../../srv/admin-service.js) (line 876-897 — `sendContributorNotifications` handler)
- Create: `test/unit/scheduler-variables-payload.test.js`

> **Why two files:** [srv/admin-service.js:881](../../srv/admin-service.js#L881) has its own `computeStaleNotifications(90)` + `variables: { dashboardUrl }` call site. When an admin clicks "Send Contributor Notifications," it bypasses the cron and uses this handler. If we only update the cron, the new templates' `${tutorialTitle}` / `${staleDaysThreshold}` / `${lastReviewedDate}` placeholders render as empty strings and the body prose breaks ("If no action is taken within  days,..."). Mirror the edit in both places.

### Step 1: Write the failing test

Create `test/unit/scheduler-variables-payload.test.js`:

```javascript
/**
 * Unit test for the widened variables payload passed to sendNotificationEmail
 * by the contributor-notifications cron in scheduler.js (#545).
 *
 * We don't run the cron — we extract the per-notification call inline by
 * importing the building-block functions and asserting the payload shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

const DB = './db/schema.cds';

beforeEach(async () => {
  await cds.deploy(DB).to('sqlite::memory:');
});

afterEach(async () => {
  // Drop the in-memory connection so each test gets a fresh DB. Without this,
  // the global cds.db singleton can leak ImsConfig rows between tests when
  // Vitest reuses the same worker process. Same defensive pattern as other
  // unit tests in this project that touch CDS via cds.deploy().
  if (cds.db) {
    try { await cds.disconnect(); } catch { /* best-effort */ }
  }
});

describe('scheduler — variables payload widening', () => {
  it('passes tutorialTitle, staleDaysThreshold, lastReviewedDate, dashboardUrl', async () => {
    // The scheduler's per-notification call (scheduler.js:165 area) is what we
    // assert against. Rather than mock the full cron, we re-create the call site
    // using the resolved knobs + a synthetic notification.
    const { resolveTimingKnobs } = await import('../../srv/lib/contributor-notifications.js');
    const knobs = await resolveTimingKnobs();

    const notification = {
      tutorialId: 'tid-1',
      slug: 'my-tutorial',
      title: 'My Tutorial',
      reviewedDate: '2025-12-01',
      notificationLevel: 0,
      contributors: [],
      repoOwner: null,
    };

    const dashboardUrl = 'https://example.com/dash';

    // The scheduler builds this object inline before calling sendNotificationEmail.
    // This test asserts the shape; the next task verifies scheduler.js was actually
    // updated to build this shape.
    const variables = {
      dashboardUrl,
      tutorialTitle: notification.title,
      staleDaysThreshold: knobs.staleDays,
      lastReviewedDate: notification.reviewedDate,
    };

    expect(variables.dashboardUrl).toBe('https://example.com/dash');
    expect(variables.tutorialTitle).toBe('My Tutorial');
    expect(variables.staleDaysThreshold).toBe(90);  // default fallback
    expect(variables.lastReviewedDate).toBe('2025-12-01');
  });

  it('scheduler.js wires resolveTimingKnobs into the contributor-notifications cron', async () => {
    // Source-string assert: the scheduler MUST call resolveTimingKnobs and pass
    // its return value to computeStaleNotifications.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const REPO_ROOT = join(import.meta.dirname, '..', '..');
    const src = readFileSync(join(REPO_ROOT, 'srv/jobs/scheduler.js'), 'utf8');

    expect(src).toMatch(/resolveTimingKnobs/);
    expect(src).toMatch(/computeStaleNotifications\([^)]*knobs/);
    // Variables payload must include the 3 new keys.
    expect(src).toMatch(/tutorialTitle/);
    expect(src).toMatch(/staleDaysThreshold/);
    expect(src).toMatch(/lastReviewedDate/);
  });

  it('admin-service.js sendContributorNotifications handler uses the same knobs', async () => {
    // The admin "Send Contributor Notifications" button bypasses the cron and
    // calls a parallel handler. It MUST also use resolveTimingKnobs + widen the
    // variables payload so templates render correctly when triggered manually.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const REPO_ROOT = join(import.meta.dirname, '..', '..');
    const src = readFileSync(join(REPO_ROOT, 'srv/admin-service.js'), 'utf8');

    expect(src).toMatch(/resolveTimingKnobs/);
    // The hardcoded 90 must be gone — replaced by a knobs-driven call.
    expect(src).not.toMatch(/computeStaleNotifications\(90\)/);
    // Variables payload must include all 4 keys near the sendNotificationEmail call.
    expect(src).toMatch(/tutorialTitle/);
    expect(src).toMatch(/staleDaysThreshold/);
    expect(src).toMatch(/lastReviewedDate/);
  });
});
```

### Step 2: Run the test to verify it fails

```bash
npx vitest run test/unit/scheduler-variables-payload.test.js --reporter=default
```

Expected: the second test (source-string assert) fails because the scheduler hasn't been edited yet.

### Step 3: Edit `srv/jobs/scheduler.js`

Find the import line at the top (around line 10):

```javascript
import { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, isNotificationsEnabled } from '../lib/contributor-notifications.js';
```

Add `resolveTimingKnobs` to the import:

```javascript
import { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, isNotificationsEnabled, resolveTimingKnobs } from '../lib/contributor-notifications.js';
```

Find the cron body around line 142-149. Replace:

```javascript
      if (!await isNotificationsEnabled()) {
        LOG.info('Contributor notifications disabled via config');
        return { enabled: false };
      }
      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(90);
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;
```

With:

```javascript
      if (!await isNotificationsEnabled()) {
        LOG.info('Contributor notifications disabled via config');
        return { enabled: false };
      }
      const knobs = await resolveTimingKnobs();
      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(knobs);
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;
```

Find the per-notification sendNotificationEmail call (around line 165):

```javascript
        const result = await sendNotificationEmail({
          to, cc,
          subject: n.title,
          level: n.notificationLevel,
          variables: { dashboardUrl }
        });
```

Replace with:

```javascript
        const result = await sendNotificationEmail({
          to, cc,
          subject: n.title,
          level: n.notificationLevel,
          variables: {
            dashboardUrl,
            tutorialTitle: n.title,
            staleDaysThreshold: knobs.staleDays,
            lastReviewedDate: n.reviewedDate,
          }
        });
```

### Step 3b: Edit `srv/admin-service.js` `sendContributorNotifications` handler

Find the handler around line 876-897:

```javascript
    this.on('sendContributorNotifications', async (req) => {
      const { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList } = await import('./lib/contributor-notifications.js');
      const { sendNotificationEmail } = await import('./lib/mail-client.js');

      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(90);
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;

      let sent = 0;
      for (const n of notifications) {
        const { to, cc } = determineRecipients(n, adminEmails);
        if (to.length === 0) continue;
        await sendNotificationEmail({
          to, cc, subject: n.title,
          level: n.notificationLevel,
          variables: { dashboardUrl }
        });
        await markNotificationSent(n.tutorialId);
        sent++;
      }
      return { notified: sent };
    });
```

Replace with:

```javascript
    this.on('sendContributorNotifications', async (req) => {
      const { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, resolveTimingKnobs } = await import('./lib/contributor-notifications.js');
      const { sendNotificationEmail } = await import('./lib/mail-client.js');

      const knobs = await resolveTimingKnobs();
      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(knobs);
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;

      let sent = 0;
      for (const n of notifications) {
        const { to, cc } = determineRecipients(n, adminEmails);
        if (to.length === 0) continue;
        await sendNotificationEmail({
          to, cc, subject: n.title,
          level: n.notificationLevel,
          variables: {
            dashboardUrl,
            tutorialTitle: n.title,
            staleDaysThreshold: knobs.staleDays,
            lastReviewedDate: n.reviewedDate,
          }
        });
        await markNotificationSent(n.tutorialId);
        sent++;
      }
      return { notified: sent };
    });
```

### Step 4: Run the test to verify both pass

```bash
npx vitest run test/unit/scheduler-variables-payload.test.js --reporter=default
```

Expected: 3/3 PASS (scheduler.js source-string + admin-service.js source-string + payload-shape test).

Also re-run the previous tests to verify no regression:

```bash
npx vitest run test/unit/mail-client-credstore.test.js test/unit/notification-timing-knobs.test.js test/unit/scheduler-variables-payload.test.js --reporter=default
```

Expected: 11/11 PASS.

### Step 5: Commit

```bash
git add srv/jobs/scheduler.js srv/admin-service.js test/unit/scheduler-variables-payload.test.js
git commit -m "feat(notifications): wire timing knobs + widen variables payload (both call sites)

The contributor-notifications cron AND the parallel admin
sendContributorNotifications handler both now resolve the 3 timing knobs
from ImsConfig via resolveTimingKnobs() and pass them to
computeStaleNotifications. The variables payload widens from
{dashboardUrl} to also include tutorialTitle, staleDaysThreshold,
lastReviewedDate so templates can reference them without hardcoding numbers.

Part of #545."
```

---

## Task 5: Template content cleanup

**Files:**
- Modify: [srv/templates/notification/first.html](../../srv/templates/notification/first.html)
- Modify: [srv/templates/notification/second.html](../../srv/templates/notification/second.html)
- Modify: [srv/templates/notification/third.html](../../srv/templates/notification/third.html)
- Modify: [srv/templates/notification/final.html](../../srv/templates/notification/final.html)
- Create: `test/unit/templates-notification.test.js`

### Step 1: Write the failing test (source-string assertions on the templates)

Create `test/unit/templates-notification.test.js`:

```javascript
/**
 * Source-string tests for the 4 author-nudge templates (#545).
 *
 * These guard against legacy IMS-era rot creeping back in and verify the new
 * variable placeholders are present so the build-time-static prose reads
 * "If no action is taken within ${staleDaysThreshold} days..." rather than
 * "...within ninety days..." (hardcoded).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'srv/templates/notification');
const FILES = ['first.html', 'second.html', 'third.html', 'final.html'];

const FORBIDDEN_LITERALS = [
  'ninety days',
  'IMS Tutorial Dashboard',
  'Riley',                    // any reference to Riley Rainey's signature
  'docs-tutorial-2a-updating-tutorialv2.html',  // AEM-era docs URL
];

// Word-boundary regex for short tokens that could otherwise false-match inside
// markup (e.g. 'SIX' would collide with `<h6>` or attribute `tabindex="6"`).
const FORBIDDEN_PATTERNS = [
  /\bSIX\b/,                  // SAP Industries and Experience (defunct team naming)
];

const REQUIRED_PLACEHOLDERS_PER_FILE = {
  // First three nudges go to the author and reference numbers/title/date.
  'first.html':  ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  'second.html': ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  'third.html':  ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  // final.html addresses admins; tutorialTitle suffices.
  'final.html':  ['${tutorialTitle}'],
};

describe('notification templates — rot detection', () => {
  for (const file of FILES) {
    it(`${file} contains no legacy IMS-era rot`, () => {
      const content = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      for (const forbidden of FORBIDDEN_LITERALS) {
        expect(content).not.toContain(forbidden);
      }
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

describe('notification templates — placeholders', () => {
  for (const file of FILES) {
    it(`${file} contains every required placeholder`, () => {
      const content = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      for (const placeholder of REQUIRED_PLACEHOLDERS_PER_FILE[file]) {
        expect(content).toContain(placeholder);
      }
    });
  }
});

describe('notification templates — signature', () => {
  for (const file of FILES) {
    it(`${file} signs off as "SAP Developers Tutorials Team"`, () => {
      const content = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      expect(content).toContain('SAP Developers Tutorials Team');
    });
  }
});
```

### Step 2: Run the test to verify it fails

```bash
npx vitest run test/unit/templates-notification.test.js --reporter=default
```

Expected: 12/12 FAIL (4 files × 3 describe blocks).

### Step 3: Rewrite the 4 templates

Replace `srv/templates/notification/first.html` with:

```html
<html>
<head>
    <meta http-equiv="content-type" content="text/html; charset=UTF-8">
</head>
<body>
<p>Dear Tutorial Owner,</p>
<p>This is the first reminder to review the tutorial <strong>${tutorialTitle}</strong>,
   which was last reviewed on ${lastReviewedDate}.
   If no action is taken within ${staleDaysThreshold} days, the tutorial will be retired from production.</p>

<p><strong>Why are you receiving this email?</strong></p>
<p>You are listed as a contributor on the tutorial in the subject line. As such, you are
   the best judge of whether the tutorial's instructions are still correct.</p>

<p><strong>What action do you need to take?</strong></p>
<ol>
    <li><strong>Review the tutorial.</strong> If changes are required, update the tutorial in its
        source GitHub repository. If no changes are required, you can mark the tutorial as
        up to date by clicking the appropriate "Reviewed" checkbox in the
        <a href="${dashboardUrl}">Tutorial Dashboard</a>.
        If you mark a tutorial as "Reviewed", the review will be noted at the next periodic
        processing cycle.
        <strong>If you perform this review on your own every 3-4 months, you will not receive these reminders.</strong></li>
    <li><strong>Mark the tutorial as needing changes.</strong> If you know the tutorial is out
        of date but you do not have time to fix it now, mark it as such in the Tutorial Dashboard.</li>
    <li><strong>Defer the review.</strong> If you need more time, mark the tutorial as deferred in
        the Tutorial Dashboard. You will not receive another reminder for 30 days.</li>
    <li><strong>Do nothing.</strong> The tutorial will continue to be marked as out of date and
        will eventually be retired from production.</li>
</ol>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

Replace `srv/templates/notification/second.html` with:

```html
<html>
<head>
    <meta http-equiv="content-type" content="text/html; charset=UTF-8">
</head>
<body>
<p>Dear Tutorial Owner,</p>
<p>This is the second reminder to review the tutorial <strong>${tutorialTitle}</strong>,
   which was last reviewed on ${lastReviewedDate}.
   If no action is taken within ${staleDaysThreshold} days, the tutorial will be retired from production.</p>

<p>The repository owner has been copied on this message so they can help coordinate the review.</p>

<p><strong>Action options:</strong></p>
<ol>
    <li>Review and update the tutorial in its source GitHub repository.</li>
    <li>Mark the tutorial as Reviewed in the <a href="${dashboardUrl}">Tutorial Dashboard</a>.</li>
    <li>Mark the tutorial as needing changes if you can't update it now.</li>
    <li>Defer the review for 30 days via the Tutorial Dashboard.</li>
</ol>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

Replace `srv/templates/notification/third.html` with:

```html
<html>
<head>
    <meta http-equiv="content-type" content="text/html; charset=UTF-8">
</head>
<body>
<p>Dear Tutorial Owner,</p>
<p>This is the third and final reminder before retirement for the tutorial
   <strong>${tutorialTitle}</strong>, which was last reviewed on ${lastReviewedDate}.
   If no action is taken within ${staleDaysThreshold} days, the tutorial will be retired
   from production.</p>

<p>The repository owner and the Tutorials Curation team have been copied on this message.
   We are escalating because the previous two reminders went unanswered.</p>

<p><strong>Please take action now via the <a href="${dashboardUrl}">Tutorial Dashboard</a>:</strong></p>
<ol>
    <li>Review and update the tutorial in its source GitHub repository.</li>
    <li>Mark the tutorial as Reviewed in the Tutorial Dashboard.</li>
    <li>Mark the tutorial as needing changes if you can't update it now.</li>
</ol>

<p>If we don't hear from you, the next message about this tutorial will go to the Tutorials
   Curation team for retirement processing.</p>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

Replace `srv/templates/notification/final.html` with:

```html
<html>
<head>
    <meta http-equiv="content-type" content="text/html; charset=UTF-8">
</head>
<body>
<p>Dear Team,</p>
<p>The deadline for reviewing <strong>${tutorialTitle}</strong> has passed. The contributors
   did not respond to the three escalating reminders. Please make arrangements to have it
   removed from the productive system.</p>

<p>If you received this message by mistake, please let us know by replying to this email.</p>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

### Step 4: Run the test to verify it passes

```bash
npx vitest run test/unit/templates-notification.test.js --reporter=default
```

Expected: 12/12 PASS.

### Step 5: Commit

```bash
git add srv/templates/notification/ test/unit/templates-notification.test.js
git commit -m "feat(notifications): clean templates of IMS-era rot, parameterize numbers

- Drop hardcoded 'ninety days', replace with \${staleDaysThreshold}
- Drop 'IMS' from dashboard reference, drop AEM-era docs URL
- Drop Riley's signature + SIX team mention; sign as 'SAP Developers Tutorials Team'
- Reference tutorial title and last-reviewed date in body prose via
  new \${tutorialTitle} and \${lastReviewedDate} variables
- Add source-string forbidden-literal test to catch future regressions

Part of #545."
```

---

## Task 6: New `testNotificationEmail` admin action

**Files:**
- Modify: [srv/admin-service.cds](../../srv/admin-service.cds) (around line 200)
- Modify: [srv/admin-service.js](../../srv/admin-service.js) (near line 876 — adjacent to `sendContributorNotifications` handler)

### Step 1: Declare the action in CDS

Find the existing notification actions in [srv/admin-service.cds](../../srv/admin-service.cds) around line 196:

```cds
  action sendContributorNotifications() returns {
    notified : Integer;
  };
  action updateNotificationRecipients(emails : String) returns { updated : Boolean };
  action toggleNotifications(enabled : Boolean) returns { enabled : Boolean };
  function getNotificationConfig() returns { enabled : Boolean; recipients : String };
```

Add after `getNotificationConfig`:

```cds
  action testNotificationEmail(to: String, level: Integer) returns {
    success : Boolean;
    error   : String;
  };
```

### Step 2: Implement the handler in admin-service.js

Find the existing `this.on('sendContributorNotifications', ...)` handler around line 876. Add this handler immediately after it (before the next `this.on(...)`):

```javascript
    this.on('testNotificationEmail', async (req) => {
      const { sendNotificationEmail } = await import('./lib/mail-client.js');
      const { to, level } = req.data;
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return { success: false, error: 'Invalid "to" address' };
      }
      const lvl = Number.isInteger(level) && level >= 0 && level <= 3 ? level : 0;
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;
      const today = new Date().toISOString().slice(0, 10);
      const result = await sendNotificationEmail({
        to,
        cc: [],
        subject: '[TEST] CAP tutorials-srv SMTP transport check',
        level: lvl,
        variables: {
          dashboardUrl,
          tutorialTitle: 'Test Tutorial — please ignore',
          staleDaysThreshold: 90,
          lastReviewedDate: today,
        },
      });
      return { success: result.success, error: result.error ?? '' };
    });
```

Note: `resolveDisplaySettings` is already imported at the top of `admin-service.js` (it's used by `sendContributorNotifications` above). Verify with:

```bash
grep -n "resolveDisplaySettings" srv/admin-service.js | head -3
```

If it's NOT imported, add to the top of the file the same import that `sendContributorNotifications` uses:

```javascript
import { resolveDisplaySettings } from './lib/runtime-config/display-settings.js';
```

### Step 3: Verify the action declaration parses

```bash
npx cds compile srv/ 2>&1 | head -20
```

Expected: no errors (warnings about other things are fine).

### Step 4: Run the existing admin-service test suite for regression

```bash
npx vitest run test/admin-service.test.js test/admin-service-integrations.test.js --reporter=default
```

Expected: all pre-existing tests still pass.

### Step 5: Commit

```bash
git add srv/admin-service.cds srv/admin-service.js
git commit -m "feat(admin): add testNotificationEmail action for SMTP transport check

A single-recipient SMTP test send that synthesizes a test payload and
invokes sendNotificationEmail. Used as the operational gate before flipping
isNotificationSendingAllowed=true in PROD. Distinct from
sendContributorNotifications which fires the full cron body against the
real tutorial backlog.

Part of #545."
```

---

## Task 7: Hybrid credstore round-trip test

**Files:**
- Create: `test/hybrid/credstore-smtp.test.js`

This is a hybrid test (real HANA + real credstore via `cds bind --exec`). It verifies the credstore I/O round-trip is functional. Does NOT touch SMTP.

### Step 1: Create the test

```javascript
/**
 * Hybrid test (#545): credstore write/read/delete round-trip for SMTP_PASS.
 *
 * Runs against real BTP credstore via `cds bind --exec`. Skipped without
 * the binding. Pure infrastructure verification — does NOT send mail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let credstore;
const TEST_ALIAS = 'SMTP_PASS_HYBRID_TEST';
const TEST_VALUE = `hybrid-test-${process.pid}`;

beforeAll(async () => {
  credstore = await import('../../srv/lib/credstore.js');
});

afterAll(async () => {
  // Idempotent: delete returns true even if the alias is already gone.
  try { await credstore.deleteSecret(TEST_ALIAS); } catch { /* best-effort */ }
});

describe('credstore — SMTP password round-trip', () => {
  it('write → read returns the same plaintext', async () => {
    await credstore.writeSecret(TEST_ALIAS, TEST_VALUE);
    const got = await credstore.readSecret(TEST_ALIAS);
    expect(got).toBe(TEST_VALUE);
  });

  it('delete is idempotent', async () => {
    const result1 = await credstore.deleteSecret(TEST_ALIAS);
    expect(result1).toBe(true);
    const result2 = await credstore.deleteSecret(TEST_ALIAS);
    expect(result2).toBe(true);
    const got = await credstore.readSecret(TEST_ALIAS);
    expect(got).toBeNull();
  });
});
```

### Step 2: Verify the test is recognized

Inspect [vitest.config.ts](../../vitest.config.ts) — the `hybrid` project's `include` pattern is `'test/hybrid/**/*.test.{js,ts}'`. The new file matches.

```bash
npx vitest list --project hybrid 2>&1 | grep credstore-smtp
```

Expected: the file appears in the listing.

### Step 3: Run (if binding is available)

```bash
# Confirm CF login
cf target

# Run the hybrid test against real BTP
npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/credstore-smtp.test.js
```

Expected on a logged-in DEV target: 2/2 PASS.

If `cf target` shows no org/space, **skip this step** — the hybrid test will run in CI when the deploy workflow runs `cds bind` itself.

### Step 4: Commit

```bash
git add test/hybrid/credstore-smtp.test.js
git commit -m "test(hybrid): credstore SMTP_PASS write/read/delete round-trip

Verifies the infrastructure path. Does not send mail.

Part of #545."
```

---

## Task 8: ImsConfig CSV seed for the timing knobs

**Files:**
- Create: `db/data/com.sap.developers.ims-ImsConfig.csv`

### Step 1: Verify the file does NOT already exist + confirm entity columns

```bash
ls db/data/ | grep -i ImsConfig
```

Expected: empty output. The file does not exist on `main`. If you DO see a file, stop and inspect — schema may have shifted; adapt the seed below to its column order.

`ImsConfig` is declared as `entity ImsConfig : cuid, LegacyKeyed` ([db/schema.cds](../../db/schema.cds)). The columns are:
- `ID` (from `cuid` aspect) — UUID
- `legacyId` (from `LegacyKeyed` aspect) — Integer, nullable
- `key` — String(255)
- `value` — String(2000)

**No `createdAt`/`modifiedAt`/`createdBy`/`modifiedBy`** — `ImsConfig` is NOT `managed`. Do not add those columns.

### Step 2: Create the CSV with 3 seed rows

Create `db/data/com.sap.developers.ims-ImsConfig.csv`:

```csv
ID;legacyId;key;value
aaaaaaaa-aaaa-4aaa-8aaa-000000000001;;staleDaysThreshold;90
aaaaaaaa-aaaa-4aaa-8aaa-000000000002;;resendIntervalDays;30
aaaaaaaa-aaaa-4aaa-8aaa-000000000003;;maxNotificationLevel;3
```

> The UUIDs above are pre-chosen so reviewers can grep for them across the repo. They're valid v4 UUIDs (`4aaa` indicates version 4; `8aaa` indicates variant). If you prefer fresh randomly-generated UUIDs, run `node -e "for (let i = 0; i < 3; i++) console.log(crypto.randomUUID())"` and substitute. The specific UUID does not matter — only that all three are unique and stable across deploys.

> **Memory caveat:** [feedback_cap_csv_seeds_clobber_admin_data](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cap_csv_seeds_clobber_admin_data.md) — HDI re-imports `db/data/*.csv` on every deploy as UPSERT. If an admin later changes one of these knob values via the admin UI, the next HDI deploy will RESET it to the seed value. **This is acceptable here** because the seeded values match the code defaults: a "reset to seed" is functionally the same as a "fall back to default." Documented in the spec risks section.

The CSV is delimiter-separated by `;` (CAP convention). Empty cells become `null` in the DB. Note the empty `legacyId` cells (` ;;` with two consecutive semicolons) for each row.

### Step 3: Run a local cds deploy to verify the CSV parses

```bash
rm -f *.sqlite
npx cds deploy --to sqlite::memory: 2>&1 | tail -10
```

Expected: deployment succeeds; no CSV parse errors.

Quick query check:

```bash
echo "SELECT key, value FROM com_sap_developers_ims_ImsConfig WHERE key IN ('staleDaysThreshold','resendIntervalDays','maxNotificationLevel');" | npx cds repl 2>&1 | head -20
```

Expected: 3 rows showing `90`, `30`, `3`.

> If your repo has an existing `ImsConfig.csv` (e.g. via a migration commit not yet on main) with admin-edited rows like `isNotificationSendingAllowed` or `emailListForOutdated`, **stop and ask** — appending to an existing file requires preserving the existing rows, and the column order may differ. The plan as written assumes the file is freshly created in this PR.

### Step 4: Commit

```bash
git add db/data/com.sap.developers.ims-ImsConfig.csv
git commit -m "feat(seed): create ImsConfig CSV with author-nudge timing knob defaults

Three rows (staleDaysThreshold=90, resendIntervalDays=30,
maxNotificationLevel=3) match the hardcoded defaults in
contributor-notifications.js so the seed is semantically a no-op for the
cron, but populates the admin UI so ops can see + tune the values via
/admin-ui/#operations-display.

Part of #545."
```

---

## Task 9: mtaext SMTP env vars + envsubst guard update

**Files:**
- Modify: [.deploy/mta.yaml](../../.deploy/mta.yaml) (tutorials-srv module's `properties` block)
- Modify: [deploy/dev.mtaext](../../deploy/dev.mtaext)
- Modify: [deploy/qa.mtaext](../../deploy/qa.mtaext)
- Modify: [deploy/prod.mtaext](../../deploy/prod.mtaext)
- Modify: [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) (line 38 area — envsubst whitelist)

### Step 1: Add defaults to .deploy/mta.yaml

In [.deploy/mta.yaml](../../.deploy/mta.yaml), find the `tutorials-srv` module's `properties` block (search for `CONTENT_API_KEY:` to locate it). Add these 4 lines next to the existing `CONTENT_API_KEY` line:

```yaml
      SMTP_HOST: ""
      SMTP_PORT: "587"
      SMTP_USER: ""
      SMTP_FROM: "developers@sap.com"
```

> Why empty defaults for HOST and USER? An empty `SMTP_HOST` makes `mail-client.js` skip the Tier-0 branch entirely and fall through to the (likely missing) xsenv binding, which yields `null`, which sends mail to the `FailedEmails` retry queue. That's the **safe** default state: deploy succeeds, no SMTP is wired, the cron does nothing if `isNotificationsEnabled` is also false, no one gets surprised.

### Step 2: Override per-environment

In [deploy/dev.mtaext](../../deploy/dev.mtaext), under `tutorials-srv.properties` (right before `EXPOSE_CAP_UI`), add:

```yaml
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USER: ${SMTP_USER}
      SMTP_FROM: ${SMTP_FROM}
```

Repeat the same 4 lines in [deploy/qa.mtaext](../../deploy/qa.mtaext) and [deploy/prod.mtaext](../../deploy/prod.mtaext).

### Step 3: Add the 4 placeholders to the envsubst whitelist

In [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) around line 38:

```bash
envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN'
```

Replace with:

```bash
envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN $SMTP_HOST $SMTP_PORT $SMTP_USER $SMTP_FROM'
```

### Step 4: Sanity-check the YAML files parse

```bash
yq '.modules[] | select(.name == "tutorials-srv").properties' .deploy/mta.yaml
yq '.modules[] | select(.name == "tutorials-srv").properties' deploy/dev.mtaext
yq '.modules[] | select(.name == "tutorials-srv").properties' deploy/qa.mtaext
yq '.modules[] | select(.name == "tutorials-srv").properties' deploy/prod.mtaext
```

Expected: each shows the new SMTP_* keys.

### Step 5: Commit

```bash
git add .deploy/mta.yaml deploy/dev.mtaext deploy/qa.mtaext deploy/prod.mtaext .github/workflows/deploy.yml
git commit -m "build(mta): pipe SMTP_HOST/PORT/USER/FROM env vars through mtaext

Non-secret SMTP knobs ride as plain env vars via mtaext (same path as
CONTENT_API_KEY). The secret (SMTP_PASS) lives in credstore — NOT in
mtaext or cf env. The deploy.yml envsubst guard is extended so a
placeholder typo fails CI loudly.

Empty SMTP_HOST default in mta.yaml means a deploy without GitHub
secrets set still succeeds — the mail-client returns null and the cron
gracefully queues to FailedEmails. Safe by construction.

Part of #545."
```

---

## Task 10: Rotation runbook + final test sweep

**Files:**
- Create: `docs/developers/operations/smtp-credentials-rotation.md`

### Step 1: Write the runbook

Create `docs/developers/operations/smtp-credentials-rotation.md`:

```markdown
# SMTP Credentials Rotation Runbook

The author-nudge cron in `tutorials-srv` sends mail via SMTP. Credentials follow
this split:

- **Non-secret:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` — env vars in
  the deploy mtaext, sourced from GitHub Actions secrets at deploy time via
  `envsubst`.
- **Secret:** `SMTP_PASS` — lives in BTP Credential Store, written via the
  admin Secrets UI, NEVER in mtaext or `cf set-env`.

The mail client at [srv/lib/mail-client.js](../../../srv/lib/mail-client.js)
reads `SMTP_PASS` from credstore via [srv/lib/credstore.js](../../../srv/lib/credstore.js)
on first send, caches the resolved password for 5 minutes, and falls through to
`process.env.SMTP_PASS` if credstore is unavailable. Pattern mirrors the
[GITHUB_DISPATCH_TOKEN rotation runbook](github-dispatch-pat-rotation.md).

## When to rotate

- After a suspected leak.
- On the schedule the SMTP relay owner sets (today: `smtpauth.mail.net.sap` —
  rotation cadence TBD with SAP IT).
- After an SMTP authentication failure surfaces in `cf logs tutorials-srv --recent`
  or the admin Job Log.

## Steps

### 1. Issue or rotate the SMTP credential at the relay

For `smtpauth.mail.net.sap`: open a ticket with SAP IT. Capture the new password.

### 2. Write the new password to credstore

Open `/admin-ui/#secrets-display` in the deployed environment.

- If `SMTP_PASS` is in the list: select the row → "Update Value" → paste the new
  password → Save.
- If `SMTP_PASS` is NOT in the list: "Add Secret" → key `SMTP_PASS` → value (the
  new password) → description "SMTP password for author-nudge emails" →
  rotation owner (the relay owner contact) → Save.

The admin UI calls `writeSecret('SMTP_PASS', value)` against the credstore
service. The 5-minute TTL cache in `mail-client.js` means propagation is
automatic — no app restart needed.

### 3. Verify SMTP

Open `/admin-ui/#operations-display`. Click the **Test Notification Email**
button (or call the action directly):

```bash
curl -X POST "$BASE_URL/admin/testNotificationEmail" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "your-address@sap.com", "level": 0}'
```

Expected response: `{"success": true, "error": ""}`. Check your inbox.

### 4. If the test send fails

Check `cf logs tutorials-srv --recent` for the SMTP authentication error.

Common causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `535 Authentication failed` | Wrong password in credstore | Re-paste, ensure no trailing whitespace |
| `535` with the right password | Wrong username in `SMTP_USER` env | Update GitHub Actions secret + redeploy |
| `ECONNREFUSED` | Wrong relay host or port | Update `SMTP_HOST` / `SMTP_PORT` secret + redeploy |
| `550 sender rejected` | Wrong `SMTP_FROM`, not authorized to send as that address | Update `SMTP_FROM` secret + redeploy |
| `No mail transport configured` log | Credstore returned null AND env has no `SMTP_PASS` | Re-check step 2 |

Roll back by writing the OLD password to credstore via the same UI.

### 5. Once verified, ensure the cron is enabled

Open `/admin-ui/#operations-display`. Confirm `isNotificationSendingAllowed=true`
in the displayed ImsConfig values. If false, click the **Toggle Notifications**
control to enable. The next Monday-09:00-UTC cron will fire with real recipients.

### 6. Record the rotation

In `/admin-ui/#secrets-display`, edit the `SMTP_PASS` row's `lastRotatedAt` to
today's date.

## Disaster recovery — credstore is down

The mail-client falls through to `process.env.SMTP_PASS` if credstore throws.
If you absolutely must send mail during a credstore outage, `cf set-env
tutorials-srv SMTP_PASS <value> && cf restart tutorials-srv`. Remove the env var
once credstore is back: `cf unset-env tutorials-srv SMTP_PASS && cf restart`.
The credstore value resumes precedence within 5 minutes.

> **Memory caveat:** [feedback_cf_set_env_drops_on_redeploy](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cf_set_env_drops_on_redeploy.md) — `cf set-env` values do NOT survive the next MTA redeploy. Use this only as a short-term emergency override.
```

### Step 2: Commit the runbook

```bash
git add docs/developers/operations/smtp-credentials-rotation.md
git commit -m "docs(ops): rotation runbook for SMTP credentials in credstore

Part of #545."
```

### Step 3: Final test sweep

Run the unit project to confirm no regressions:

```bash
npx vitest run --project unit \
  test/unit/mail-client-credstore.test.js \
  test/unit/notification-timing-knobs.test.js \
  test/unit/scheduler-variables-payload.test.js \
  test/unit/templates-notification.test.js \
  --reporter=default
```

Expected: ALL new tests pass (4 + 4 + 3 + 12 = 23 tests).

Run the broader admin-service regression check:

```bash
npx vitest run --project unit test/admin-service.test.js test/admin-service-integrations.test.js --reporter=default
```

Expected: pre-existing 31/31 still pass.

### Step 4: Update the docs sidebar (if needed)

Check whether VitePress requires the new runbook in `docs/.vitepress/config.ts`:

```bash
grep -n "github-dispatch-pat-rotation" docs/.vitepress/config.ts | head -3
```

If found, add a sibling entry for `smtp-credentials-rotation`. If not found, the new doc may not need a sidebar entry (just lives in the directory).

Run the docs sidebar guard to be sure:

```bash
npm run predocs:build 2>&1 | tail -10
```

Expected: no errors. If the guard reports the new file as unregistered, edit `docs/.vitepress/config.ts` to add it.

### Step 5: Final commit (if sidebar updated)

If the sidebar config was modified:

```bash
git add docs/.vitepress/config.ts
git commit -m "docs: register SMTP rotation runbook in VitePress sidebar"
```

Otherwise skip this step.

---

## Task 11: Open the PR

**Files:** none (publishing).

### Step 1: Confirm the commit log

```bash
git log --oneline main..HEAD
```

Expected: ~10 commits (one spec + ~9 implementation commits).

### Step 2: Push the branch

```bash
git push -u origin feat/author-nudge-emails-credstore
```

### Step 3: Open the PR

```bash
gh pr create \
  --base main \
  --title "feat(notifications): credstore-fronted SMTP transport + config-driven cron (#545)" \
  --body "$(cat <<'EOF'
Implements the credstore-fronted author-nudge email transport per the approved spec at [docs/superpowers/specs/2026-06-23-author-nudge-emails-design.md](docs/superpowers/specs/2026-06-23-author-nudge-emails-design.md).

## Summary

Three pillars + operational scaffolding:

1. **Tier-0 credstore lookup** — `SMTP_PASS` lives in BTP Credential Store, not in mtaext or `cf env`. Pattern lifted from `srv/lib/rebuild-trigger.js:60-86` (credstore-first → env fallback → 5-min TTL cache → WARN-once-per-window).
2. **Config-driven timing** — 3 cron knobs (staleDaysThreshold, resendIntervalDays, maxNotificationLevel) promoted from hardcoded constants to `ImsConfig` reads with hardcoded defaults as fallback.
3. **Template cleanup** — 4 HTML templates lose "ninety days" / "IMS" / Riley's signature / AEM-era docs URL. Gain `${tutorialTitle}`, `${staleDaysThreshold}`, `${lastReviewedDate}` placeholders.
4. **`testNotificationEmail` admin action** — single-recipient SMTP transport check as the operational gate before flipping `isNotificationSendingAllowed=true` in PROD.

## What does NOT ship

- `isNotificationSendingAllowed` stays false at deploy. Manual flip via admin UI after a verified test send. Zero risk of accidental nag-blast.
- Cron pattern (`'0 9 * * 1'`) and escalation ladder stay hardcoded.
- IMS legacy credential rotation (#545 comment 2 security finding) is a separate ticket.

## How to verify post-deploy

1. Go to `/admin-ui/#secrets-display` → write `SMTP_PASS` value
2. Go to `/admin-ui/#operations-display` → click "Test Notification Email" → enter your address
3. Inbox check ✓
4. Toggle Notifications enabled ✓
5. Wait for next Monday 09:00 UTC cron fire, or trigger `sendContributorNotifications` action manually

Full rotation runbook at [docs/developers/operations/smtp-credentials-rotation.md](docs/developers/operations/smtp-credentials-rotation.md).

## Tests

- 23 new unit tests across 4 files (credstore Tier-0, timing knobs, template rot, scheduler+admin-service payload)
- 1 hybrid test (credstore round-trip)
- pre-existing admin-service tests (31) still green

## Risk + rollback

Low. Single `git revert` rolls back to dormant state. SMTP_PASS in credstore is harmless when unused. Cron exits cleanly when flag is false.

Closes #545.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Step 4: Confirm CI passes

Wait for the deploy workflow to validate the mtaext placeholders + run the unit + hybrid suites. If anything red comes back unrelated to this change, retry; if related, fix and push.

---

## Out-of-scope / explicit non-goals

These were considered and rejected during brainstorming. Do not add them to this PR:

- Cron pattern as a config knob (rejected: operationally fragile)
- Escalation ladder as a config knob (rejected: never changes in practice)
- Full template rewrite with `${authorName}` personalization (rejected: light-touch only)
- `dryRun` mode that routes all emails to a single test address (rejected: `testNotificationEmail` covers the test-send case)
- GitHub-issue-based nudges (Option C in #545) (future-work decision)
- Auto-flipping `isNotificationSendingAllowed=true` at deploy (rejected: manual gate)
- Rotating the legacy IMS SMTP credentials (separate ticket — #545 comment 2 security finding)
- Adding `@sap-cloud-sdk/mail-client` or `@sap-cloud-sdk/connectivity` (rejected: 3MB of deps to fetch 4 strings)

## Rollback

Single `git revert` of the merged PR. No data migration. SMTP_PASS in credstore is harmless when unused. The cron returns to dormant state via the flag.
