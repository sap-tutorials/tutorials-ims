# WebSocket scaling at N>1 srv — sticky sessions + Redis adapter (#2524) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Socket.IO broadcasts (`tutorialCompleted`) survive `tutorials-srv` running at more than one instance, by activating the plugin-native Socket.IO Redis adapter (fan-out) and setting a Gorouter sticky-session cookie on the engine.io handshake (handshake integrity).

**Architecture:** `@cap-js-community/websocket` (`kind: "socket.io"`) already reads `cds.env.websocket.adapter`; when `adapter.impl === "@socket.io/redis-adapter"` and a Redis binding resolves, it mounts the real `@socket.io/redis-adapter` and bridges all broadcasts through Redis. We add that config + the one missing npm dep, provision one `redis-cache` (plan `standard`) instance in the MTA and bind it to both srv modules (sharing one instance, isolated by distinct adapter channel keys), and add a `ws:ready` hook in `srv/server.js` that stamps a `JSESSIONID` cookie on the handshake. On CF (`USER=vcap`) the adapter auto-activates; off-CF it stays in-memory, so local dev and unit tests are untouched.

**Tech Stack:** SAP CAP (`@sap/cds`), `@cap-js-community/websocket` 1.11.1, `socket.io` 4.x, `@socket.io/redis-adapter` 8.x (new dep), `redis`/`@cap-js-community/common` (already transitive), MTA (`org.cloudfoundry.managed-service`), CF Gorouter session affinity.

**Spec:** `docs/superpowers/specs/2026-09-29-websocket-scaling-2524-design.md`

## Global Constraints

- **PR targets `DEV`.** `main` is protected; no main-hotfix path. Never deploy a feature branch — deploy from a fresh `origin/DEV`.
- **Never store credentials in source** — Redis is resolved via the CF service binding only (`cds.env.requires["redis-websocket"]`), never hardcoded.
- **Never write raw SQL / never touch emit sites** — this PR changes config, one server hook, MTA, and docs only. `srv/developer-service.js` emit sites (822-838) are out of scope.
- **`@socket.io/redis-adapter` must be v8.x** — 8.x is the current major and the correct pairing for `socket.io` 4.x (the adapter major runs ahead of socket.io's; they are not meant to match). Pin the exact 8.x resolved at install.
- **No `"active": true` in config** — rely on the CF `USER=vcap` auto-activation guard so local/tests stay in-memory with zero extra config.
- **Adapter channel key differs per module** — `tutorials-srv` uses `"socket.io"`, `tutorials-srv-qa` uses `"socket.io-qa"`, so both can share one Redis instance without colliding broadcasts. Both modules load the **same** `package.json`, so the QA key MUST be an env-var override (`CDS_WEBSOCKET_ADAPTER_OPTIONS_KEY`) set on the `tutorials-srv-qa` module, NOT a static value in `package.json`.
- **Editing paths:** write only under `D:\projects\tutorials-poc\.claude\worktrees\ws-scaling-2524\...` (absolute `D:\projects\tutorials-poc\...` paths write to the primary tree even in a worktree).
- **Noisy commands** (`npm test`, `mbt build`, `cf deploy`) run through `scripts/quiet-run.sh`.
- **The actual thing before done (Tom's #1 rule):** the DEV fan-out proof at 2 instances gates the PR — it is not optional.

---

### Task 1: Activate the Redis adapter in CAP config + add the dependency

**Files:**
- Modify: `package.json` (the `cds` block — `cds.websocket` is a top-level sibling of `cds.requires`, both already present)
- Modify: `package.json` (`dependencies` — add `@socket.io/redis-adapter`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `cds.env.websocket.adapter.impl === "@socket.io/redis-adapter"`, `cds.env.websocket.adapter.options.key === "socket.io"`, and `cds.env.requires["redis-websocket"]` — Task 2 reads `cds.env.websocket.adapter.options.key`; Task 3's MTA binding satisfies `redis-websocket`.

- [ ] **Step 1: Add the dependency, pinned to the resolved 8.x**

Run (in the worktree root):

```bash
npm install --save --save-exact @socket.io/redis-adapter@^8
```

Then read back the exact version npm resolved and confirm it is 8.x:

```bash
jq -r '.dependencies["@socket.io/redis-adapter"]' package.json
```

Expected: a concrete `8.x.y` string (e.g. `8.3.0`). If npm resolves anything below 8, stop — that is a mismatch for `socket.io` 4.x.

- [ ] **Step 2: Add the adapter block to `cds.websocket` and the `redis-websocket` requires entry**

In `package.json`, the `cds.websocket` object today is:

```jsonc
"websocket": { "kind": "socket.io" }
```

Change it to:

```jsonc
"websocket": {
  "kind": "socket.io",
  "adapter": {
    "impl": "@socket.io/redis-adapter",
    "options": { "key": "socket.io" }
  }
}
```

And add a `redis-websocket` entry to the existing `cds.requires` object (alongside AICore, attachments, db, audit-log, caching, etc.) — do NOT nest it under `websocket`:

```jsonc
"redis-websocket": {
  "vcap": { "label": "redis-cache" }
}
```

- [ ] **Step 3: Verify config parses and the adapter is NOT active off-CF**

Run:

```bash
node -e "const cds=require('@sap/cds'); const w=cds.env.websocket; const r=cds.env.requires['redis-websocket']; console.log(JSON.stringify({adapter:w.adapter, redis:r})); if(w.adapter.impl!=='@socket.io/redis-adapter') throw new Error('adapter impl not set'); if(w.adapter.options.key!=='socket.io') throw new Error('key not set'); if(!r||r.vcap.label!=='redis-cache') throw new Error('redis-websocket requires missing'); console.log('OK');"
```

Expected: prints the resolved objects then `OK`. (This runs off-CF, so `USER!==vcap` — the adapter parses but stays dormant; that is the desired local behavior, no Redis needed.)

- [ ] **Step 4: Run the unit suite to prove no regression with the adapter dormant**

Run:

```bash
scripts/quiet-run.sh npm test
```

Expected: green — the in-memory websocket path is unchanged locally because `connectionCheck` returns false off-CF.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(ws): activate plugin-native Socket.IO Redis adapter config (#2524)"
```

---

### Task 2: Sticky-session handshake cookie in `srv/server.js`

**Files:**
- Modify: `srv/server.js` (append a `cds.on('ws:ready', …)` hook; file currently ends at line 2256, no existing `ws:ready`/`cds.io` usage)
- Test: `test/smoke/websocket-handshake.test.js` (existing route-existence smoke; extend to assert the handshake sets a `JSESSIONID` cookie against a deployed srv)

**Interfaces:**
- Consumes: `cds.io` (exposed by the plugin's `ws:ready` event) and its `.engine` (engine.io server).
- Produces: every engine.io handshake response carries `Set-Cookie: JSESSIONID=<uuid>; Path=/; HttpOnly; SameSite=Lax`. No later task consumes this programmatically; it is a platform-facing behavior verified in Task 5.

- [ ] **Step 1: Write the failing smoke assertion**

Add to `test/smoke/websocket-handshake.test.js` a test that opens the Socket.IO polling handshake against the deployed srv and asserts a `JSESSIONID` cookie comes back. Append inside the existing `describe('WebSocket endpoints', …)`:

```js
it('engine.io handshake sets a JSESSIONID affinity cookie', async () => {
  // Socket.IO v4 polling handshake — the first GET returns the session
  // open packet AND (after this change) a Set-Cookie for Gorouter affinity.
  const res = await fetchWithRetry(
    `${SRV_URL}/socket.io/?EIO=4&transport=polling&namespace=/ws/event-stream`,
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') || '';
  expect(setCookie).toMatch(/JSESSIONID=/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (against a deployed srv — this test self-requires `SMOKE_SRV_URL`; if unset the smoke config skips, so set it to the DEV srv URL to see a real red):

```bash
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  scripts/quiet-run.sh npx vitest run test/smoke/websocket-handshake.test.js
```

Expected: the new test FAILS — no `JSESSIONID` in the handshake response (the hook isn't deployed yet). The two existing route tests still pass. (This red is confirmed after deploy in Task 5; locally the smoke suite has no server to hit.)

- [ ] **Step 3: Add the `ws:ready` hook at the tail of `srv/server.js`**

Append (after the final existing `cds.on(...)` block, at file end):

```js
// #2524 — Gorouter session affinity for Socket.IO. The engine.io handshake is
// multi-request (HTTP polling → WS upgrade); if those requests land on
// different tutorials-srv instances the handshake flaps. Stamping a JSESSIONID
// cookie on the handshake response pins the client to one instance for the
// connection's lifetime. This is complementary to the Redis adapter (Task 1):
// affinity fixes handshake integrity; the adapter fixes cross-instance fan-out.
// Scoped to the engine.io handshake only — does not touch application cookies.
cds.on('ws:ready', () => {
  const { randomUUID } = require('node:crypto');
  cds.io?.engine?.on('initial_headers', (headers /*, req */) => {
    headers['set-cookie'] = [
      `JSESSIONID=${randomUUID()}; Path=/; HttpOnly; SameSite=Lax`,
    ];
  });
});
```

- [ ] **Step 4: Verify it loads without error locally**

Run:

```bash
node -e "process.env.CDS_ENV='development'; require('@sap/cds'); const fs=require('node:fs'); const s=fs.readFileSync('srv/server.js','utf8'); if(!/ws:ready/.test(s)) throw new Error('hook not present'); if(!/initial_headers/.test(s)) throw new Error('initial_headers not wired'); console.log('hook present OK');" \
  && scripts/quiet-run.sh npm test
```

Expected: `hook present OK` then the unit suite stays green (the hook only fires when the plugin emits `ws:ready`, which is harmless locally). Do NOT attempt to assert the cookie locally — the plugin's Redis path and the deployed multi-instance context are what this proves; the cookie assertion is a deployed-only smoke (Task 5).

- [ ] **Step 5: Commit**

```bash
git add srv/server.js test/smoke/websocket-handshake.test.js
git commit -m "feat(ws): set JSESSIONID affinity cookie on engine.io handshake (#2524)"
```

---

### Task 3: MTA — provision `redis-cache` (standard) and bind to both srv modules

**Files:**
- Modify: `.deploy/mta.yaml` — add the `tutorials-redis-websocket` resource (after the last resource, `tutorials-objectstore`, at line 556); add a `requires` entry to `tutorials-srv` (after line 169) and to `tutorials-srv-qa` (after line 220); add the QA channel-key env-var property to the `tutorials-srv-qa` `properties` block (after line 212)

**Interfaces:**
- Consumes: `cds.env.requires["redis-websocket"]` from Task 1 (resolved by the binding this task creates); `cds.env.websocket.adapter.options.key` from Task 1 (overridden per-module here).
- Produces: a bound `redis-cache` instance named `tutorials-redis-websocket`; `tutorials-srv` broadcasts on channel key `socket.io`, `tutorials-srv-qa` on `socket.io-qa`.

- [ ] **Step 1: Add the managed-service resource**

Append to `.deploy/mta.yaml` immediately after the `tutorials-objectstore` resource (after line 556, at the end of the `resources:` list), matching the existing resource indentation:

```yaml
  # Redis (Socket.IO adapter) for cross-instance WebSocket fan-out (#2524).
  # Shared by tutorials-srv and tutorials-srv-qa; broadcast isolation between
  # them is by distinct adapter channel key (socket.io vs socket.io-qa), not a
  # second instance. Plan `standard` in every environment.
  - name: tutorials-redis-websocket
    type: org.cloudfoundry.managed-service
    parameters:
      service: redis-cache
      service-plan: standard
      service-name: tutorials-redis-websocket
```

- [ ] **Step 2: Bind Redis to `tutorials-srv`**

In the `tutorials-srv` module's `requires:` block, add after the `tutorials-objectstore` line (line 169):

```yaml
      - name: tutorials-redis-websocket   # Socket.IO Redis adapter (#2524)
```

- [ ] **Step 3: Bind Redis to `tutorials-srv-qa` and set its distinct channel key**

In the `tutorials-srv-qa` module's `requires:` block, add after the `tutorials-credstore` line (line 220):

```yaml
      - name: tutorials-redis-websocket   # Socket.IO Redis adapter (#2524) — shared instance, distinct channel key
```

In the same module's `properties:` block, add after the `USE_GITHUB_APP` property (after line 212):

```yaml
      # #2524 — QA shares the one tutorials-redis-websocket instance with
      # tutorials-srv. Override the adapter channel-key prefix so QA and primary
      # broadcasts never collide on the shared Redis. package.json sets
      # cds.websocket.adapter.options.key="socket.io"; this env var wins at
      # runtime (CDS env override) for srv-qa only.
      CDS_WEBSOCKET_ADAPTER_OPTIONS_KEY: socket.io-qa
```

- [ ] **Step 4: Validate the MTA descriptor parses and the wiring is correct**

Run:

```bash
yq '.resources[] | select(.name=="tutorials-redis-websocket")' .deploy/mta.yaml \
  && echo "--- srv requires ---" \
  && yq '.modules[] | select(.name=="tutorials-srv").requires[].name' .deploy/mta.yaml \
  && echo "--- srv-qa requires ---" \
  && yq '.modules[] | select(.name=="tutorials-srv-qa").requires[].name' .deploy/mta.yaml \
  && echo "--- srv-qa qa key ---" \
  && yq '.modules[] | select(.name=="tutorials-srv-qa").properties.CDS_WEBSOCKET_ADAPTER_OPTIONS_KEY' .deploy/mta.yaml
```

Expected: the resource block prints with `service: redis-cache` / `service-plan: standard`; both `requires` lists include `tutorials-redis-websocket`; the srv-qa key prints `socket.io-qa`. (No mtaext edits are needed — none of `dev/qa/prod.mtaext` overrides these resources or the srv-qa module, and `standard` is used everywhere so there is no per-env plan override.)

- [ ] **Step 5: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "feat(mta): provision + bind redis-cache for Socket.IO adapter (#2524)"
```

---

### Task 4: Docs + stale-comment updates

**Files:**
- Modify: `docs/developers/architecture/scaling-playbook.md` (row #4 — mark resolved)
- Modify: `srv/lib/content-cache-coherence.js:20` (comment now conditionally false)
- Modify: `deploy/prod.mtaext:34-39` (the "no sticky sessions or Redis adapter" warning under item #1 is now addressed by this PR; item #2 rate limiters still stand)
- Modify: `docs/superpowers/specs/2026-09-29-websocket-scaling-2524-design.md` (correct the two "instances: 4" references — prod is actually `instances: 2`)

**Interfaces:**
- Consumes: the behavior delivered by Tasks 1-3.
- Produces: nothing consumed by later tasks (doc-only).

- [ ] **Step 1: Mark scaling-playbook row #4 resolved**

Open `docs/developers/architecture/scaling-playbook.md`, find row #4 (WebSocket sticky sessions, options a/b/c). Replace the open "three options" text with a resolved note: chosen path is **A+B** — sticky sessions (JSESSIONID on the engine.io handshake) **plus** the plugin-native Socket.IO Redis adapter (`@socket.io/redis-adapter` over a shared `redis-cache` standard instance) — shipped in #2524; link the PR/issue. Keep the row; do not delete it.

- [ ] **Step 2: Update the content-cache-coherence comment**

In `srv/lib/content-cache-coherence.js`, the comment at line 20 claims "no pub/sub bus exists; websocket has no Redis adapter." Reword to: a Redis pub/sub bus now exists **for the websocket Socket.IO adapter** (#2524), but cache-coherence deliberately does **not** use it — wiring cache invalidation onto Redis is a separate concern (scaling-playbook row #5, out of scope here). Do NOT change any code in this file.

- [ ] **Step 3: Update the prod.mtaext scaling warning**

In `deploy/prod.mtaext`, the comment block at lines 34-43 warns against raising `instances` above 2 for two reasons. Reason #1 (WebSocket has no sticky sessions or Redis adapter) is resolved by #2524 — update it to say fan-out is now Redis-backed and handshakes are sticky, so the WebSocket constraint no longer blocks scaling. Leave reason #2 (in-process rate limiters) intact — it still gates raising instances. Do NOT change the `instances: 2` value itself.

- [ ] **Step 4: Correct the spec's instance count**

In `docs/superpowers/specs/2026-09-29-websocket-scaling-2524-design.md`, two lines say prod wants `instances: 4` (the Problem section around line 20-21, and the Rejected-approaches "(c)" note around line 92). The actual `deploy/prod.mtaext` value is `instances: 2`. Change both "4" references to "2" and adjust the surrounding wording so the argument (pinning to 1 caps throughput; prod already runs multi-instance) still reads correctly at 2.

- [ ] **Step 5: Verify no stale claim remains, then commit**

Run:

```bash
grep -rniE "no redis adapter|no sticky session|instances: 4|instances 4" \
  docs/developers/architecture/scaling-playbook.md \
  srv/lib/content-cache-coherence.js \
  deploy/prod.mtaext \
  docs/superpowers/specs/2026-09-29-websocket-scaling-2524-design.md
```

Expected: no matches (every stale claim updated). Then:

```bash
git add docs/developers/architecture/scaling-playbook.md srv/lib/content-cache-coherence.js deploy/prod.mtaext docs/superpowers/specs/2026-09-29-websocket-scaling-2524-design.md
git commit -m "docs(ws): mark scaling row #4 resolved; refresh stale WS-adapter comments (#2524)"
```

---

### Task 5: DEV fan-out verification (the actual thing — gates the PR)

**Files:** none modified — this task is the deployed proof that Tasks 1-4 work at N=2.

**Interfaces:**
- Consumes: everything from Tasks 1-4, deployed to DEV from a fresh `origin/DEV`-based build.
- Produces: recorded evidence that a completion emitted on one instance reaches a WS client on another, and that handshake success stays green at 2 instances. This is the gate; the PR opens only after it passes.

- [ ] **Step 1: Confirm CF target and fetch before deploy**

Run:

```bash
cf target
git fetch origin
```

Expected: `cf target` shows the **DEV** space (`tutorial-system` / dev, `eu10-005`) — NOT prod. If it shows prod, stop and re-target. Pause the sap-devs scheduler for the duration of the deploy so the target can't drift.

- [ ] **Step 2: Verify Redis entitlement/quota before provisioning**

Run:

```bash
cf marketplace -e redis-cache
```

Expected: the `standard` plan is listed and available in the DEV space (entitlement propagated). If `standard` is absent, stop — the binding will fail at deploy.

- [ ] **Step 3: Build + deploy A+B to DEV**

Build the full site first (Hugo before mbt), then deploy. Point `CAP_BASE_URL` at the deployed DEV backend as the repo's deploy convention requires:

```bash
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
QR="$(pwd)/scripts/quiet-run.sh"
"$QR" npm run build:all
cd .deploy && "$QR" mbt build && "$QR" cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f ; cd -
```

Expected: deploy succeeds; the `tutorials-redis-websocket` service instance is created and bound. Confirm the binding resolved (this is spec open-item #1 — `vcap.label` resolution):

```bash
cf services | grep tutorials-redis-websocket
cf env tutorials-srv | grep -iA3 redis
```

Expected: the service shows bound to `tutorials-srv`; `VCAP_SERVICES` contains a `redis-cache` entry. If the plugin can't resolve it by label, check the srv logs for the `websocket/redis` connection check and fall back to matching by instance name (`cds.env.requires.redis-websocket.name`).

- [ ] **Step 4: Confirm the adapter actually mounted (not silently in-memory)**

Run:

```bash
cf logs tutorials-srv --recent | grep -iE "websocket|redis|adapter|ws:ready"
```

Expected: log lines showing the Redis connection check passed and the Socket.IO adapter was mounted (`USER=vcap` on CF activates it). If it says the adapter is disabled / in-memory, the binding didn't resolve — fix before proceeding. This is the single most important check: an in-memory adapter at N>1 is exactly the bug, and it fails silently.

- [ ] **Step 5: Scale srv to 2 and prove cross-instance fan-out**

```bash
cf scale tutorials-srv -i 2
```

Then, with two instances live:
1. Open a WS client to `/ws/display` for a chosen `legacyId` (via the approuter URL so affinity applies). Record which instance holds it — the `JSESSIONID` cookie in the handshake response, cross-referenced with `cf logs` / `__VCAP_ID__`.
2. Drive a completion for that same `legacyId` (through the normal completion path) — repeat until the completion transaction demonstrably runs on the **other** instance (check logs for which instance processed it).
3. Confirm the WS client receives `tutorialCompleted` even when emitter ≠ client's instance.

Expected: the client receives the event across instances. **If it does not, the fix is not working — do not open the PR.** Record the instance IDs (emitter vs holder) as the evidence.

- [ ] **Step 6: Handshake load test at 2 instances (proves sticky sessions)**

Run:

```bash
scripts/quiet-run.sh npm run loadtest:ws
```

Expected: `ws_session_errors` stays within threshold and the 101 handshake check passes — sticky sessions hold the multi-request handshake together at N=2. Also run the deployed smoke assertion from Task 2:

```bash
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  scripts/quiet-run.sh npx vitest run test/smoke/websocket-handshake.test.js
```

Expected: all three smoke tests pass, including the new `JSESSIONID` assertion (now green post-deploy).

- [ ] **Step 7: Open the PR to DEV**

Only after Steps 5-6 pass. Push the branch and open the PR with `gh pr create --base DEV`, citing #2524, the spec path, and the recorded fan-out evidence (emitter/holder instance IDs, loadtest summary). Never direct-merge; PR review is required.

---

## Notes for the executor

- **Do not** wire Redis into `content-cache-coherence.js` or the rate limiters — explicitly out of scope (spec §Scope boundaries).
- **Do not** change emit sites (`srv/developer-service.js:822-838`) or the WS service `.cds` definitions.
- **Windows/worktree line endings:** after any subagent edit, verify files did not flip LF→CRLF (`file <path>`) and normalize before commit.
- **srv-qa cp-list audit** is NOT triggered here — no `srv/lib/` runtime file changes (the only `srv/lib` touch is a comment in `content-cache-coherence.js`, which is already shipped to srv-qa if it was a dep; confirm it's unchanged in behavior).
