# Live Probing Runbook

## What

How to verify a fix against the **real** deployed binding or running service instance **before** opening the PR — instead of patch-deploy-reload-guess-repeat.

Two probe modes:

- **Hybrid test** — local Node process, real BTP service bindings injected via `cds bind --exec`. Best when you want a repeatable assertion the test runner can re-execute on every change.
- **`cf ssh` probe** — one-shot script run inside the live `tutorials-srv` container with the actually-deployed code path. Best when something is already broken in DEV and you need to see the platform's *actual* error code (not a 500 that wrapped it).

Always prefer a hybrid test where one already exists. Reach for `cf ssh` when (a) no hybrid test covers the path yet, (b) the bug is in deployed-only wiring (CSP headers, approuter routes, env vars sourced from credstore at boot), or (c) you need to confirm the *deployed* code has the change you expect.

## Why

The Secrets-save 500 was diagnosed across six PRs over three days because each one shipped a "probable" fix and waited on the deploy to find out it was wrong. PR #592 closed the loop with one `cf ssh` probe that surfaced the actual platform error (`415 wrong_content_type_for_jwe`) in five minutes — the wrong layer had been blamed for three days because the wrapped 500 looked identical regardless of cause.

Speculative deploys are slow (≥30 min MTA build + cf push + UI reload) and ambiguous (production catches errors and rewraps them). Probes are fast (<5 min) and show you the actual error message from the platform.

| Method | Setup cost | Per-iteration cost | Surfaces the real error? | Repeatable? |
|---|---|---|---|---|
| Unit test | seconds | seconds | No — binding is mocked | Yes |
| **Hybrid test** | One-time service-key creation | ~3 s per run | **Yes** — real binding | **Yes** |
| **`cf ssh` probe** | None | ~10 s per run | **Yes** — real container | One-shot |
| Speculative deploy | none | ~30 min | Usually no — error wrapped | Yes but expensive |

## When to use this

Before opening a PR that touches:

- BTP service integrations (credstore, XSUAA, destinations, HANA hybrid auth, audit-log, cloud-logging)
- Approuter routes, CSP, OAuth callbacks
- Boot-time config (env vars, credstore-sourced settings, mtaext placeholders)
- Anything where the production error handler wraps the underlying cause into a generic 500 / 502 / 415 / 401

Specifically: **if you've already shipped one fix and it didn't work**, the next attempt MUST be probe-first. The signal "two consecutive PRs missed" is also the signal "I cannot see the real error from where I'm looking — go look from inside."

## Hybrid test pattern

### 1. Wire the service into `.cdsrc-private.json`

Every BTP service you want a hybrid test to reach needs a binding entry. `.cdsrc-private.json` is gitignored so each developer maintains their own.

```bash
# One-time: create a service key (idempotent — no-op if already there)
cf create-service-key tutorials-<svc> tutorials-<svc>-key
```

Add a block to [`.cdsrc-private.json`](../../../.cdsrc-private.json) under `requires["[hybrid]"]`:

```json
"credstore": {
  "binding": {
    "type": "cf",
    "apiEndpoint": "https://api.cf.eu10-005.hana.ondemand.com",
    "org": "tutorial-system",
    "space": "dev",
    "instance": "tutorials-credstore",
    "key": "tutorials-credstore-key"
  },
  "vcap": { "name": "credstore", "tag": "credstore" }
}
```

The `tag` field maps to whatever `getServices({ <svc>: { tag: '<tag>' } })` looks up in your `srv/lib/*.js`. Wrong tag = silent miss.

### 2. Write the test

Hybrid tests live in [`test/hybrid/`](../../../test/hybrid/) and are filtered by the `hybrid` Vitest project (see [`vitest.config.ts`](../../../vitest.config.ts)). Use [`test/hybrid/_guard.js`](../../../test/hybrid/_guard.js) if the test writes to HANA; credstore writes are namespaced and don't need the guard. Always clean up in `afterAll` so the test is idempotent across runs.

Canonical example: [`test/hybrid/credstore-smtp.test.js`](../../../test/hybrid/credstore-smtp.test.js) — write → read → delete → idempotency → unicode stress, all against the real DEV credstore. Use it as a template.

### 3. Run it

```bash
# Login once (DEV space — never PROD for write-y tests)
cf login -a https://api.cf.eu10-005.hana.ondemand.com -o tutorial-system -s dev

# Run the test with live bindings injected
ALLOW_HYBRID_WRITES=true \
  npx cds bind --exec -- npx vitest run test/hybrid/<file>.test.js
```

`cds bind --exec` resolves every `requires.[hybrid].*` block, fetches the matching service-key credentials, builds a `VCAP_SERVICES` env var, and starts the child process with it. From the child's perspective, the binding is indistinguishable from a deployed `tutorials-srv` boot.

### 4. Commit the test alongside the fix

If the path you just fixed didn't have a hybrid test before, **add one in the same PR**. The missing test IS the architectural issue — every "platform-default flip" failure in this repo has been a hybrid-test gap. Closing the gap is half the fix.

## `cf ssh` probe pattern

When you need to see what the deployed code actually does, run a script inside the running container.

### 1. Write a probe script

Probe scripts are throwaway — they import the real module from `/home/vcap/app/`, call the failing path with verbose logging, and print the actual error name + message + cause:

```javascript
// /tmp/probe-<name>.mjs — runs inside tutorials-srv
import { <fn> } from '/home/vcap/app/srv/lib/<module>.js';

try {
  console.log('[probe] calling <fn>');
  const result = await <fn>(/* args that reproduce the bug */);
  console.log('[probe] OK:', result);
} catch (err) {
  console.log('[probe] FAILED:', err.name, err.message);
  console.log('[probe] stack:', (err.stack || '').split('\n').slice(0, 8).join('\n'));
  if (err.cause) {
    console.log('[probe] cause:', err.cause.name, err.cause.message, err.cause.code);
  }
}
```

### 2. Pipe it into the container and run

```bash
cat /tmp/probe-<name>.mjs | cf ssh tutorials-srv -c \
  'cat > /home/vcap/app/probe.mjs && \
   cd /home/vcap/app && \
   /home/vcap/deps/0/bin/node probe.mjs 2>&1; \
   rm probe.mjs'
```

Notes:

- The buildpack puts node at `/home/vcap/deps/0/bin/node` — not on `$PATH` in the ssh shell.
- `/home/vcap/app/package.json` has `"type": "module"`, so probe scripts MUST use `.mjs` or ESM syntax.
- The script + cleanup all run in one `cf ssh -c` invocation; the container is otherwise unmodified.

### 3. (Optional) Patch the deployed code and re-probe

For "is my fix actually going to work?" verification, temporarily overwrite the deployed file with your branch's version, re-probe, then restore:

```bash
# Push your local fix into the container, saving the original
cat srv/lib/<module>.js | cf ssh tutorials-srv -c \
  'cp /home/vcap/app/srv/lib/<module>.js /home/vcap/app/srv/lib/<module>.js.OLD && \
   cat > /home/vcap/app/srv/lib/<module>.js'

# Re-run your probe — should now succeed
cat /tmp/probe-<name>.mjs | cf ssh tutorials-srv -c \
  'cat > /home/vcap/app/probe.mjs && cd /home/vcap/app && \
   /home/vcap/deps/0/bin/node probe.mjs 2>&1; rm probe.mjs'

# Restore the original — the temporary patch dies on next restart anyway,
# but be tidy
cf ssh tutorials-srv -c \
  'cp /home/vcap/app/srv/lib/<module>.js.OLD /home/vcap/app/srv/lib/<module>.js && \
   rm /home/vcap/app/srv/lib/<module>.js.OLD'
```

The fix ships through the normal PR + MTA deploy path. The temporary patch is just to prove the fix works before paying for a deploy.

### 4. What you'll see

The probe surfaces the actual platform error — the thing the production error handler wrapped. Examples this approach has surfaced in this repo:

- `415 wrong_content_type_for_jwe` (credstore — payload encryption required JWE body, not plain JSON) — see [PR #592](https://github.com/sap-tutorials/tutorials-ims/pull/592)
- `TypeError: "pkcs8" must be PKCS#8 formatted string` (jose import — binding shipped raw base64-DER, fixture shipped PEM) — same PR
- `dispatcher` option silently dropped by global `fetch` (Node browser-spec wrapper) — see [PR #588](https://github.com/sap-tutorials/tutorials-ims/pull/588)

Every one of those was invisible from the production logs — they all showed as a generic 500.

## Anti-patterns

- **"My unit tests pass, so the fix is verified."** Unit tests mock the binding. Mocks never catch platform-shape flips. The only path that catches them is a probe against the real binding.
- **"Another agent said it's verified live."** Re-probe yourself. [feedback_verified_live_means_reload_after_deploy.md](https://github.com/sap-tutorials/tutorials-ims/blob/main/CLAUDE.md) — the original "verified live" claim in PR #586 was wrong; the next agent's "verified live" in PR #588 was wrong; PR #592 was the first to actually probe before claiming.
- **"I'll just deploy and check."** A round-trip deploy costs ~30 min. A probe costs <5 min. If you're tempted to deploy speculatively, write the probe instead.
- **Probing without cleanup.** Always delete temp files and revert in-container patches. The container is shared; leftover files are someone else's debugging nightmare.

## See also

- [Testing Guide](testing-guide.md) — unit / hybrid / smoke layering
- [Runtime Config](runtime-config.md) — how credstore + env vars resolve at boot
- [Secrets Tracking](secrets-tracking.md) — what runs through credstore
- [PR #592](https://github.com/sap-tutorials/tutorials-ims/pull/592) — the case study this runbook was extracted from
