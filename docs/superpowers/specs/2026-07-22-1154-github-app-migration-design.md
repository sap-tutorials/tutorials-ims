# Migrate GitHub PATs → `sap-tutorials-builder` GitHub App (#1154)

**Status:** Approved design — ready for implementation plan.
**Date:** 2026-07-22
**Issue:** [#1154](https://github.com/sap-tutorials/tutorials-ims/issues/1154)
**Scope:** All three phases (CI activation + runtime code + Contribution-repo migration).

## Problem

Three classic GitHub PATs authenticate the platform to github.com. SAP org policy
forces short PAT expiry, rotation is manual and tied to a single human account, and
OSPO guidance recommends migrating long-term technical-user integrations to GitHub
Apps. A GitHub App gives 1-hour auto-rotating tokens, org-owned identity that
survives staff departure, per-repo + per-permission scoping, and a separate
rate-limit pool.

**Out of scope:** MyPATs (#1132, `pat_...`) — tokens *our app mints for its own
users*; no relationship to github.com. Untouched here.

## The three GitHub PATs today

| Token | Consumers | Scope needed |
| --- | --- | --- |
| `TUTORIALS_GITHUB_TOKEN` | **CI:** `rebuild-content.yml`, `rebuild-content-qa.yml`, `content-drift-check.yml`, `deploy.yml`, `scripts/parsers/github.ts`. **Runtime:** `srv/jobs/fetch-samples-job.js`, `srv/jobs/fetch-help-docs-job.js` (read via `resolveSecret`) | Contents:read, Metadata:read |
| `GITHUB_DISPATCH_TOKEN` | **Runtime:** `srv/lib/rebuild-trigger.js` — fires `workflow_dispatch` on `rebuild-content.yml` | **Actions:write** |
| `TUTORIALS_POC_DISPATCH_TOKEN` | Each `*-Contribution` repo's `notify-qa.yml.template` — fires `repository_dispatch` at `tutorials-ims` | Contents:write (dispatch) |

## Prior scaffolding (already merged)

- `rebuild-content.yml:205`, `rebuild-content-qa.yml:59`, `content-drift-check.yml:134`
  each carry an `actions/create-github-app-token@v1` step gated on repo variable
  `vars.USE_GITHUB_APP == 'true'`, falling back to `secrets.TUTORIALS_GITHUB_TOKEN`.
- `deploy.yml` uses `secrets.TUTORIALS_GITHUB_TOKEN || github.token` — **not** wired to
  the App and does not need to be (MTA build needs only same-repo access, which
  `github.token` supplies).
- Docs: `docs/historic/github-app-migration.md` + `docs/developers/operations/github-app-setup.md`
  (org-admin + repo-maintainer runbook, App scoped Contents:read + Metadata:read).

**So Phase 1 (CI fetch) is a config-only flip. Phase 2 (runtime) needs real code.
Phase 3 needs a template change + App scope widening.**

## Architecture — one shared token-minting module

A GitHub App **installation token carries all the App's granted permissions in a
single 1-hour token**. Every runtime consumer mints the *same* token, so this needs
**one** module, not three per-consumer flows.

### New: `srv/lib/github-app-token.js`

```
getInstallationToken() → Promise<string|null>
```

- Resolves `TUTORIALS_APP_ID`, `TUTORIALS_APP_INSTALLATION_ID`,
  `TUTORIALS_APP_PRIVATE_KEY` via existing `secret-resolver.js` (credstore-first,
  env fallback, 5-min TTL) — identical path to every other runtime secret.
- Signs an RS256 **App JWT** with `jose` (`SignJWT` + `importPKCS8`; both already
  exported by the production dep `jose@6.2.3` — no new dependency). Claims:
  `iss = appId`, `iat = now-60s` (clock-skew guard), `exp = now+9min` (GitHub caps
  App JWTs at 10 min).
- `POST https://api.github.com/app/installations/{installationId}/access_tokens`
  with `Authorization: Bearer <appJwt>` → `{ token, expires_at }`.
- Caches the installation token on a `globalThis` `Symbol.for(...)` singleton
  (matching `secret-resolver.js` / `credstore.js` module-multiplicity defense),
  expiring **5 minutes before** the real `expires_at` so an in-flight request never
  uses a token that expires mid-call.
- **Fail-open:** returns `null` on any fault (missing App creds, sign failure,
  non-2xx, network) — consistent with the codebase degrade-to-fallback posture.
  Warns once per TTL window, same idiom as `secret-resolver.js`.
- `invalidateInstallationToken()` — force-flush (admin rotation hook, mirrors
  `invalidateSecret`).
- `_resetForTests()` / `_primeForTests(token, expiresAt)` — test seams matching the
  existing secret-resolver conventions.

### Runtime feature flag: `USE_GITHUB_APP`

Same name as the CI repo variable, read from `process.env.USE_GITHUB_APP`. When
`'true'`, runtime consumers try the App token first; when unset/false, or when the
App token resolves `null`, they use the classic PAT. Instant reversible rollback:
`cf set-env tutorials-srv USE_GITHUB_APP false && cf restart tutorials-srv`.

### Single flag-resolution helper

To keep the flag logic in exactly one place (not copy-pasted into three callers), add:

```
resolveGithubToken(fallbackAlias) → Promise<string|null>
```

in `github-app-token.js`:

```js
// pseudo
if (process.env.USE_GITHUB_APP === 'true') {
  const t = await getInstallationToken();
  if (t) return t;                       // App token wins when available
  // fall through to PAT on null (fail-open)
}
return resolveSecret(fallbackAlias, { logTag });
```

## Wiring (Phase 2)

| File | Change |
| --- | --- |
| `srv/lib/rebuild-trigger.js` | `getDispatchToken()` → `resolveGithubToken('GITHUB_DISPATCH_TOKEN')`. Requires App has **Actions: write**. |
| `srv/jobs/fetch-samples-job.js` | Replace inline `resolveSecret('TUTORIALS_GITHUB_TOKEN')` + env fallbacks with `resolveGithubToken('TUTORIALS_GITHUB_TOKEN')`. |
| `srv/jobs/fetch-help-docs-job.js` | Same replacement. Preserve the existing "missing key → warn, partial fetch" behavior (help.sap.com + ui5.sap.com are unauthenticated). |
| `deploy.yml` | **Untouched.** `github.token` fallback already suffices post-PAT-deletion. |

The two crons keep their `opts.apiKeyOverride` test seam and their `process.env.GITHUB_TOKEN`
CI-injection path (the CI workflow injects the App token *as* `GITHUB_TOKEN`), so the
helper is only consulted when no override/CI-env token is present. Precedence within
each cron becomes: `opts.apiKeyOverride` → `resolveGithubToken(...)` (which itself
honors `USE_GITHUB_APP` then PAT) → `process.env.GITHUB_TOKEN` CI fallback.

## App permission set

| Permission | Reason |
| --- | --- |
| Contents: **read** | tutorial markdown + private `*-Contribution` repos |
| Metadata: **read** | auto-selected |
| Actions: **read/write** | runtime `workflow_dispatch` from `rebuild-trigger.js` (Phase 2) |
| Contents: **write** on `tutorials-ims` | Phase 3 `repository_dispatch` — see tradeoff below |
| Webhook | **OFF** (token-minting identity, not an event consumer) |

## Phase 3 — `TUTORIALS_POC_DISPATCH_TOKEN` (permission-widening tradeoff)

The token lives in each `*-Contribution` repo's `notify-qa.yml.template` and fires
`repository_dispatch` at `tutorials-ims`. Migrating it App-native means the template
mints an App token via `create-github-app-token@v1` instead of using the PAT secret.

**Tradeoff (surfaced explicitly per approval):** `POST /repos/{owner}/{repo}/dispatches`
requires the App to hold **Contents: write** on `tutorials-ims`, widening the App from
read-only. This is the one real scope increase in the migration. Accepted per "all
three phases" decision. The write is narrow (dispatch trigger only) and org-owned.

Template change:
- Add a `Generate GitHub App token` step (gated on the Contribution repo carrying
  `vars.USE_GITHUB_APP == 'true'`) → `actions/create-github-app-token@v1` with
  `owner: sap-tutorials`.
- `peter-evans/repository-dispatch` `token:` becomes
  `${{ steps.app-token.outputs.token || secrets.TUTORIALS_POC_DISPATCH_TOKEN }}`.
- Requires the App **installed on each `*-Contribution` repo** with dispatch access,
  and the two App secrets present in each Contribution repo.

Rollout of Phase 3 is per-repo and independent — flip one Contribution repo, verify a
`repository_dispatch` fires, then propagate.

## Secret registry + credstore

`TUTORIALS_APP_ID`, `TUTORIALS_APP_INSTALLATION_ID`, `TUTORIALS_APP_PRIVATE_KEY` must
exist in **both**:
- **GitHub Actions secrets** (CI — consumed by the `create-github-app-token@v1` steps).
- **BTP Credential Store** (runtime — consumed by `github-app-token.js`).

Add three rows to `scripts/seed-secrets.cjs` `INITIAL_SECRETS` (metadata only — values
loaded via the admin Secrets UI, same as every other credstore secret):
- `TUTORIALS_APP_ID` (kind `github-app-config`)
- `TUTORIALS_APP_INSTALLATION_ID` (kind `github-app-config`)
- `TUTORIALS_APP_PRIVATE_KEY` (kind `github-app-key`)

The private key is a multi-line PEM; `credstore.js writeSecret` already handles
arbitrary string values (JSON-envelope encoded), so no special handling needed.

## Manual walkthrough (org-admin runbook)

Registration is org-admin work only Tom can perform. Deliver as a copy-pasteable
checklist, updating `docs/developers/operations/github-app-setup.md`:

1. Register `sap-tutorials-builder` App (permissions above; webhook OFF).
2. Generate private key (`.pem` downloads once — save it).
3. Note App ID.
4. Install on `sap-tutorials` org (All repositories, or select tutorials* +
   *-Contribution). Note Installation ID from the install URL.
5. Load `TUTORIALS_APP_ID` / `TUTORIALS_APP_INSTALLATION_ID` /
   `TUTORIALS_APP_PRIVATE_KEY` into GitHub Actions secrets **and** the BTP
   Credential Store (via `/admin-ui/#secrets-display`).

## Rollout order (reversible at every step)

1. **Code + docs land** (this PR) — inert until flags flip. Full test coverage.
2. **Tom registers the App** (runbook) → populate CI secrets + credstore.
3. **Phase 1:** set repo variable `USE_GITHUB_APP=true` → CI fetch on App token.
   Verify one `rebuild-content` run shows the `Generate GitHub App token` step ran.
4. **Phase 2:** `cf set-env tutorials-srv USE_GITHUB_APP true && cf restart` →
   runtime dispatch + crons on App token. Verify a dispatch fires + a cron cycle
   authenticates.
5. **Phase 3:** update Contribution-repo templates + install App there; verify a
   `repository_dispatch`.
6. **Cleanup (after ≥1 clean unattended run of each path):** delete
   `TUTORIALS_GITHUB_TOKEN` + `GITHUB_DISPATCH_TOKEN` (Actions secrets + credstore) and
   revoke the underlying classic PATs. Keep `TUTORIALS_POC_DISPATCH_TOKEN` until every
   Contribution repo is migrated.

**Rollback:** unset the flag (repo variable or `cf set-env … false`) at any stage; the
PAT path stays intact until step 6.

## Testing

- **New** `test/unit/github-app-token.test.js`: generate a throwaway RSA keypair with
  `jose`, mock global `fetch`, assert (a) JWT header `alg:RS256` + claims
  `iss/iat/exp`, (b) installation-token POST shape + Authorization Bearer, (c)
  caching (second call within TTL does not re-POST), (d) early-expiry refresh, (e)
  fail-open→null on non-2xx / missing creds / network throw, (f) `USE_GITHUB_APP`
  off → `resolveGithubToken` returns the PAT without minting.
- Extend `rebuild-trigger` test suite: flag-on (App token) + flag-off (PAT) + App
  token null → PAT fallback.
- Extend `fetch-samples-job` + `fetch-help-docs-job` suites for the same three paths
  (using the `apiKeyOverride` seam where present, plus a flag-driven case).
- **Guard test:** assert `scripts/seed-secrets.cjs` includes the three new
  `TUTORIALS_APP_*` registry rows (mirrors existing secret-registry guard, if any).
- Hybrid test (real credstore round-trip of the PEM key) is **optional** — flagged,
  not required for merge.

## Non-goals / explicitly deferred

- `deploy.yml` App wiring (not needed; `github.token` suffices).
- Retiring `TUTORIALS_POC_DISPATCH_TOKEN` before all Contribution repos are migrated.
- MyPATs (#1132) — different system, untouched.
