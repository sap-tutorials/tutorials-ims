# GITHUB_DISPATCH_TOKEN via mtaext — design

**Issue:** [#435](https://github.com/sap-tutorials/tutorials-ims/issues/435) — `GITHUB_DISPATCH_TOKEN` unset on `tutorials-srv`: admin-write rebuild dispatch silently no-ops

**Date:** 2026-06-19

## Problem

`srv/lib/rebuild-trigger.js` reads `process.env.GITHUB_DISPATCH_TOKEN` once at module load. When unset on the deployed `tutorials-srv` app, every admin save logs one boot warning and then silently no-ops the workflow_dispatch call — admin edits invalidate cache, but published `/tutorials/*` and `/browse/` pages don't regenerate until the next push-trigger.

The current rotation runbook ([github-dispatch-pat-rotation.md](../../developers/operations/github-dispatch-pat-rotation.md)) says to recover by running `cf set-env tutorials-srv GITHUB_DISPATCH_TOKEN <PAT>` then `cf restart tutorials-srv`. That works — but `cf restart`/redeploy doesn't restore the variable, so any MTA redeploy or `cf delete-app`/`cf push` cycle drops it again. It already happened once: per [#382](https://github.com/sap-tutorials/tutorials-ims/issues/382) phase F1, three workflow runs were triggered manually because the env var wasn't sticky.

## Goal

`GITHUB_DISPATCH_TOKEN` and `REBUILD_TARGET_ENV` survive every MTA redeploy and `cf restart` automatically, on `dev`, `qa`, and `prod`. No manual `cf set-env` step in the steady-state rotation flow.

## Approach

Promote the env var from "ops-managed via `cf set-env`" to "deploy-managed via `mtaext` + GitHub Actions secret" — the same pattern already used for `CONTENT_API_KEY` and `REBUILD_API_KEY` on `qa.mtaext` and `prod.mtaext`.

### Changes

1. **`deploy/dev.mtaext`** — add to the `tutorials-srv` `properties:` block:

   ```yaml
   GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}
   REBUILD_TARGET_ENV: dev
   ```

2. **`deploy/qa.mtaext`** — same placeholder + `REBUILD_TARGET_ENV: qa`.

3. **`deploy/prod.mtaext`** — same placeholder + `REBUILD_TARGET_ENV: prod`.

4. **`.github/workflows/deploy.yml`** — extend the existing `cf deploy` invocation in the `Deploy MTA` step:

   ```bash
   cf deploy mta_archives/tutorials-poc_${{ steps.version.outputs.version }}.mtar \
     -e deploy/${{ steps.env.outputs.target }}.mtaext \
     --var content-api-key="${{ secrets.CONTENT_API_KEY }}" \
     --var rebuild-api-key="${{ secrets.REBUILD_API_KEY }}" \
     --var approuter-url="${{ steps.deploy-vars.outputs.approuter_url }}" \
     --var github-dispatch-token="${{ secrets.GITHUB_DISPATCH_TOKEN }}" \
     $STRATEGY_FLAGS \
     -f
   ```

5. **Precondition (one-time, manual; owner: Tom):** Add `DISPATCH_TOKEN` to the repo's GitHub Actions secrets (`Settings → Secrets and variables → Actions → New repository secret`). Note: the secret is named `DISPATCH_TOKEN`, **not** `GITHUB_DISPATCH_TOKEN` — GitHub reserves the `GITHUB_` prefix for secret names. The runtime env var on `tutorials-srv` is still `GITHUB_DISPATCH_TOKEN`; only the CI-side secret drops the prefix. Value: the same fine-grained PAT described in the rotation runbook (`actions: write` on `sap-tutorials/tutorials-ims` only). Confirm with `gh secret list --repo sap-tutorials/tutorials-ims | grep DISPATCH_TOKEN` before merging the PR. This must be done before the first deploy that picks up these mtaext changes; otherwise `cf deploy` will pass an empty `--var`, the property resolves to empty string, and the runtime falls back to the current "no-op + boot warning" behavior — i.e. **safe failure mode**, no outage.

6. **Update the rotation runbook** ([docs/developers/operations/github-dispatch-pat-rotation.md](../../developers/operations/github-dispatch-pat-rotation.md)):
   - Replace the per-space `cf set-env` rotation steps with "update the `GITHUB_DISPATCH_TOKEN` GitHub Actions secret, then trigger a redeploy of each environment via the `Build & Deploy` workflow (`.github/workflows/deploy.yml`)."
   - Keep the "test the new token with curl" step.
   - Keep the "boot log line" validation.
   - Add a fallback note: for one-off manual local deploys (`cd .deploy && cf deploy ... -e ../deploy/dev.mtaext`), Tom can pass `--var github-dispatch-token=<value>` or accept that the deployed env var is empty on that single deploy. Same convention as `content-api-key` on prod/qa today.

7. **Update [CLAUDE.md](../../../CLAUDE.md)** — add a one-line gotcha noting that local `cf deploy ... -e ../deploy/dev.mtaext` from `.deploy/` needs `--var github-dispatch-token=...` if the local-deploy operator wants admin-write rebuilds to fire from that deploy.

## Why this approach

Three patterns were considered:

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **mtaext property + `--var` placeholder** (this design) | Mirrors existing `${content-api-key}`/`${rebuild-api-key}` pattern. Survives redeploys. One CI secret rotates all three envs. | The PAT enters CF as a plain env var — same threat model as today, no worse. | **Chosen** |
| User-provided service (`cf cups github-dispatch -p '{"token":"..."}'`) bound to `tutorials-srv` | Rotation = update CUPS, no MTA redeploy. | Adds an unbound resource for one string. Breaks the existing pattern. The other two property-based secrets don't need it either. | Rejected — defer until we have ≥3 such tokens. |
| Hardcode a separate DEV-only PAT directly in `dev.mtaext` (matches `CONTENT_API_KEY: <DEV-content-api-key>`) | Local DEV deploys work without `--var`. | A real GitHub PAT in git is a leak regardless of which CF space it points at. The CONTENT_API_KEY shared-literal is acceptable because that key gates one srv endpoint at a known shape; a PAT gates `actions:write` on the entire repo. | Rejected — DEV uses the same `${github-dispatch-token}` placeholder. |

## Failure modes after this change

| Mode | Symptom | Action |
|---|---|---|
| GH Actions secret unset | Deploy succeeds; `tutorials-srv` boots with `[rebuild-trigger] GITHUB_DISPATCH_TOKEN unset — ...` warning. Admin writes don't trigger rebuilds. | Add the secret, redeploy. (Same graceful-degraded mode as today.) |
| Local manual deploy without `--var` | Same as above for that deploy only. Next CI deploy restores it. | Use CI to redeploy, or pass `--var` next time. |
| PAT expired (90-day default) | GH dispatch returns 401; admin save logs `[rebuild-trigger] dispatch failed`. Admin save itself succeeds. | Rotate per the updated runbook. |
| Wrong `REBUILD_TARGET_ENV` per space | Boot log shows `environment='dev'` on a non-DEV space; admin saves trigger rebuilds against the wrong CF approuter. | Correct the literal in the offending mtaext, redeploy. (Caught by the boot log line during validation.) |

## Out of scope

- Migrating `CONTENT_API_KEY` or `REBUILD_API_KEY` to a different secret-management pattern (CUPS, BTP credential store, etc.).
- Adding pre-flight token validation in `srv/lib/rebuild-trigger.js` beyond the existing boot warning.
- Changing the 90-day rotation cadence.
- Wiring the env var into `cds bind --exec` flows for local hybrid dev (rebuild-trigger no-ops locally already, and that's fine).

## Verification

After deploying with the changes on each environment:

1. `cf logs tutorials-srv --recent | grep rebuild-trigger` should show:

   ```text
   [rebuild-trigger] active — admin writes will dispatch with environment='<dev|qa|prod>'.
   ```

   (Not the "unset" warning.)

2. `cf env tutorials-srv | grep -E "GITHUB_DISPATCH_TOKEN|REBUILD_TARGET_ENV"` shows both vars set, with the env value matching the CF space.

3. Save any mission/group via admin UI; wait 60s; check:

   ```bash
   gh run list --repo sap-tutorials/tutorials-ims --workflow=rebuild-content.yml --limit 1
   ```

   A new in_progress run should appear with `trigger-source: admin-write` in inputs.

4. `cf restart tutorials-srv` (without redeploying) — both env vars persist, boot log line still shows `active`.

## References

- Runbook: [docs/developers/operations/github-dispatch-pat-rotation.md](../../developers/operations/github-dispatch-pat-rotation.md)
- Implementation: [srv/lib/rebuild-trigger.js](../../../srv/lib/rebuild-trigger.js)
- Existing pattern: `${content-api-key}` / `${rebuild-api-key}` in [deploy/prod.mtaext](../../../deploy/prod.mtaext) and [deploy/qa.mtaext](../../../deploy/qa.mtaext)
- Related issue: [#382](https://github.com/sap-tutorials/tutorials-ims/issues/382) phase F1 — manually-fired rebuild runs that motivated this issue
- Memory: `feedback_merge_is_not_deploy` (data change ≠ rebuild trigger)
