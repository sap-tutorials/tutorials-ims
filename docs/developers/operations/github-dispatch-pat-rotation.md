# `GITHUB_DISPATCH_TOKEN` Rotation Runbook

## What

Fine-grained GitHub Personal Access Token used by [`srv/lib/rebuild-trigger.js`](../../../srv/lib/rebuild-trigger.js) to fire `workflow_dispatch` on [`rebuild-content.yml`](../../../.github/workflows/rebuild-content.yml) after admin writes. Keeps `/browse/` SSR'd content fresh within minutes of admin saves to mission/group/featured-flag entities.

Set on the deployed `tutorials-srv` app as the env var `GITHUB_DISPATCH_TOKEN`. When unset, `rebuild-trigger.js` no-ops gracefully (logs one boot warning, falls back to the existing push-trigger cadence on the `rebuild-content.yml` workflow).

## Environment-aware dispatch (`REBUILD_TARGET_ENV`)

The dispatch payload includes an `environment` input (`dev` / `qa` / `prod`) that the `rebuild-content.yml` workflow uses to target the right Cloud Foundry approuter. Set this env var alongside `GITHUB_DISPATCH_TOKEN` on each CF environment so admin writes on QA dispatch a QA rebuild (not a DEV one):

| CF space | `REBUILD_TARGET_ENV` |
|---|---|
| `dev` | `dev` (or unset — defaults to `dev`) |
| `qa` | `qa` |
| `prod` | `prod` |

Validate via the boot log line: `[rebuild-trigger] active — admin writes will dispatch with environment='<env>'`. If the line shows the wrong env, fix the CF env var and restart.

## When to rotate

- **Every 90 days** (token expiry default).
- **Immediately** if the token is suspected leaked (see "Emergency revocation" below).
- When the PAT-owning user leaves SAP or changes role.

## How to rotate

1. **Generate the new token.** GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - **Resource owner:** `sap-tutorials`
   - **Repository access:** Only select repositories → `tutorials-ims` only
   - **Repository permissions:** Actions → **Read and write** (sole permission needed)
   - **Expiration:** 90 days

2. **Test the new token** before deploying it:

   ```bash
   curl -X POST -H "Accept: application/vnd.github+json" \
     -H "Authorization: Bearer <NEW_TOKEN>" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     https://api.github.com/repos/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml/dispatches \
     -d '{"ref":"main","inputs":{"trigger-source":"manual","environment":"dev","slug":""}}'
   ```

   Expect: HTTP 204 (no body). A new run should appear in the [Actions tab](https://github.com/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml) within seconds.

3. **Update the GitHub Actions secret + redeploy each environment.** The token lives in the `DISPATCH_TOKEN` repository secret (named `DISPATCH_TOKEN` — not `GITHUB_DISPATCH_TOKEN` — because GitHub reserves the `GITHUB_` prefix for secret names) and is injected into each `tutorials-srv` deploy by an `envsubst` step in [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml) that writes `deploy/<env>.resolved.mtaext` from the `deploy/<env>.mtaext` template using the secret as the `GITHUB_DISPATCH_TOKEN` env var. `cf deploy -e <resolved>` then consumes the resolved file. The `cf deploy --var` mechanism that previously appeared here is **not** supported by the multiapps-cli-plugin (see #455). The runtime env var on `tutorials-srv` is still `GITHUB_DISPATCH_TOKEN` (that's what `srv/lib/rebuild-trigger.js` reads); only the GitHub Actions secret had to drop the prefix. `REBUILD_TARGET_ENV` is a literal in each `deploy/<env>.mtaext` and does not need rotation.

   ```bash
   # Update the repo-level secret (one-time, applies to all envs):
   gh secret set DISPATCH_TOKEN --repo sap-tutorials/tutorials-ims --body "<NEW_TOKEN>"

   # Then trigger the Build & Deploy workflow (.github/workflows/deploy.yml) for each env:
   gh workflow run deploy.yml --repo sap-tutorials/tutorials-ims -f environment=dev
   gh workflow run deploy.yml --repo sap-tutorials/tutorials-ims -f environment=qa
   gh workflow run deploy.yml --repo sap-tutorials/tutorials-ims -f environment=prod
   ```

   Validate after each deploy: `cf logs tutorials-srv --recent | grep rebuild-trigger` should show
   `[rebuild-trigger] active — admin writes will dispatch with environment='<env>'`
   with the right env, and the unset-token warning should **NOT** appear.

   **Local rotation validation** (optional — verify the new token before merging the secret bump to all envs):

   ```bash
   # From the repo root:
   export GITHUB_DISPATCH_TOKEN="<NEW_TOKEN>"
   # qa/prod also need:
   export CONTENT_API_KEY="<value>"
   export REBUILD_API_KEY="<value>"
   export APPROUTER_URL="<value>"

   envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
     < deploy/dev.mtaext > deploy/dev.resolved.mtaext

   cd .deploy && mbt build
   cf deploy mta_archives/tutorials-ims_*.mtar -e ../deploy/dev.resolved.mtaext -f
   ```

   `deploy/*.resolved.mtaext` is gitignored — leave it on disk or `rm` after the deploy.

4. **Revoke the old token.** GitHub → Settings → Developer settings → Personal access tokens → click old token → Revoke.

5. **Update the rotation calendar reminder** for +90 days.

## Emergency revocation

If the token is suspected leaked (committed to a repo, posted in a chat, posted in a screenshot, etc.):

1. **Revoke immediately** via the GitHub UI. This stops further dispatches even before CF env is updated.
2. Generate a replacement and update CF env per "How to rotate" above.
3. **Audit** the `tutorials-ims` [Actions tab](https://github.com/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml) for unexpected workflow runs in the leak window. Any unauthorized dispatch is a possible incident — file per the project's security incident process.

## Failure modes

| Mode | Symptom | Action |
|---|---|---|
| **Token unset** | `[rebuild-trigger]` boot warning; admin writes don't trigger rebuilds | Acceptable degraded mode — content stays fresh via the existing push trigger only. Confirm `gh secret list --repo sap-tutorials/tutorials-ims` shows `DISPATCH_TOKEN` (note: secret is named `DISPATCH_TOKEN`, not `GITHUB_DISPATCH_TOKEN`, because GitHub reserves the `GITHUB_` prefix); if missing, add it and trigger a redeploy. If present, check the most recent deploy run's `Resolve mtaext placeholders` step for the `GITHUB_DISPATCH_TOKEN` env-var declaration and confirm the next step's `cf deploy` consumed `deploy/<env>.resolved.mtaext`. |
| **Token expired / revoked** | GitHub returns 401; admin save logs `[rebuild-trigger] dispatch failed: GitHub dispatch 401 ...` | Rotate per the steps above. Admin saves still succeed; only the auto-rebuild dispatch is broken. |
| **`REBUILD_TARGET_ENV` mismatch** | Admin save on QA srv triggers a DEV rebuild (or vice versa); boot log shows `environment='dev'` on a non-DEV space | Set `REBUILD_TARGET_ENV` to match the space (`qa`/`prod`) and `cf restart`. Until then content stays fresh on the wrong env. |
| **Token over-permissioned** | Token has scopes beyond `actions:write` (e.g. `contents:write`, `metadata:read`, etc.) | Defense-in-depth violation, not an outage. Re-issue with `actions:write` only on next rotation cycle. |
| **GitHub rate-limited** | Sporadic 429 in logs | The 60s debounce already collapses bulk admin edits. If 429 recurs, investigate whether some other CI workflow is sharing this PAT — fine-grained PATs should not be shared across services. |

## Why fine-grained PAT (not GITHUB_APP / OIDC)

The simpler alternatives were considered and rejected for this scope:

- **GitHub App** — overkill for a single workflow_dispatch trigger; requires app installation + private-key secret rotation.
- **OIDC from CF** — Cloud Foundry doesn't expose OIDC tokens to apps in a way GitHub's `actions:write` API consumes. Would need a token-broker.
- **Repository secret + workflow** — works for CI-triggered rebuilds but doesn't help the admin-write hook (which fires from a deployed CAP, not from CI).

The fine-grained PAT is the simplest fit: scoped, expirable, revocable, and the failure mode (no rebuild dispatch) is graceful.

## Where this is documented

- This runbook (you are here).
- [`srv/lib/rebuild-trigger.js`](../../../srv/lib/rebuild-trigger.js) — module that consumes the token; module-level comment explains the feature flag.
- [`srv/server.js`](../../../srv/server.js) — admin-write hook that calls `scheduleRebuild('admin-write')` after entity writes.
- [`.github/workflows/rebuild-content.yml`](../../../.github/workflows/rebuild-content.yml) — the workflow being dispatched.
- `deploy/dev.mtaext` / `deploy/qa.mtaext` / `deploy/prod.mtaext` — the property mapping. The `${github-dispatch-token}` placeholder is resolved by [`.github/workflows/deploy.yml`](../../../.github/workflows/deploy.yml) at deploy time.

There is currently no `.env.example` file in this repo's root. If one is added in the future, include `GITHUB_DISPATCH_TOKEN=` (empty) with a pointer to this runbook.

## References

- Issue: [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) (alternative `/browse/` homepage)
- PR: [#? — admin-write rebuild trigger](https://github.com/sap-tutorials/tutorials-ims/pulls?q=is%3Apr+is%3Aopen+head%3Afeat%2Fissue-174-admin-write-rebuild-trigger)
- Spec: [docs/superpowers/specs/2026-06-02-browse-layout-design.md](../../superpowers/specs/2026-06-02-browse-layout-design.md) (decision Q11)
