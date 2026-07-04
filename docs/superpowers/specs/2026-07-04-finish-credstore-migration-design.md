# Finish the credstore migration for CONTENT_API_KEY, GITHUB_DISPATCH_TOKEN, APPROUTER_URL

**Date:** 2026-07-04
**Status:** Design — approved for planning
**Related:** PRs #683 (YOUTUBE_API_KEY), #871 (REBUILD_API_KEY runtime), #904 (REBUILD_API_KEY plumbing strip); issue reference #903 (2026-07-01→02 drift outage)

## Problem

Three deploy-time secrets are still injected into MTA extension descriptors through the `envsubst` plumbing that earlier migrations left partially in place:

- `CONTENT_API_KEY` — read by `srv/lib/content-store.js:229` via `resolveSecret`
- `GITHUB_DISPATCH_TOKEN` — read by `srv/lib/rebuild-trigger.js:68` via `resolveSecret`
- `APPROUTER_URL` — **zero runtime readers** (`mta.yaml:224` explicitly documents this)

For the first two, the runtime is already credstore-first: `resolveSecret` reads credstore, then falls back to `process.env[alias]`. The `envsubst`-populated env var is therefore a redundant second write channel — exactly the "two stores can drift" class that produced the 2026-07-01→02 HTTP 401 outage that #904 fixed for `REBUILD_API_KEY`.

For `APPROUTER_URL`, no code path reads it. It exists in `mta.yaml` and the three mtaext files only because `deploy.yml`'s envsubst allowlist expects it.

A local `cf deploy` against `tutorial-system/dev` on 2026-07-04 failed at descriptor resolution because these three placeholders can only be resolved when `envsubst` runs with all three env vars set — a CI-only pathway. The workstation cannot deploy without either (a) manually exporting values that are supposed to live in credstore, or (b) finishing the migration. This spec is (b).

## Goal

Eliminate the envsubst injection path for these three keys. Credstore becomes the sole write channel for `CONTENT_API_KEY` and `GITHUB_DISPATCH_TOKEN`. `APPROUTER_URL` is removed entirely from the runtime deploy surface (its per-env values live in GitHub Actions `vars`, consumed only by smoke tests and the rebuild-content dispatch target).

## Non-goals

- **No runtime code changes.** `resolveSecret` and its env-fallback tier stay exactly as they are. Local hybrid dev (`cds bind --exec`) and unit tests continue to work.
- **No consolidation of the two resolver copies** (`approuter/lib/credstore-secret.js` CJS + `srv/lib/secret-resolver.js` ESM). Legitimate follow-up refactor; scope creep here.
- **No GitHub Actions secrets cleanup.** `secrets.CONTENT_API_KEY`, `secrets.DISPATCH_TOKEN`, `secrets.APPROUTER_URL_{DEV,QA,PROD}` become dead once this PR merges. Flagged in the PR body for manual removal by a maintainer with GH admin, but not gating.
- **No credstore alias creation for `APPROUTER_URL`.** It's a public routable hostname, not credential material, and nothing reads it at runtime.

## Architecture

### Before

```
CI deploy path:                     Local deploy path:
GH secret ──envsubst──▶ mtaext      $CONTENT_API_KEY ──envsubst──▶ mtaext
                        │                                          │
                        ▼                                          ▼
             CF app env var ──┐                       CF app env var ──┐
                              │                                        │
                              ▼                                        ▼
                    resolveSecret() ── credstore (primary) ── env (fallback)
```

Two independent write channels feed one env var; a parallel credstore write channel via the admin UI takes precedence at read time. When channels disagree, runtime silently prefers credstore, so an envsubst-updated env var goes unread — the 2026-07-01→02 outage shape.

### After

```
CI deploy path:              Local deploy path:            Admin path:
   (removed)                    (removed)              admin UI ──▶ credstore
                                                                       │
                                                                       ▼
                                                    resolveSecret() ── credstore
                                                                       │  (env fallback
                                                                       │   remains for
                                                                       │   local hybrid
                                                                       │   only)
                                                                       ▼
                                                                    secret value
```

One authoritative write channel (admin UI → credstore). The env-fallback tier in `resolveSecret` stays wired — it's the only path for local `cds bind --exec` runs, tests, and true break-glass rollback — but no deploy path writes to it, so it can't drift.

## Components changed

### Deploy descriptors — 3 files, 9 lines of property removed

- `deploy/dev.mtaext:14` (`CONTENT_API_KEY`), `:15` (`GITHUB_DISPATCH_TOKEN`), `:40` (`APPROUTER_URL`), plus surrounding comment blocks.
- `deploy/qa.mtaext:8`, `:9`, `:19` — same three properties.
- `deploy/prod.mtaext:10`, `:11`, `:22` — same three properties.

### Base MTA descriptor — 2 files, 4 lines

- `mta.yaml:121` (`CONTENT_API_KEY: ""`), `:127` (`GITHUB_DISPATCH_TOKEN: ""`), `:227` (`APPROUTER_URL: ""`). Rewrite the surrounding comment block (currently ~lines 200-234) to add a "finish credstore migration" entry to the rollout history, following the shape #904 established for `REBUILD_API_KEY`.
- `.deploy/mta.yaml:89` — mirror declaration of `GITHUB_DISPATCH_TOKEN: ""` on `tutorials-srv`. (No `CONTENT_API_KEY` or `APPROUTER_URL` mirror exists in `.deploy/mta.yaml`, so nothing else to strip there.)

### CI workflow — `.github/workflows/deploy.yml`, 2 blocks

- **Precheck job** lines 28-37 (`validate-mtaext-substitution`) — remove the three dummy-value env lines (`CONTENT_API_KEY: dummy-content`, `APPROUTER_URL: https://dummy.example.com`, `GITHUB_DISPATCH_TOKEN: dummy-token`); drop those three vars from the `envsubst '$…'` allowlist. Job survives to validate the mtaext parses.
- **Deploy step** lines 359-390 — drop the `deploy-vars` step's `approuter_url` output (dev/qa/prod switch); drop the `env:` block feeding real secrets into `Resolve mtaext placeholders`; drop those three vars from the `envsubst '$…'` allowlist. Keep the grep-guard for unresolved `${…}` so a future stray placeholder still fails loudly.

### Runbooks — 2 files

- `docs/developers/operations/mta-deployment.md` — replace the four-var-export + envsubst incantation (~lines 400-420) with a plain `cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f` and a callout: "Secrets live in credstore; seed via `/admin-ui/#secrets-display` before first deploy of a new env."
- `docs/developers/operations/github-dispatch-pat-rotation.md` lines 70, 72 — remove `secrets.DISPATCH_TOKEN` as a write target for the rotation flow (leave the rotation-owner narrative). GH secret becomes dead post-merge.

### Root CLAUDE.md

The "Local manual deploy with placeholders" note (~line 90 of `CLAUDE.md`) documents the exact incantation this PR removes. Trim it to `cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f`; drop the four-env-var export list.

### Files intentionally NOT touched

- `approuter/lib/credstore-secret.js`, `srv/lib/secret-resolver.js`, `srv/lib/credstore.js` — resolver internals unchanged.
- `scripts/seed-secrets.cjs` — both aliases already registered at lines 49 (`GITHUB_DISPATCH_TOKEN`) and 57 (`CONTENT_API_KEY`).
- `.github/workflows/rebuild-content.yml`, `rebuild-content-qa.yml`, `content-drift-check.yml` — their `secrets.CONTENT_API_KEY` and `vars.APPROUTER_URL_*` reads are CI-time HTTP calls (publish + smoke), not deploy substitution. Legitimate; leave alone.
- Any test file — no runtime code changes.

## Rollout

### Step 0 — Pre-flight verification (BEFORE any code change)

For each of DEV, QA, PROD:

1. `cf target -o tutorial-system -s <env>` — verify space (memory rule: two same-prefix apps in different spaces).
2. Open `/admin-ui/#secrets-display` in that env's approuter. Confirm both `CONTENT_API_KEY` and `GITHUB_DISPATCH_TOKEN` aliases exist AND their "last read" timestamps show recent runtime use (proves what the resolver is actually reading).
3. **If either alias is empty or missing:** halt the migration. Seed via the admin UI first. The value must match what the runtime is currently accepting — since GH Actions secrets are write-only, the correct source is either (a) the current CF app env var (`cf env tutorials-srv | grep CONTENT_API_KEY` — envsubst has been writing it there on every CI deploy), or (b) the maintainer who owns the rotation (see `docs/developers/operations/github-dispatch-pat-rotation.md` for `GITHUB_DISPATCH_TOKEN`).
4. **Cross-check on DEV only** (a functional probe, not just presence): `curl -H "x-api-key: <value-from-credstore>" -X POST -d '{}' https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/content/publish` should return 400 (bad request — accepted the key, rejected the empty payload), not 401 (rejected the key). This proves the credstore value matches what `contentAuthMiddleware` accepts.
5. Record the three per-env probe results in the PR body as a checklist.

If Step 0 fails for **any** env, no code change lands. Seed credstore first, re-run the probe, then start the PR.

### Step 1 — Implementation (three commits on the migration branch)

1. **Commit 1: strip mtaext + mta.yaml base declarations.** All 4 files (`deploy/{dev,qa,prod}.mtaext` + `mta.yaml` + `.deploy/mta.yaml`) in one commit. 13 lines removed + comment rewrites.
2. **Commit 2: strip deploy.yml envsubst plumbing.** Precheck block + deploy step block. Verify locally with `envsubst < deploy/dev.mtaext | grep '\${' && echo BAD || echo OK` — should print OK.
3. **Commit 3: update runbooks + root CLAUDE.md.** Docs-only commit keeps the code-change diff clean.

### Step 2 — PR

- Push branch; `gh pr create --draft` targeting `main`.
- PR body: problem statement (link to 2026-07-04 deploy failure), what changed (three keys stripped, matching earlier #683/#871/#904 pattern), Step 0 probe results per env, out-of-scope callouts (env-fallback code path stays; GH secrets cleanup deferred to maintainer).
- Mark ready-for-review after CI green.
- Await user approval before merge.

### Step 3 — Post-merge deploy (outside this spec's scope; tracked as Task #7 in the ambient task list)

Return to the primary tree on `main` (memory rule: deploy from primary tree, never a worktree), `git pull`, then `npm run build:all` (with `CAP_BASE_URL` pointed at the deployed DEV srv), then `mbt build`, then `cf deploy` — this time with no envsubst step, no placeholder resolution required. Follow with a smoke curl and `gh workflow run rebuild-content.yml -f mode=full`.

## Rollback

- If `cf deploy` after merge fails for any reason: `cf deploy -i <operation-id> -a abort`. The descriptor is source-controlled; a `git revert` on `main` restores the envsubst plumbing.
- If runtime 503s post-deploy on either endpoint using these keys: `/admin-ui/#secrets-display` → invalidate cache → re-seed alias. `invalidateSecret` hot-flushes; no restage needed.
- Break-glass last resort only: `cf set-env tutorials-srv CONTENT_API_KEY <value> && cf restage tutorials-srv` reintroduces the drift class, so treat as emergency-only.

## Testing

No new tests. Same rationale as #904:

- Plumbing change; no new runtime code.
- Existing `test/unit/approuter-credstore-secret.test.js` (13 tests) covers the four-tier resolve path.
- Equivalent coverage exists for `srv/lib/secret-resolver.js`.
- `content-store.js` and `rebuild-trigger.js` have integration tests that exercise the `resolveSecret` call sites.

The verification signal is Step 0's live-credstore probe, executed on all three envs before the PR opens.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Credstore in a target env has stale / wrong value; envsubst was masking it | Medium (that's exactly the drift class #904 warned about) | Step 0 probe on all three envs before touching code; functional cross-check on DEV |
| GH `secrets.APPROUTER_URL_*` gets deleted by cleanup before smoke tests are updated | Low | `vars.APPROUTER_URL_*` (the actual smoke-test source) is a separate object; PR body explicitly says "don't delete `vars`" |
| Someone reintroduces envsubst for a fourth key later | Low-medium | `deploy.yml`'s grep-guard for unresolved `${…}` stays; comment blocks in `mta.yaml` and `dev.mtaext` explicitly document the drift class |
| Local hybrid dev breaks because `.env` no longer sets `CONTENT_API_KEY` | Very low | `.env` is developer-owned; the env-fallback tier in `resolveSecret` stays wired, so a local `.env` entry still works |

## Out-of-scope, tracked follow-ups

1. Consolidate `approuter/lib/credstore-secret.js` (CJS) and `srv/lib/secret-resolver.js` (ESM) into a single package under `packages/credstore-secret/`. Flagged in #871's body.
2. GitHub-side cleanup: delete `secrets.CONTENT_API_KEY`, `secrets.DISPATCH_TOKEN`, `secrets.APPROUTER_URL_{DEV,QA,PROD}` once this PR is verified in DEV + QA + PROD. Requires GH admin.
3. Root CLAUDE.md's `.claude/scheduled_tasks.json`-style notes about the four-env-var export are now stale in memory too — the next `sap-devs inject` or memory-sweep should catch it.
