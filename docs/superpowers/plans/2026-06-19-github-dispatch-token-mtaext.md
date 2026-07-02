# GITHUB_DISPATCH_TOKEN via mtaext — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GITHUB_DISPATCH_TOKEN` and `REBUILD_TARGET_ENV` survive every MTA redeploy and `cf restart` automatically on dev/qa/prod, by promoting them from manual `cf set-env` to mtaext property + GitHub Actions secret + `cf deploy --var`.

**Architecture:** Three near-identical `deploy/*.mtaext` edits add the env vars to the `tutorials-srv` `properties:` block. The token uses an `${github-dispatch-token}` placeholder resolved by `cf deploy --var`; `REBUILD_TARGET_ENV` is a per-file literal (`dev`/`qa`/`prod`). One line in the deploy workflow passes the secret. Runbook + CLAUDE.md updates document the new rotation flow and local-deploy gotcha.

**Tech Stack:** YAML (mtaext), GitHub Actions YAML, Markdown. No application code. Verification is MTA syntax validation + post-deploy log inspection.

**Spec:** [docs/superpowers/specs/2026-06-19-github-dispatch-token-mtaext-design.md](../specs/2026-06-19-github-dispatch-token-mtaext-design.md)

**Issue:** [#435](https://github.com/sap-tutorials/tutorials-ims/issues/435)

**Branch:** `fix/issue-435-github-dispatch-token-mtaext` (already created from `main`; spec doc already committed as `5132f79`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `deploy/dev.mtaext` | Modify | Add `GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}` + `REBUILD_TARGET_ENV: dev` to `tutorials-srv` properties. |
| `deploy/qa.mtaext` | Modify | Same placeholder + `REBUILD_TARGET_ENV: qa`. |
| `deploy/prod.mtaext` | Modify | Same placeholder + `REBUILD_TARGET_ENV: prod`. |
| `.github/workflows/deploy.yml` | Modify | Add `--var github-dispatch-token=...` to the `cf deploy` invocation in the `Deploy MTA` step. |
| `docs/developers/operations/github-dispatch-pat-rotation.md` | Modify | Replace `cf set-env` rotation steps with "update Actions secret + redeploy". Add curl note + boot-log validation pointer. |
| `CLAUDE.md` | Modify | Add a one-line gotcha to "Gotchas" about local manual deploys needing `--var github-dispatch-token=...` if the operator wants admin-write rebuilds to fire from that deploy. |

---

## Pre-flight (one-time, owner: Tom — must be done before merge)

- [ ] **P0: Create the GitHub Actions secret**

  Add `GITHUB_DISPATCH_TOKEN` to repo Actions secrets:
  `Settings → Secrets and variables → Actions → New repository secret`.

  Value: the same fine-grained PAT documented in [docs/developers/operations/github-dispatch-pat-rotation.md](../../developers/operations/github-dispatch-pat-rotation.md) (`actions: write` on `sap-tutorials/tutorials-ims` only). If you don't have one, generate per the runbook's "How to rotate" steps 1–2.

  Confirm:
  ```bash
  gh secret list --repo sap-tutorials/tutorials-ims | grep GITHUB_DISPATCH_TOKEN
  ```
  Expected: one line showing `GITHUB_DISPATCH_TOKEN  <updated date>`.

  > **Why this is a precondition, not a task in the plan:** GitHub Actions secrets are created out-of-band from the PR. If you skip it, the first deploy after merge will pass an empty `--var`, the property resolves to empty string, and the runtime falls back gracefully to the current "no-op + boot warning" behavior — so the failure mode is safe, but the change does nothing until the secret exists.

---

## Task 1: Update `deploy/dev.mtaext`

**Files:**
- Modify: `deploy/dev.mtaext`

- [ ] **Step 1: Edit the file**

Add two lines under the existing `tutorials-srv` properties:

```yaml
_schema-version: 3.3.0
ID: tutorials-poc-dev
extends: tutorials-poc

modules:
  - name: tutorials-srv
    properties:
      EXPOSE_CAP_UI: true
      CONTENT_API_KEY: <DEV-content-api-key>
      GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}
      REBUILD_TARGET_ENV: dev

  - name: tutorials-approuter
    parameters:
      app-name: tutorials-dev-approuter
    properties:
      XS_APP_LOG_LEVEL: debug
      DEBUG: "xs-approuter:*"
```

- [ ] **Step 2: YAML-syntax sanity check**

```bash
cd D:/projects/tutorials-poc
yq eval '.modules[] | select(.name == "tutorials-srv") | .properties' deploy/dev.mtaext
```

Expected output (key order may vary by yq version):
```yaml
EXPOSE_CAP_UI: true
CONTENT_API_KEY: <DEV-content-api-key>
GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}
REBUILD_TARGET_ENV: dev
```

If `yq` errors out, the YAML is malformed — fix indentation and re-run.

- [ ] **Step 3: Commit**

```bash
git add deploy/dev.mtaext
git commit -m "feat(mtaext): add GITHUB_DISPATCH_TOKEN + REBUILD_TARGET_ENV to dev (#435)"
```

---

## Task 2: Update `deploy/qa.mtaext`

**Files:**
- Modify: `deploy/qa.mtaext`

- [ ] **Step 1: Edit the file**

Add two lines under the existing `tutorials-srv` properties:

```yaml
_schema-version: 3.3.0
ID: tutorials-poc-qa
extends: tutorials-poc

modules:
  - name: tutorials-srv
    properties:
      EXPOSE_CAP_UI: true
      CONTENT_API_KEY: ${content-api-key}
      GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}
      REBUILD_TARGET_ENV: qa

  - name: tutorials-approuter
    parameters:
      app-name: tutorials-qa-approuter
    properties:
      REBUILD_API_KEY: ${rebuild-api-key}
      APPROUTER_URL: ${approuter-url}

resources:
  - name: tutorials-xsuaa
    parameters:
      service-name: xsuaa-imsqa
```

- [ ] **Step 2: YAML-syntax sanity check**

```bash
yq eval '.modules[] | select(.name == "tutorials-srv") | .properties' deploy/qa.mtaext
```

Expected: 4 keys including `GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}` and `REBUILD_TARGET_ENV: qa`.

- [ ] **Step 3: Commit**

```bash
git add deploy/qa.mtaext
git commit -m "feat(mtaext): add GITHUB_DISPATCH_TOKEN + REBUILD_TARGET_ENV to qa (#435)"
```

---

## Task 3: Update `deploy/prod.mtaext`

**Files:**
- Modify: `deploy/prod.mtaext`

- [ ] **Step 1: Edit the file**

```yaml
_schema-version: 3.3.0
ID: tutorials-poc-prod
extends: tutorials-poc

modules:
  - name: tutorials-srv
    parameters:
      instances: 2
    properties:
      CONTENT_API_KEY: ${content-api-key}
      GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}
      REBUILD_TARGET_ENV: prod

  - name: tutorials-approuter
    parameters:
      app-name: tutorials-prod-approuter
      instances: 2
      keep-existing-routes: true
    properties:
      REBUILD_API_KEY: ${rebuild-api-key}
      APPROUTER_URL: ${approuter-url}

resources:
  - name: tutorials-xsuaa
    parameters:
      service-name: xsuaa-imsprod
```

- [ ] **Step 2: YAML-syntax sanity check**

```bash
yq eval '.modules[] | select(.name == "tutorials-srv") | .properties' deploy/prod.mtaext
```

Expected: 3 keys including `GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}` and `REBUILD_TARGET_ENV: prod`.

- [ ] **Step 3: Commit**

```bash
git add deploy/prod.mtaext
git commit -m "feat(mtaext): add GITHUB_DISPATCH_TOKEN + REBUILD_TARGET_ENV to prod (#435)"
```

---

## Task 4: Wire the secret into the deploy workflow

**Files:**
- Modify: `.github/workflows/deploy.yml` (around the `Deploy MTA` step, currently at lines ~122–135)

- [ ] **Step 1: Edit the `cf deploy` invocation**

Find this block in `.github/workflows/deploy.yml`:

```yaml
      - name: Deploy MTA
        run: |
          STRATEGY_FLAGS=""
          if [ "${{ steps.env.outputs.target }}" = "prod" ]; then
            STRATEGY_FLAGS="--strategy blue-green --skip-testing-phase"
          fi

          cf deploy mta_archives/tutorials-poc_${{ steps.version.outputs.version }}.mtar \
            -e deploy/${{ steps.env.outputs.target }}.mtaext \
            --var content-api-key="${{ secrets.CONTENT_API_KEY }}" \
            --var rebuild-api-key="${{ secrets.REBUILD_API_KEY }}" \
            --var approuter-url="${{ steps.deploy-vars.outputs.approuter_url }}" \
            $STRATEGY_FLAGS \
            -f
```

Add one `--var` line so it becomes:

```yaml
      - name: Deploy MTA
        run: |
          STRATEGY_FLAGS=""
          if [ "${{ steps.env.outputs.target }}" = "prod" ]; then
            STRATEGY_FLAGS="--strategy blue-green --skip-testing-phase"
          fi

          cf deploy mta_archives/tutorials-poc_${{ steps.version.outputs.version }}.mtar \
            -e deploy/${{ steps.env.outputs.target }}.mtaext \
            --var content-api-key="${{ secrets.CONTENT_API_KEY }}" \
            --var rebuild-api-key="${{ secrets.REBUILD_API_KEY }}" \
            --var approuter-url="${{ steps.deploy-vars.outputs.approuter_url }}" \
            --var github-dispatch-token="${{ secrets.GITHUB_DISPATCH_TOKEN }}" \
            $STRATEGY_FLAGS \
            -f
```

- [ ] **Step 2: Validate workflow YAML**

```bash
yq eval '.jobs.deploy.steps[] | select(.name == "Deploy MTA") | .run' .github/workflows/deploy.yml
```

Expected: the multi-line `run:` script should print, with the new `--var github-dispatch-token=` line visible.

If you have `actionlint` installed (optional):
```bash
actionlint .github/workflows/deploy.yml
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): pass GITHUB_DISPATCH_TOKEN to cf deploy --var (#435)"
```

---

## Task 5: Update the rotation runbook

**Files:**
- Modify: `docs/developers/operations/github-dispatch-pat-rotation.md`

- [ ] **Step 1: Replace the "How to rotate" step 3**

Find the current step 3 (around lines 47–56):

```markdown
3. **Update CF env on each environment** (DEV, then QA, then PROD):

   ```bash
   cf target -s dev
   cf set-env tutorials-srv GITHUB_DISPATCH_TOKEN "<NEW_TOKEN>"
   cf set-env tutorials-srv REBUILD_TARGET_ENV "dev"   # or unset; defaults to 'dev'
   cf restart tutorials-srv
   ```

   Repeat for `qa` (with `REBUILD_TARGET_ENV=qa`) and `prod` (with `REBUILD_TARGET_ENV=prod`) spaces. Validate via the deployed log line on boot — the line `[rebuild-trigger] active — admin writes will dispatch with environment='<env>'` should appear with the right env, and the unset-token warning should **NOT** appear.
```

Replace with:

```markdown
3. **Update the GitHub Actions secret + redeploy each environment.** The token now lives in the `GITHUB_DISPATCH_TOKEN` repository secret and is injected into each `tutorials-srv` deploy via `cf deploy --var github-dispatch-token=...`. `REBUILD_TARGET_ENV` is a literal in each `deploy/<env>.mtaext` and does not need rotation.

   ```bash
   # Update the repo-level secret (one-time, applies to all envs):
   gh secret set GITHUB_DISPATCH_TOKEN --repo sap-tutorials/tutorials-ims --body "<NEW_TOKEN>"

   # Then trigger the Build & Deploy workflow (.github/workflows/deploy.yml) for each env:
   gh workflow run deploy.yml --repo sap-tutorials/tutorials-ims -f environment=dev
   gh workflow run deploy.yml --repo sap-tutorials/tutorials-ims -f environment=qa
   gh workflow run deploy.yml --repo sap-tutorials/tutorials-ims -f environment=prod
   ```

   Validate after each deploy: `cf logs tutorials-srv --recent | grep rebuild-trigger` should show
   `[rebuild-trigger] active — admin writes will dispatch with environment='<env>'`
   with the right env, and the unset-token warning should **NOT** appear.

   **Local manual deploy fallback** (`cd .deploy && cf deploy ... -e ../deploy/dev.mtaext`): pass `--var github-dispatch-token=<NEW_TOKEN>` on the command line, or accept that the deployed env var will be empty for that one deploy until the next CI deploy restores it. Same convention as `content-api-key` for prod/qa today.
```

- [ ] **Step 2: Update the "Failure modes" table — token-unset row**

Find the current row:

```markdown
| **Token unset** | `[rebuild-trigger]` boot warning; admin writes don't trigger rebuilds | Acceptable degraded mode — content stays fresh via the existing push trigger only. Set the env var when ready. |
```

Replace with:

```markdown
| **Token unset** | `[rebuild-trigger]` boot warning; admin writes don't trigger rebuilds | Acceptable degraded mode — content stays fresh via the existing push trigger only. Confirm `gh secret list --repo sap-tutorials/tutorials-ims` shows `GITHUB_DISPATCH_TOKEN`; if missing, add it and trigger a redeploy. If present, check the most recent deploy run's `Deploy MTA` step for the `--var github-dispatch-token=` line. |
```

- [ ] **Step 3: Update "Where this is documented"**

Add one bullet to the existing list (after the `.github/workflows/rebuild-content.yml` bullet):

```markdown
- [`deploy/dev.mtaext`](../../../deploy/dev.mtaext) / [`deploy/qa.mtaext`](../../../deploy/qa.mtaext) / [`deploy/prod.mtaext`](../../../deploy/prod.mtaext) — the property mapping. The `${github-dispatch-token}` placeholder is resolved by [`.github/workflows/deploy.yml`](../../../.github/workflows/deploy.yml) at deploy time.
```

- [ ] **Step 4: Markdown lint check**

```bash
cd D:/projects/tutorials-poc
npx markdownlint-cli2 docs/developers/operations/github-dispatch-pat-rotation.md 2>&1 | tail -20
```

Expected: clean exit (or only the same warnings that existed before). Fix any new findings caused by the edit.

- [ ] **Step 5: Commit**

```bash
git add docs/developers/operations/github-dispatch-pat-rotation.md
git commit -m "docs(runbook): rotate GITHUB_DISPATCH_TOKEN via Actions secret + redeploy (#435)"
```

---

## Task 6: Add CLAUDE.md gotcha for local manual deploys

**Files:**
- Modify: `CLAUDE.md` — under the existing `## Gotchas` section.

- [ ] **Step 1: Find the right insertion point**

The `Gotchas` section is alphabetically-loose; insert the new bullet near related deploy-time gotchas (after the `**Hugo must finish before mbt build**` bullet, since both are about local-deploy ergonomics).

- [ ] **Step 2: Add the bullet**

```markdown
- **Local manual deploy needs `--var github-dispatch-token=...`** — `cf deploy ... -e ../deploy/dev.mtaext` from `.deploy/` won't resolve the `${github-dispatch-token}` placeholder unless you pass `--var github-dispatch-token=<PAT>` (or `export CF_VAR_github_dispatch_token=...`). Without it, the deployed `tutorials-srv` boots with an empty `GITHUB_DISPATCH_TOKEN` and admin-write rebuild dispatch silently no-ops until the next CI deploy. Same convention as `content-api-key` / `rebuild-api-key` on prod/qa.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): note --var github-dispatch-token for local deploys (#435)"
```

---

## Task 7: End-to-end MTA-syntax verification

**Goal:** prove that `mbt build` accepts the new mtaext placeholders and that `cf deploy` would resolve them. No actual deploy.

- [ ] **Step 1: Run `mbt build` against each mtaext**

```bash
cd D:/projects/tutorials-poc/.deploy
mbt build -e ../deploy/dev.mtaext --mtar tutorials-poc-dev-syntax-check.mtar 2>&1 | tail -20 || echo "mbt build failed — fix mtaext syntax"
```

> If you don't have `mbt` locally (memory: `feedback_mbt_silent_no_unpacked_bin` — note that `mbt` exits 0 silently when `unpacked_bin/mbt.exe` is missing, so verify with `mbt --version` first), **skip this step and rely on Task 1–3 yq checks**. The first CI deploy run will catch any syntax issue, and the failure mode is "deploy errors out before changing CF state" — safe.

If `mbt` is present, expected: `MTA archive created` line, no `parsing error` / `unresolved variable` warnings. Clean up the resulting mtar.

- [ ] **Step 2: Dry-run cf deploy placeholder substitution (optional, requires cf login)**

```bash
cf deploy mta_archives/<mtar> -e deploy/dev.mtaext \
  --var content-api-key=DUMMY \
  --var rebuild-api-key=DUMMY \
  --var approuter-url=https://dummy.example.com \
  --var github-dispatch-token=DUMMY \
  --do-not-fail-on-missing-permissions \
  --skip-testing-phase \
  -f --no-confirm 2>&1 | head -40
```

> This is a real deploy attempt. **Skip unless** you're already logged into a throwaway space; otherwise rely on CI to catch placeholder issues.

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin fix/issue-435-github-dispatch-token-mtaext
gh pr create \
  --repo sap-tutorials/tutorials-ims \
  --base main \
  --title "fix(deploy): persist GITHUB_DISPATCH_TOKEN via mtaext (#435)" \
  --body "$(cat <<'EOF'
## What

Promote `GITHUB_DISPATCH_TOKEN` and `REBUILD_TARGET_ENV` from manual `cf set-env` to mtaext property + GitHub Actions secret + `cf deploy --var`. Mirrors the existing `${content-api-key}` / `${rebuild-api-key}` pattern.

After this, the env vars survive every MTA redeploy and `cf restart` automatically.

## Precondition (owner: Tom)

Before merging, confirm the `GITHUB_DISPATCH_TOKEN` repo secret exists:

```bash
gh secret list --repo sap-tutorials/tutorials-ims | grep GITHUB_DISPATCH_TOKEN
```

If missing, add it (the existing PAT documented in the rotation runbook).

## Verification after deploy

1. `cf logs tutorials-srv --recent | grep rebuild-trigger` shows
   `[rebuild-trigger] active — admin writes will dispatch with environment='<dev|qa|prod>'.`
2. `cf env tutorials-srv | grep -E "GITHUB_DISPATCH_TOKEN|REBUILD_TARGET_ENV"` shows both set.
3. Save any mission/group via admin UI; wait 60s; new `rebuild-content.yml` run with `trigger-source: admin-write`.
4. `cf restart tutorials-srv` → both env vars persist.

## Failure mode if secret missing at deploy

`cf deploy` passes empty `--var`; property resolves to empty string; runtime falls back to existing "no-op + boot warning" behavior. **Safe** — no outage.

## Refs

- Spec: [docs/superpowers/specs/2026-06-19-github-dispatch-token-mtaext-design.md](docs/superpowers/specs/2026-06-19-github-dispatch-token-mtaext-design.md)
- Plan: [docs/superpowers/plans/2026-06-19-github-dispatch-token-mtaext.md](docs/superpowers/plans/2026-06-19-github-dispatch-token-mtaext.md)

Closes #435.
EOF
)"
```

Expected: PR URL printed.

---

## Post-merge verification (owner: Tom — not part of the PR)

After CI deploys to DEV (and later QA, PROD):

- [ ] **Verify boot log on DEV**

  ```bash
  cf target -s dev
  cf logs tutorials-srv --recent | grep rebuild-trigger
  ```
  Expect: `[rebuild-trigger] active — admin writes will dispatch with environment='dev'.`
  Expect NOT: `[rebuild-trigger] GITHUB_DISPATCH_TOKEN unset — ...`

- [ ] **Verify env vars on DEV**

  ```bash
  cf env tutorials-srv | grep -E "GITHUB_DISPATCH_TOKEN|REBUILD_TARGET_ENV"
  ```
  Expect: two lines, `GITHUB_DISPATCH_TOKEN` redacted to `***` or shown verbatim (CF behavior varies); `REBUILD_TARGET_ENV: dev`.

- [ ] **End-to-end admin-write trigger**

  Save any mission/group via the admin UI on DEV. Wait 60s. Then:
  ```bash
  gh run list --repo sap-tutorials/tutorials-ims --workflow=rebuild-content.yml --limit 1
  ```
  Expect: a new `in_progress` (or `queued`) run from the last 60–120s with `trigger-source: admin-write`.

- [ ] **Verify persistence across `cf restart`**

  ```bash
  cf restart tutorials-srv
  cf logs tutorials-srv --recent | grep rebuild-trigger
  ```
  Expect: same `active — ...` line. Both env vars survive without redeploy.

- [ ] **Repeat the four checks above for QA and PROD** after CI deploys to those spaces.

---

## Out of scope (per spec)

- Migrating `CONTENT_API_KEY` / `REBUILD_API_KEY` to a different secret-management pattern.
- Adding pre-flight token validation in `srv/lib/rebuild-trigger.js` beyond the existing boot warning.
- Changing the 90-day rotation cadence.
- Wiring the env var into `cds bind --exec` flows for local hybrid dev (rebuild-trigger no-ops locally already, and that's fine).

## Notes for the implementer

- **No application code changes.** `srv/lib/rebuild-trigger.js` already reads `process.env.GITHUB_DISPATCH_TOKEN` — the only change is making sure that env var is set at runtime.
- **No new unit tests.** The existing `srv/lib/__tests__/rebuild-trigger.test.js` covers token-set / token-unset paths; nothing in this change alters runtime behavior. Adding tests would be testing CF/MTA infrastructure, which is the wrong layer.
- **Frequent commits per task.** Each task is independently meaningful and revertable.
- **Don't squash the spec commit.** The spec doc commit (`5132f79`) should stay as its own commit on the branch so the PR diff shows spec → 6 implementation commits.
