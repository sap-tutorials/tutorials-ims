# Deploy Lifecycle Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the team via SAP Alert Notification when a deploy starts, finishes, or fails, by adding a bearer-guarded srv endpoint that the deploy orchestrator pings at each lifecycle boundary.

**Architecture:** The ANS credentials are bound to the `tutorials-srv` CF app, but `scripts/deploy-mta.cjs` runs off-platform. So the srv exposes `POST /ops/deploy-event` (guarded by the existing `CONTENT_API_KEY` middleware); the deploy script best-effort-pings it before `cf deploy` (start), after the smoke gate passes (end), and on failure paths (fail). The endpoint maps `phase` → `alerting.raise(...)`, reusing yesterday's fail-open `srv/lib/alerting.js`. Routing is severity-threshold based: NOTICE deploy chatter → a new dedicated `email:devrel-deploys` channel; ERROR failures additionally hit on-call.

**Tech Stack:** Node.js ESM (`@sap/cds`), Express, `@sap-tutorials/cds-alert-notification`, Vitest, native `fetch`, CommonJS deploy script.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-04-deploy-lifecycle-alerts-design.md`.
- **Alerting is fail-open, always** — `alerting.raise(...)` never throws; the endpoint returns 202 regardless of delivery; the deploy script NEVER changes its exit code because of a ping. Copy the `void alerting.raise({...})` (non-awaited) idiom from existing call sites.
- **Auth reuses `CONTENT_API_KEY`** via `contentAuthMiddleware` (exported from `srv/lib/content-store.js`): 503 when key unset, 401 missing bearer, 403 wrong key (timing-safe).
- **ANS severity scale** is `INFO / NOTICE / WARNING / ERROR / FATAL`. Do NOT use the `Information/Success/...` values from `srv/lib/alert-enums.js` — that is the unrelated visitor-banner code list.
- **`raise()` payload shape:** `{ eventType, severity, category, subject, body, resource: { resourceName, resourceType } }` (matches `srv/jobs/scheduler.js:176`).
- **No new npm deps** — native `fetch` only (project rule: prefer built-in fetch).
- **Windows/CRLF:** author new files with LF endings.
- **MTA version bump = minor** (feature) in `.deploy/mta.yaml` only (root mta.yaml is legacy).
- **Tests:** no supertest — spin an ephemeral server with `http.createServer` + native `fetch`, per `srv/lib/__tests__/alerts-endpoint.test.js`.
- Work happens on branch `worktree-deploy-lifecycle-alerts`; commit after each task.

---

### Task 1: `cds.requires.alerts` config — channel, route, eventTypes

**Files:**
- Modify: `package.json` (`cds.requires.alerts` block)
- Test: `srv/lib/__tests__/deploy-alerts-config.test.js` (create)

**Interfaces:**
- Consumes: existing `cds.requires.alerts` block (from yesterday's ANS integration).
- Produces: the config guarantees delivery routing that Task 2's severities rely on — `DeployStarted`/`DeployFinished` at `NOTICE` reach `email:devrel-deploys`; `DeployFailed` at `ERROR` reaches both `email:devrel-deploys` and `email:devrel-oncall`.

- [ ] **Step 1: Write the failing test**

```js
// srv/lib/__tests__/deploy-alerts-config.test.js
import { describe, it, expect } from 'vitest';
import { resolveChannels } from '@sap-tutorials/cds-alert-notification/lib/routing.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const cfg = pkg.cds.requires.alerts;

describe('deploy alerts routing config', () => {
  it('declares the dedicated deploy channel', () => {
    expect(cfg.channels).toContain('email:devrel-deploys');
  });
  it('registers the three deploy eventTypes', () => {
    for (const t of ['DeployStarted', 'DeployFinished', 'DeployFailed']) {
      expect(cfg.eventTypes).toContain(t);
    }
  });
  it('routes NOTICE-level deploy chatter to the deploys channel only', () => {
    const ch = resolveChannels('NOTICE', cfg);
    expect(ch).toContain('email:devrel-deploys');
    expect(ch).not.toContain('email:devrel-oncall');
  });
  it('routes ERROR-level failures to BOTH deploys and on-call', () => {
    const ch = resolveChannels('ERROR', cfg);
    expect(ch).toContain('email:devrel-deploys');
    expect(ch).toContain('email:devrel-oncall');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/lib/__tests__/deploy-alerts-config.test.js`
Expected: FAIL — `channels` lacks `email:devrel-deploys`, NOTICE route absent.

- [ ] **Step 3: Edit the config**

In `package.json`, under `cds.requires.alerts`, extend the three arrays (leave `kind`/profiles/`dedupWindowMs` untouched):

```jsonc
"channels": [
  "email:devrel-oncall",
  "email:devrel-deploys"
],
"routes": [
  { "minSeverity": "ERROR",  "channels": ["email:devrel-oncall"] },
  { "minSeverity": "NOTICE", "channels": ["email:devrel-deploys"] }
],
"eventTypes": [
  "PublishRejected",
  "ScheduledJobFailed",
  "RebuildDispatchFailed",
  "DeployStarted",
  "DeployFinished",
  "DeployFailed"
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/lib/__tests__/deploy-alerts-config.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Validate the plugin build accepts the config**

Run: `npx cds build --production 2>&1 | grep -iE "alert|channel|route|error" | head -20`
Expected: no `route references undefined channel` / `unknown severity` / `unknown type` errors (the plugin `cds build` step fails hard on bad routing config). If the full build is slow, this still surfaces alert-config validation early.

- [ ] **Step 6: Commit**

```bash
git add package.json srv/lib/__tests__/deploy-alerts-config.test.js
git commit -m "feat(alerts): add deploy eventTypes + dedicated deploys channel/route"
```

---

### Task 2: `POST /ops/deploy-event` route + handler

**Files:**
- Create: `srv/routes/deploy-events.js`
- Test: `srv/routes/__tests__/deploy-events.test.js` (create)

**Interfaces:**
- Consumes: `alerting.raise(input)` from `srv/lib/alerting.js` (fail-open, returns Promise); `contentAuthMiddleware` from `srv/lib/content-store.js` (wired by Task 3, NOT inside this module — this module stays auth-agnostic and testable).
- Produces: `export function register(app, { authMw } = {})` — mounts `POST /ops/deploy-event`. When `authMw` is provided it is applied before the handler; when omitted (unit tests) the handler runs unguarded. Also exports `phaseToPayload(phase, { env, version, detail })` → the `raise()` payload object (pure, unit-tested directly).

- [ ] **Step 1: Write the failing test**

```js
// srv/routes/__tests__/deploy-events.test.js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

// Mock the fail-open alerting module so no ANS/DB is needed.
const raiseMock = vi.fn(() => Promise.resolve());
vi.mock('../../lib/alerting.js', () => ({ raise: (...a) => raiseMock(...a) }));

const { register, phaseToPayload } = await import('../deploy-events.js');

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  register(app); // no authMw → handler runs unguarded
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server?.close(r)); });

function post(body) {
  return fetch(`${baseUrl}/ops/deploy-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('phaseToPayload', () => {
  it('maps start → DeployStarted / NOTICE', () => {
    const p = phaseToPayload('start', { env: 'prod', version: '1.2.3' });
    expect(p.eventType).toBe('DeployStarted');
    expect(p.severity).toBe('NOTICE');
    expect(p.resource).toEqual({ resourceName: 'deploy-prod', resourceType: 'deployment' });
    expect(p.subject).toContain('prod');
    expect(p.subject).toContain('1.2.3');
  });
  it('maps end → DeployFinished / NOTICE', () => {
    expect(phaseToPayload('end', { env: 'dev' }).eventType).toBe('DeployFinished');
    expect(phaseToPayload('end', { env: 'dev' }).severity).toBe('NOTICE');
  });
  it('maps fail → DeployFailed / ERROR with detail in body', () => {
    const p = phaseToPayload('fail', { env: 'qa', detail: 'smoke gate failed' });
    expect(p.eventType).toBe('DeployFailed');
    expect(p.severity).toBe('ERROR');
    expect(p.body).toContain('smoke gate failed');
  });
});

describe('POST /ops/deploy-event', () => {
  it('202 + raises alert for a valid start', async () => {
    raiseMock.mockClear();
    const res = await post({ phase: 'start', env: 'prod', version: '9.9.9' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10)); // let the void raise() settle
    expect(raiseMock).toHaveBeenCalledOnce();
    expect(raiseMock.mock.calls[0][0].eventType).toBe('DeployStarted');
  });
  it('400 on missing/invalid phase, no raise', async () => {
    raiseMock.mockClear();
    const res = await post({ env: 'prod' });
    expect(res.status).toBe(400);
    expect(raiseMock).not.toHaveBeenCalled();
  });
  it('still 202 when raise rejects (fail-open)', async () => {
    raiseMock.mockClear();
    raiseMock.mockImplementationOnce(() => Promise.reject(new Error('ANS down')));
    const res = await post({ phase: 'end', env: 'dev' });
    expect(res.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/routes/__tests__/deploy-events.test.js`
Expected: FAIL — `../deploy-events.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// srv/routes/deploy-events.js
//
// POST /ops/deploy-event — operational endpoint pinged by scripts/deploy-mta.cjs
// at each deploy lifecycle boundary (start/end/fail). Bearer-guarded upstream by
// contentAuthMiddleware (CONTENT_API_KEY). Fail-open: always 202 on a well-formed
// request; alerting.raise is fire-and-forget and never blocks the response.
// Spec: docs/superpowers/specs/2026-08-04-deploy-lifecycle-alerts-design.md
import cds from '@sap/cds';
import * as alerting from '../lib/alerting.js';

const LOG = cds.log('deploy-events');

const PHASE_MAP = {
  start: { eventType: 'DeployStarted',  severity: 'NOTICE', verb: 'started'  },
  end:   { eventType: 'DeployFinished', severity: 'NOTICE', verb: 'finished' },
  fail:  { eventType: 'DeployFailed',   severity: 'ERROR',  verb: 'FAILED'   },
};

export function phaseToPayload(phase, { env, version, detail } = {}) {
  const m = PHASE_MAP[phase];
  if (!m) return null;
  const envLabel = env || 'unknown';
  const verSuffix = version ? ` ${version}` : '';
  return {
    eventType: m.eventType,
    severity: m.severity,
    category: 'ALERT',
    subject: `Deploy ${m.verb} — ${envLabel}${verSuffix}`,
    body: detail || `Deploy ${m.verb} for ${envLabel}${verSuffix}.`,
    resource: { resourceName: `deploy-${envLabel}`, resourceType: 'deployment' },
  };
}

async function handler(req, res) {
  const { phase, env, version, detail } = req.body || {};
  const payload = phaseToPayload(phase, { env, version, detail });
  if (!payload) {
    return res.status(400).json({ error: 'invalid or missing "phase" (start|end|fail)' });
  }
  // Fire-and-forget; alerting.raise is itself fail-open. Never block the deploy.
  void alerting.raise(payload);
  LOG.info(`deploy-event ${phase} env=${env ?? '?'} version=${version ?? '?'}`);
  return res.status(202).json({ ok: true });
}

export function register(app, { authMw } = {}) {
  const express = app.request?.app?.constructor ?? null; // noop; body parser applied by caller
  if (authMw) {
    app.post('/ops/deploy-event', authMw, handler);
  } else {
    app.post('/ops/deploy-event', handler);
  }
}
```

Note: the test mounts `register(app)` without a JSON body parser, so add one inside the module to stay self-contained for tests. Replace the `register` body with:

```js
import express from 'express';
// ...
export function register(app, { authMw } = {}) {
  const parse = express.json({ limit: '16kb' });
  const chain = authMw ? [parse, authMw, handler] : [parse, handler];
  app.post('/ops/deploy-event', ...chain);
}
```

(Remove the stray `const express = ...` noop line — the real `import express from 'express'` at the top is what's used.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/routes/__tests__/deploy-events.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/routes/deploy-events.js srv/routes/__tests__/deploy-events.test.js
git commit -m "feat(alerts): POST /ops/deploy-event route mapping phase to ANS alert"
```

---

### Task 3: Wire the route into `srv/server.js` with auth

**Files:**
- Modify: `srv/server.js` (import near line 37; registration near line 466, beside the other bearer-guarded `/content/*` and `/build/*` routes)

**Interfaces:**
- Consumes: `register(app, { authMw })` from Task 2; `contentAuthMiddleware` already imported at `srv/server.js:28`.
- Produces: live `POST /ops/deploy-event` guarded by `contentAuthMiddleware` on the deployed srv.

- [ ] **Step 1: Add the import**

After line 37 (`import * as alertsPublic from './routes/alerts-public.js';`) add:

```js
import * as deployEvents from './routes/deploy-events.js';
```

- [ ] **Step 2: Register the route**

Immediately after the `/content/pipeline-log` registration (line 466), add:

```js
  // Deploy lifecycle alerts (#deploy-alerts): scripts/deploy-mta.cjs pings this
  // at start/end/fail of a deploy → ANS. Same bearer auth (CONTENT_API_KEY) as
  // the other ops endpoints. Body parser is applied inside register().
  deployEvents.register(app, { authMw: contentAuthMiddleware });
```

- [ ] **Step 3: Verify server boots and the route is guarded**

Run: `npx vitest run srv/routes/__tests__/deploy-events.test.js` (still green — unaffected).
Then a boot smoke check:

Run: `node -e "import('./srv/server.js').then(()=>console.log('import-ok')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: no import/parse error (prints `import-ok` or hangs on server start — Ctrl-C is fine; the point is no `SyntaxError`/`Cannot find module`). If it hangs, that's the CAP server starting; treat clean startup logs as pass.

- [ ] **Step 4: Run the broader unit suite for regressions**

Run: `npm test -- srv/routes srv/lib/__tests__/deploy-alerts-config.test.js`
Expected: PASS, no new failures.

- [ ] **Step 5: Commit**

```bash
git add srv/server.js
git commit -m "feat(alerts): mount /ops/deploy-event with CONTENT_API_KEY auth"
```

---

### Task 4: `notifyDeploy` helper + fire points in `scripts/deploy-mta.cjs`

**Files:**
- Modify: `scripts/deploy-mta.cjs`
- Test: `scripts/__tests__/notify-deploy.test.js` (create; if `scripts/__tests__/` doesn't exist, create it)

**Interfaces:**
- Consumes: per-env `cfg.srvUrl` from the `ENVS` table; `process.env.CONTENT_API_KEY`.
- Produces: `notifyDeploy(phase, cfg, extra, deps)` — best-effort POST to `${cfg.srvUrl}/ops/deploy-event`. Returns a Promise that ALWAYS resolves (never rejects). `deps` injects `{ fetchImpl, log, apiKey }` for tests. Exported via `module.exports` alongside a guard that still runs `main()` when invoked as the entry script.

- [ ] **Step 1: Write the failing test**

```js
// scripts/__tests__/notify-deploy.test.js
const { describe, it, expect, vi } = require('vitest');
const { notifyDeploy } = require('../deploy-mta.cjs');

const CFG = { srvUrl: 'https://srv.example.com' };

describe('notifyDeploy (best-effort)', () => {
  it('POSTs the phase payload with bearer auth', async () => {
    const calls = [];
    const fetchImpl = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true, status: 202 }); };
    await notifyDeploy('start', CFG, { env: 'prod', version: '1.0.0' }, { fetchImpl, apiKey: 'k', log: () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://srv.example.com/ops/deploy-event');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(calls[0].opts.body);
    expect(body).toMatchObject({ phase: 'start', env: 'prod', version: '1.0.0' });
  });
  it('never rejects on network error', async () => {
    const fetchImpl = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      notifyDeploy('end', CFG, { env: 'dev' }, { fetchImpl, apiKey: 'k', log: () => {} })
    ).resolves.toBeUndefined();
  });
  it('no-ops (no fetch) when apiKey is absent', async () => {
    const fetchImpl = vi.fn();
    await notifyDeploy('start', CFG, { env: 'dev' }, { fetchImpl, apiKey: '', log: () => {} });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/notify-deploy.test.js`
Expected: FAIL — `notifyDeploy` is not exported.

- [ ] **Step 3: Add the helper**

Near the other helpers in `scripts/deploy-mta.cjs` (after `shCapture`, ~line 120), add:

```js
// ---------------------------------------------------------------------------
// Deploy lifecycle alert ping (best-effort). POSTs to the srv's
// /ops/deploy-event, which raises an ANS alert. NEVER throws, NEVER changes the
// deploy exit code — a down/misconfigured alerting path must not block a deploy.
// deps is a test seam: { fetchImpl, apiKey, log }.
// ---------------------------------------------------------------------------
async function notifyDeploy(phase, cfg, extra = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : process.env.CONTENT_API_KEY;
  const logFn = deps.log || warn;
  if (!apiKey) {
    logFn(`deploy-event ${phase}: CONTENT_API_KEY not set — skipping alert ping`);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(`${cfg.srvUrl}/ops/deploy-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ phase, ...extra }),
      signal: controller.signal,
    });
    if (!res.ok) logFn(`deploy-event ${phase}: srv returned ${res.status} (ignored)`);
  } catch (e) {
    logFn(`deploy-event ${phase}: ping failed (ignored) — ${e.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Export for tests without breaking entry-script behavior**

Replace the trailing `main();` (last line) with:

```js
if (require.main === module) {
  main();
}

module.exports = { notifyDeploy };
```

- [ ] **Step 5: Wire the three fire points**

The deploy version string for `extra` — reuse the MTA version already read in Step 1.5. Capture it into a script-scope variable when writing the version file, defaulting to `undefined`. In `writeVersionFile()` the value is `version`; hoist a `let deployVersion;` near the top of `main()` and set `deployVersion = v.version;` in the Step 1.5 else-branch (and `deployVersion = readMtaVersion();` in the `--skip-build` branch so it's populated there too).

**(a) start** — in Step 4, in the real-deploy `else` branch, immediately BEFORE `const code = sh('cf', ['deploy', ...]);`:

```js
    await notifyDeploy('start', cfg, { env: envName, version: deployVersion });
```

**(b) fail (cf deploy)** — in the same branch, inside `if (code !== 0) { ... }`, before `die(...)` (and before/after `abortFailedBlueGreen()` is fine — put it first):

```js
      await notifyDeploy('fail', cfg, { env: envName, version: deployVersion, detail: 'cf deploy failed' });
```

**(c) blue-green paused note** — in the `if (bg) { ok('blue-green green apps up ...'); ... }` block, add a warn so the operator knows no auto-end fires:

```js
      warn('No automatic "deploy finished" alert will fire for blue-green (paused before swap).');
```

**(d) end** — in Step 5, in the success branch, right after `ok('smoke tests passed — deploy verified');`:

```js
    await notifyDeploy('end', cfg, { env: envName, version: deployVersion });
```

**(e) fail (smoke gate)** — in Step 5's `if (code !== 0) { ... process.exit(2); }`, before `process.exit(2)`:

```js
      await notifyDeploy('fail', cfg, { env: envName, version: deployVersion, detail: 'smoke gate failed' });
```

Because `main()` is not `async`, wrap these `await notifyDeploy(...)` calls to run synchronously-enough: change `function main()` to `async function main()` and `main();` (inside the `require.main` guard) to `main();` unchanged (Node runs the async fn; unhandled rejection impossible since notifyDeploy never rejects). Verify no other `await` was needed before — the function currently has none, so making it async is safe.

- [ ] **Step 6: Run the helper test**

Run: `npx vitest run scripts/__tests__/notify-deploy.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Dry-run the deploy script to confirm no behavior change**

Run: `node scripts/deploy-mta.cjs --env dev --dry-run`
Expected: exits 0, prints the plan; NO deploy-event ping fired (dry-run skips Step 4/5 real branches). Confirm no stack trace and the `deployVersion` line doesn't throw.

- [ ] **Step 8: Commit**

```bash
git add scripts/deploy-mta.cjs scripts/__tests__/notify-deploy.test.js
git commit -m "feat(alerts): ping /ops/deploy-event at deploy start/end/fail"
```

---

### Task 5: MTA version bump + runbook note

**Files:**
- Modify: `.deploy/mta.yaml` (`version:` field only)
- Modify: `docs/developers/operations/mta-deployment.md` (add a short section)

**Interfaces:**
- Consumes: nothing.
- Produces: deployable artifact version + operator documentation for the new channel action provisioning and the blue-green caveat.

- [ ] **Step 1: Bump the MTA version (minor)**

In `.deploy/mta.yaml`, increment the top-level `version:` by a **minor** (e.g. `X.Y.Z` → `X.(Y+1).0`). Read the current value first:

Run: `grep -m1 '^version:' .deploy/mta.yaml`
Then edit that single line.

- [ ] **Step 2: Add the runbook note**

Append to `docs/developers/operations/mta-deployment.md`:

```markdown
## Deploy lifecycle alerts (start / end / fail)

`npm run deploy -- --env <env>` pings the deployed srv's `POST /ops/deploy-event`
(bearer `CONTENT_API_KEY`) at three points: **start** (before `cf deploy`),
**end** (after the smoke gate passes), and **fail** (on a `cf deploy` or
smoke-gate failure). The srv raises an SAP Alert Notification event:

- `DeployStarted` / `DeployFinished` → severity `NOTICE` → `email:devrel-deploys`.
- `DeployFailed` → severity `ERROR` → `email:devrel-deploys` **and** `email:devrel-oncall`.

**Prerequisites for delivery:**
1. `ChatSettings.alertsEnabled` must be ON in the target env (admin UI `/admin-ui`).
   Default is OFF. (Note: a deploy that flips this flag can suppress its own
   end/fail ping — accepted edge case.)
2. The `devrel-deploys` channel's email **action** must be provisioned in ANS
   (cockpit / `gen/alerts/provision.sh`) with the real distribution-list address,
   exactly like `devrel-oncall`.
3. `CONTENT_API_KEY` must be present in the operator/CI environment running the
   deploy (it already is, for content publish).

**Blue-green caveat:** a `--strategy blue-green` deploy pauses before the traffic
swap and exits, so it emits **start** and (on failure) **fail**, but NOT an
automatic **finished** — the swap happens later via `cf deploy -i <OP_ID> -a resume`.
```

- [ ] **Step 3: Verify docs/yaml parse**

Run: `npx yaml < .deploy/mta.yaml >/dev/null && echo yaml-ok` (or `python -c "import yaml,sys;yaml.safe_load(open('.deploy/mta.yaml'))" && echo yaml-ok`)
Expected: `yaml-ok`.

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml docs/developers/operations/mta-deployment.md
git commit -m "chore(alerts): bump MTA version + document deploy lifecycle alerts"
```

---

### Task 6: Full-suite regression + `srv-qa` cp-list audit

**Files:**
- Verify only: `.deploy/mta.yaml` `srv-qa` `cp:` list

- [ ] **Step 1: Confirm no new `srv/lib/` transitive dep**

`srv/routes/deploy-events.js` imports only `@sap/cds`, `express`, and `srv/lib/alerting.js` (already shipped). Per the project rule, re-walk `./` imports:

Run: `grep -nE "from '\\.|require\\('\\." srv/routes/deploy-events.js`
Expected: only `../lib/alerting.js`. Confirm `srv/lib/alerting.js` and its deps (`./runtime-config/alert-settings.js`) are already in the `srv-qa` `cp:` list (they were added in prior alerts work — commit `ba9c3fed`). No change expected; if `deploy-events.js` needs to be reachable by srv-qa, note that srv-qa does NOT mount this route (deploy pings target the main srv only), so no cp addition is required.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: PASS — no regressions. New tests from Tasks 1, 2, 4 are green.

- [ ] **Step 3: Lint the deploy script**

Run: `npx eslint scripts/deploy-mta.cjs srv/routes/deploy-events.js` (if eslint is configured; otherwise `node --check scripts/deploy-mta.cjs && echo syntax-ok`)
Expected: clean / `syntax-ok`.

- [ ] **Step 4: Final commit (if any lint fixups)**

```bash
git add -A && git commit -m "chore(alerts): lint + srv-qa cp-list audit for deploy events" || echo "nothing to commit"
```

---

## Post-implementation (operator-owned, NOT in this plan)

- Provision the `devrel-deploys` email action in ANS with the real address.
- Flip `ChatSettings.alertsEnabled` ON in the target env(s).
- Deploy the srv (this ships the new endpoint + config), then run a real
  `npm run deploy -- --env dev` and confirm the start/end emails arrive.
- Open a PR (`gh pr create`) — do NOT direct-merge to main.

## Self-Review Notes

- **Spec §4 (contract):** Task 2 (phase map, 202/400, fail-open). ✓
- **Spec §5 (routing):** Task 1 (channel/route/eventTypes + `resolveChannels` asserts). ✓
- **Spec §6 (script integration):** Task 4 (helper + 3 fire points, all envs, dry-run guard). ✓
- **Spec §7 (blue-green):** Task 4 step 5(c) warn + Task 5 runbook caveat. ✓
- **Spec §8 (error handling):** Task 2 fail-open test + Task 4 never-rejects test. ✓
- **Spec §9 (testing):** Tasks 1/2/4 unit tests, no supertest. ✓
- **Spec §10 (files):** all listed files have a task. ✓ (server.js=Task 3, mta.yaml/runbook=Task 5)
- **Spec §11 (srv-qa cp list):** Task 6 explicit audit. ✓
- **Type consistency:** `notifyDeploy(phase, cfg, extra, deps)`, `phaseToPayload(phase, {env,version,detail})`, `register(app,{authMw})` used identically across tasks. ✓
