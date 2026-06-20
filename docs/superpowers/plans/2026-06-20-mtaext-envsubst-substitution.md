# MTA extension descriptor placeholder substitution — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `cf deploy --var ...` mechanism in [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml) with `envsubst`-based pre-substitution. Rename mtaext placeholders to UPPERCASE so they're POSIX-compatible env-var names.

**Architecture:** New CI step renders the mtaext template through `envsubst` into `*.resolved.mtaext` before `cf deploy -e <resolved>`. New `validate-mtaext-substitution` workflow job (deploy job's prerequisite) verifies the substitution machinery via dummy values. Local deploys use the same envsubst command via Git Bash.

**Tech Stack:** GitHub Actions YAML, Bash, GNU `envsubst` (gettext-base), MTA extension descriptors.

**Spec:** [docs/superpowers/specs/2026-06-20-mtaext-envsubst-substitution-design.md](../specs/2026-06-20-mtaext-envsubst-substitution-design.md)

**Issue:** [#455](https://github.com/sap-tutorials/tutorials-ims/issues/455)

**Branch:** `fix/issue-455-mtaext-substitution` (already created from `main`; spec committed as `2019dd6e` + `0675a17e`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `deploy/dev.mtaext` | Modify | Rename `${github-dispatch-token}` → `${GITHUB_DISPATCH_TOKEN}`. |
| `deploy/qa.mtaext` | Modify | Rename all four placeholders to UPPERCASE. |
| `deploy/prod.mtaext` | Modify | Same as qa. |
| `.gitignore` | Modify | Add `deploy/*.resolved.mtaext` to prevent accidental commits of substituted-secrets file. |
| `.github/workflows/deploy.yml` | Modify | Replace broken `--var` block with envsubst step + simplified `cf deploy`. Add `validate-mtaext-substitution` job at the top with the deploy job depending on it via `needs:`. |
| `CLAUDE.md` | Modify | Replace the existing `GITHUB_DISPATCH_TOKEN` gotcha (mentioning `--var`) with the new envsubst recipe. |
| `docs/developers/operations/github-dispatch-pat-rotation.md` | Modify | Replace `cf deploy --var` references with envsubst flow; delete the now-obsolete local-edit-and-revert workaround. |

No new files. No application-code changes (`srv/`, `hugo-apps/`, etc. are untouched).

---

## Pre-flight: commit the plan

- [ ] **Step 0 (commit this plan first):** Before starting Task 1, commit the plan file itself so the branch sequence reads spec → plan → impl.

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current  # expect: fix/issue-455-mtaext-substitution
  git -c core.autocrlf=false add docs/superpowers/plans/2026-06-20-mtaext-envsubst-substitution.md
  git -c core.autocrlf=false commit -m "docs(plan): mtaext envsubst substitution (#455)"
  ```

  > **Branch-slip safeguard (memory: `feedback_branch_slip_after_long_session`):** Pair `git branch --show-current` with the commit invocation in the SAME Bash call. Long sessions silently slip HEAD back to main; the workflow above caught it twice in this session.

---

## Task 1: Rename placeholders in `deploy/dev.mtaext`

**Files:**
- Modify: `deploy/dev.mtaext`

- [ ] **Step 1: Read the current state**

  ```bash
  cd D:/projects/tutorials-poc
  cat deploy/dev.mtaext
  ```

  You'll see one placeholder: `GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}`.

- [ ] **Step 2: Rename the placeholder**

  Replace `${github-dispatch-token}` with `${GITHUB_DISPATCH_TOKEN}` so the placeholder name matches the runtime env-var name (and the env var the CI step will export).

  Before:
  ```yaml
        GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}
  ```

  After:
  ```yaml
        GITHUB_DISPATCH_TOKEN: ${GITHUB_DISPATCH_TOKEN}
  ```

- [ ] **Step 3: YAML sanity check**

  ```bash
  cd D:/projects/tutorials-poc
  yq eval '.modules[] | select(.name == "tutorials-srv") | .properties.GITHUB_DISPATCH_TOKEN' deploy/dev.mtaext
  ```

  Expected: `${GITHUB_DISPATCH_TOKEN}` (or `${GITHUB_DISPATCH_TOKEN}` literally; yq doesn't substitute).

  > **Why no YAML breakage check beyond yq?** The substitution at the syntactic level is just a string change; the YAML structure is untouched. `yq eval` confirms the YAML still parses.

- [ ] **Step 4: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current  # confirm fix/issue-455-mtaext-substitution
  git -c core.autocrlf=false add deploy/dev.mtaext
  git -c core.autocrlf=false commit -m "fix(mtaext): rename github-dispatch-token placeholder to UPPERCASE for envsubst (#455)"
  ```

---

## Task 2: Rename placeholders in `deploy/qa.mtaext`

**Files:**
- Modify: `deploy/qa.mtaext`

- [ ] **Step 1: Apply four renames**

  Edit each of the four placeholders:

  | Before | After |
  |---|---|
  | `CONTENT_API_KEY: ${content-api-key}` | `CONTENT_API_KEY: ${CONTENT_API_KEY}` |
  | `GITHUB_DISPATCH_TOKEN: ${github-dispatch-token}` | `GITHUB_DISPATCH_TOKEN: ${GITHUB_DISPATCH_TOKEN}` |
  | `REBUILD_API_KEY: ${rebuild-api-key}` | `REBUILD_API_KEY: ${REBUILD_API_KEY}` |
  | `APPROUTER_URL: ${approuter-url}` | `APPROUTER_URL: ${APPROUTER_URL}` |

  All four lines exist in `deploy/qa.mtaext` (verified at lines 9, 10, 17, 18).

- [ ] **Step 2: YAML sanity check**

  ```bash
  cd D:/projects/tutorials-poc
  grep -nE '\$\{[a-z-]+\}' deploy/qa.mtaext
  ```

  Expected: empty output (no lowercase-or-hyphenated placeholders left).

  ```bash
  grep -nE '\$\{[A-Z_]+\}' deploy/qa.mtaext
  ```

  Expected: 4 lines showing the four UPPERCASE placeholders.

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add deploy/qa.mtaext
  git -c core.autocrlf=false commit -m "fix(mtaext): rename qa placeholders to UPPERCASE for envsubst (#455)"
  ```

---

## Task 3: Rename placeholders in `deploy/prod.mtaext`

**Files:**
- Modify: `deploy/prod.mtaext`

- [ ] **Step 1: Apply the same four renames as Task 2**

  The placeholders in `deploy/prod.mtaext` are identical to qa's (lines 10, 11, 20, 21). Apply the same rename table.

- [ ] **Step 2: YAML sanity check**

  ```bash
  cd D:/projects/tutorials-poc
  grep -nE '\$\{[a-z-]+\}' deploy/prod.mtaext
  ```

  Expected: empty output.

  ```bash
  grep -nE '\$\{[A-Z_]+\}' deploy/prod.mtaext
  ```

  Expected: 4 lines.

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add deploy/prod.mtaext
  git -c core.autocrlf=false commit -m "fix(mtaext): rename prod placeholders to UPPERCASE for envsubst (#455)"
  ```

---

## Task 4: Add `.gitignore` entry for resolved mtaext files

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Find the right insertion point**

  ```bash
  cd D:/projects/tutorials-poc
  grep -nE "^# CAP|^gen/|^db.sqlite|^\*.db|^\.cdsrc-private|^default-env" .gitignore | head -10
  ```

  Find an existing block of build/deploy artifacts. The `default-env.json` line is a good neighbor since both are local-only secret-bearing files.

- [ ] **Step 2: Add the entry**

  Append (or insert near `default-env.json`):

  ```gitignore
  # MTA extension descriptors with resolved secrets (#455). Generated by
  # envsubst at deploy time; never commit — they contain real CI secrets.
  deploy/*.resolved.mtaext
  ```

- [ ] **Step 3: Verify the rule works**

  ```bash
  cd D:/projects/tutorials-poc
  echo "test" > deploy/dev.resolved.mtaext
  git status --porcelain | grep "resolved.mtaext"
  ```

  Expected: empty output (the file is ignored). Then clean up:

  ```bash
  rm deploy/dev.resolved.mtaext
  ```

- [ ] **Step 4: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add .gitignore
  git -c core.autocrlf=false commit -m "chore(gitignore): exclude deploy/*.resolved.mtaext (envsubst output) (#455)"
  ```

---

## Task 5: Replace the `--var` block in `.github/workflows/deploy.yml` + add the validate job

**Files:**
- Modify: `.github/workflows/deploy.yml`

This is the main fix. Two pieces: (1) add the `validate-mtaext-substitution` job at the top, (2) replace the broken `--var` Deploy MTA step with envsubst + simplified deploy.

- [ ] **Step 1: Read the current `Deploy MTA` step**

  ```bash
  cd D:/projects/tutorials-poc
  sed -n '120,140p' .github/workflows/deploy.yml
  ```

  You'll see the `Deploy MTA` step with the broken `--var` flags.

- [ ] **Step 2: Locate the start of the `jobs:` block**

  ```bash
  cd D:/projects/tutorials-poc
  grep -nE "^jobs:|^  [a-z][a-z-]+:|^  deploy:" .github/workflows/deploy.yml | head -5
  ```

  You should see `jobs:` at one line, then `  deploy:` shortly after. The new `validate-mtaext-substitution` job will go BEFORE the `deploy:` job, and `deploy` gets a `needs:` clause.

- [ ] **Step 3: Add the `validate-mtaext-substitution` job + wire `needs:`**

  Find the line `jobs:` and the next line `  deploy:`. INSERT a new job between them:

  Before (showing the actual existing shape — DON'T touch the deploy job's other keys):
  ```yaml
  jobs:
    deploy:
      runs-on: ubuntu-latest
      timeout-minutes: 30
      permissions:
        contents: write
        pull-requests: write   # gh pr comment from 'Comment HDI tripwire on PR' step (#257 follow-up)
      outputs:
        environment: ${{ steps.env.outputs.target }}

      steps:
        - name: Checkout
          uses: actions/checkout@v4
  ```

  After:
  ```yaml
  jobs:
    validate-mtaext-substitution:
      # [#455] Verify envsubst resolves every placeholder in every mtaext.
      # Catches regressions where someone reverts the rename or removes the
      # envsubst step in `deploy:`. Runs on every deploy invocation.
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: Verify envsubst resolves all known placeholders
          env:
            CONTENT_API_KEY: dummy-content
            REBUILD_API_KEY: dummy-rebuild
            APPROUTER_URL: https://dummy.example.com
            GITHUB_DISPATCH_TOKEN: dummy-token
          run: |
            set -euo pipefail
            for env in dev qa prod; do
              OUT=$(mktemp)
              envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
                < deploy/${env}.mtaext > "$OUT"
              # The character class also catches hyphenated leftovers (e.g.
              # ${content-api-key}) so a half-finished rename surfaces here too.
              if grep -nE '\$\{[A-Za-z_-]+\}' "$OUT"; then
                echo "::error::Unresolved placeholder(s) in deploy/${env}.mtaext after envsubst"
                cat "$OUT"
                exit 1
              fi
            done
            echo "All three mtaext files resolve cleanly."

    deploy:
      runs-on: ubuntu-latest
      needs: validate-mtaext-substitution
      timeout-minutes: 30
      permissions:
        contents: write
        pull-requests: write   # gh pr comment from 'Comment HDI tripwire on PR' step (#257 follow-up)
      outputs:
        environment: ${{ steps.env.outputs.target }}

      steps:
        - name: Checkout
          uses: actions/checkout@v4
  ```

  > **Note:** the `needs:` line goes between `runs-on:` and `timeout-minutes:` to keep the most-related keys together. Don't reorder or remove `timeout-minutes`, `permissions`, `outputs` — they're functional and unrelated to this change.

- [ ] **Step 4: Replace the broken `--var` deploy block**

  Find the existing `Deploy MTA` step inside the `deploy:` job (around lines 122–135). The current shape:

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
              --var github-dispatch-token="${{ secrets.DISPATCH_TOKEN }}" \
              $STRATEGY_FLAGS \
              -f
  ```

  Replace with TWO steps:

  ```yaml
        - name: Resolve mtaext placeholders
          # [#455] envsubst replaces ${VAR} placeholders with real values from
          # CI secrets BEFORE cf deploy sees the file. The --var flag is NOT
          # supported by the multiapps-cli-plugin (verified by reading the
          # plugin's source); the previous --var-based block was non-functional
          # but had never run successfully (CI was failing at mbt build for
          # unrelated reasons since 2026-05-05).
          env:
            CONTENT_API_KEY: ${{ secrets.CONTENT_API_KEY }}
            REBUILD_API_KEY: ${{ secrets.REBUILD_API_KEY }}
            APPROUTER_URL: ${{ steps.deploy-vars.outputs.approuter_url }}
            GITHUB_DISPATCH_TOKEN: ${{ secrets.DISPATCH_TOKEN }}
          run: |
            set -euo pipefail
            IN=deploy/${{ steps.env.outputs.target }}.mtaext
            OUT=deploy/${{ steps.env.outputs.target }}.resolved.mtaext
            # Restrict substitution to known names — defends against incidental
            # ${OTHER} sequences elsewhere in the file (description text, etc.).
            envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
              < "$IN" > "$OUT"
            # Fail loudly if any placeholder survived. The character class
            # accepts hyphenated names too (e.g. ${content-api-key}) so a
            # half-finished rename surfaces the same way as a typo.
            if grep -nE '\$\{[A-Za-z_-]+\}' "$OUT"; then
              echo "::error::Unresolved placeholder(s) in $OUT — check that the env-var is exported and matches the placeholder name."
              exit 1
            fi

        - name: Deploy MTA
          run: |
            STRATEGY_FLAGS=""
            if [ "${{ steps.env.outputs.target }}" = "prod" ]; then
              STRATEGY_FLAGS="--strategy blue-green --skip-testing-phase"
            fi
            cf deploy mta_archives/tutorials-poc_${{ steps.version.outputs.version }}.mtar \
              -e deploy/${{ steps.env.outputs.target }}.resolved.mtaext \
              $STRATEGY_FLAGS \
              -f
  ```

  Note: `secrets.DISPATCH_TOKEN` (no `GITHUB_` prefix — GitHub reserves that). The CI step exports it AS `GITHUB_DISPATCH_TOKEN` so it matches the placeholder + the runtime env var name.

- [ ] **Step 5: YAML lint check**

  ```bash
  cd D:/projects/tutorials-poc
  yq eval '.jobs | keys' .github/workflows/deploy.yml
  ```

  Expected:
  ```yaml
  - validate-mtaext-substitution
  - deploy
  ```

  ```bash
  yq eval '.jobs.deploy.needs' .github/workflows/deploy.yml
  ```

  Expected: `validate-mtaext-substitution`.

  ```bash
  yq eval '.jobs.deploy.steps[] | select(.name == "Resolve mtaext placeholders") | .name' .github/workflows/deploy.yml
  ```

  Expected: `Resolve mtaext placeholders`.

  ```bash
  yq eval '.jobs.deploy.steps[] | select(.name == "Deploy MTA") | .run' .github/workflows/deploy.yml | head -10
  ```

  Expected: the deploy script no longer contains `--var`. The `cf deploy` line should reference `*.resolved.mtaext`.

- [ ] **Step 6: Local envsubst smoke (paranoid, optional)**

  Before committing, you can run the same envsubst command locally on dev.mtaext to confirm the rename works:

  ```bash
  cd D:/projects/tutorials-poc
  GITHUB_DISPATCH_TOKEN="local-dummy-token" \
    envsubst '$GITHUB_DISPATCH_TOKEN' \
    < deploy/dev.mtaext \
    | grep GITHUB_DISPATCH_TOKEN
  ```

  Expected: `      GITHUB_DISPATCH_TOKEN: local-dummy-token` (the placeholder substituted; no `${...}` left).

  > Note: dev.mtaext only has `GITHUB_DISPATCH_TOKEN`, so only that one env var is needed for the local smoke. For qa/prod you'd export all four.

- [ ] **Step 7: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add .github/workflows/deploy.yml
  git -c core.autocrlf=false commit -m "ci(deploy): replace broken --var with envsubst + add validate job (#455)

  cf deploy --var is not a real flag in the multiapps-cli-plugin (verified
  by reading the plugin's source). Substitution must happen BEFORE cf
  deploy sees the mtaext.

  New 'Resolve mtaext placeholders' step runs envsubst over the template
  with the four CI secrets and writes deploy/<env>.resolved.mtaext. The
  next step's cf deploy points at the resolved file. A grep guard fails
  the workflow loudly if any placeholder survives.

  New validate-mtaext-substitution job (deploy job's prerequisite) runs
  envsubst with dummy values across all three mtaext files, catching
  regressions before they reach a real deploy."
  ```

---

## Task 6: Update CLAUDE.md gotcha

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the existing GITHUB_DISPATCH_TOKEN line**

  ```bash
  cd D:/projects/tutorials-poc
  grep -n "GITHUB_DISPATCH_TOKEN env var" CLAUDE.md
  ```

  Expected: line 278 (or thereabouts).

- [ ] **Step 2: Replace the entire line**

  Find the line that starts with `- **\`GITHUB_DISPATCH_TOKEN\` env var**` and ends with `Rotation runbook: ...`.

  Before:
  ```markdown
  - **`GITHUB_DISPATCH_TOKEN` env var** — Read by `srv/lib/rebuild-trigger.js`; admin saves debounce-dispatch `rebuild-content.yml` after 60s when set. Sourced from the `DISPATCH_TOKEN` GitHub Actions secret (named `DISPATCH_TOKEN`, **not** `GITHUB_DISPATCH_TOKEN` — GitHub reserves the `GITHUB_` prefix for secret names) via `cf deploy --var github-dispatch-token=...` (placeholder in all three `deploy/*.mtaext`). Local manual deploy (`cd .deploy && cf deploy ... -e ../deploy/dev.mtaext`) needs `--var github-dispatch-token=<PAT>` (or `export CF_VAR_github_dispatch_token=...`); without it, the deployed `tutorials-srv` boots with empty `GITHUB_DISPATCH_TOKEN` and admin-write rebuild dispatch silently no-ops until the next CI deploy. Same convention as `content-api-key` / `rebuild-api-key` on prod/qa. Rotation runbook: [docs/developers/operations/github-dispatch-pat-rotation.md](docs/developers/operations/github-dispatch-pat-rotation.md).
  ```

  After:
  ```markdown
  - **`GITHUB_DISPATCH_TOKEN` env var** — Read by `srv/lib/rebuild-trigger.js`; admin saves debounce-dispatch `rebuild-content.yml` after 60s when set. Sourced from the `DISPATCH_TOKEN` GitHub Actions secret (named `DISPATCH_TOKEN`, **not** `GITHUB_DISPATCH_TOKEN` — GitHub reserves the `GITHUB_` prefix for secret names). All four mtaext placeholders (`${CONTENT_API_KEY}`, `${REBUILD_API_KEY}`, `${APPROUTER_URL}`, `${GITHUB_DISPATCH_TOKEN}`) are resolved at deploy time by `envsubst` writing `deploy/<env>.resolved.mtaext`, which `cf deploy -e` then consumes. The `cf deploy --var` flag is **not** supported by the multiapps-cli-plugin — see #455. **Local manual deploy** (Git Bash on Windows or any *nix): `export GITHUB_DISPATCH_TOKEN=<PAT>` (plus the other three for qa/prod), `envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' < deploy/dev.mtaext > deploy/dev.resolved.mtaext`, then `cd .deploy && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f`. The grep guard in CI's "Resolve mtaext placeholders" step fails the workflow loudly if any placeholder survives (typo or missing env var). Rotation runbook: [docs/developers/operations/github-dispatch-pat-rotation.md](docs/developers/operations/github-dispatch-pat-rotation.md).
  ```

- [ ] **Step 3: Markdown lint check (optional, only fails on size)**

  ```bash
  cd D:/projects/tutorials-poc
  npx markdownlint-cli2 CLAUDE.md 2>&1 | tail -5
  ```

  > **Acceptable warnings:** the file is full of long lines and the existing house style; only fail on NEW errors not present before. The pattern `MD013/line-length` is project-tolerated.

- [ ] **Step 4: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add CLAUDE.md
  git -c core.autocrlf=false commit -m "docs(claude): update GITHUB_DISPATCH_TOKEN gotcha for envsubst flow (#455)"
  ```

---

## Task 7: Update the PAT-rotation runbook

**Files:**
- Modify: `docs/developers/operations/github-dispatch-pat-rotation.md`

- [ ] **Step 1: Locate the `--var`-based step**

  ```bash
  cd D:/projects/tutorials-poc
  grep -n "cf deploy --var\|--var github-dispatch-token" docs/developers/operations/github-dispatch-pat-rotation.md
  ```

  Expected: 1–2 hits in the "How to rotate" section (around line 47).

- [ ] **Step 2: Replace the rotation step**

  Find the paragraph starting with "Update the GitHub Actions secret + redeploy each environment" (around line 47). It currently says the token is injected via `cf deploy --var github-dispatch-token=...`. Replace with the envsubst description:

  Before (the relevant sentence — keep the rest of step 3):
  ```
  ...is injected into each `tutorials-srv` deploy via `cf deploy --var github-dispatch-token=...`.
  ```

  After:
  ```
  ...is injected into each `tutorials-srv` deploy by an `envsubst` step in [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml) that writes `deploy/<env>.resolved.mtaext` from the `deploy/<env>.mtaext` template using the secret as the `GITHUB_DISPATCH_TOKEN` env var. `cf deploy -e <resolved>` then consumes the resolved file. The `cf deploy --var` mechanism that previously appeared here is **not** supported by the multiapps-cli-plugin (see #455).
  ```

- [ ] **Step 3: Search for + delete the obsolete "local-edit-and-revert" workaround**

  ```bash
  grep -n "local-edit-and-revert\|edit dev.mtaext to a literal\|revert dev.mtaext\|For today's local DEV deploy I" docs/developers/operations/github-dispatch-pat-rotation.md
  ```

  > **Note:** the spec at 2026-06-19 has this workaround in its Verification section, but the rotation runbook may or may not have copied it. If grep returns no hits, this step is a no-op — proceed to step 4.

  If hits exist: delete those lines/paragraphs. The spec's directive: "**Delete (don't just annotate)** the local-edit-and-revert workaround Tom used on 2026-06-19" — keeping it around invites someone to follow the wrong path.

- [ ] **Step 4: Add a "Local rotation deploy" example near the bottom of the runbook**

  In the "Rotate" section, add a subsection (or extend the existing one) showing the local-deploy recipe so a SuperAdmin can validate a rotation locally before pushing to CI:

  ```markdown
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
  cf deploy mta_archives/tutorials-poc_*.mtar -e ../deploy/dev.resolved.mtaext -f
  ```

  > **Cleanup:** `deploy/*.resolved.mtaext` is gitignored; you can leave it on disk or `rm` it after the deploy.
  ```

- [ ] **Step 5: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add docs/developers/operations/github-dispatch-pat-rotation.md
  git -c core.autocrlf=false commit -m "docs(runbook): rotate-PAT runbook uses envsubst, drops obsolete --var path (#455)"
  ```

---

## Task 8: End-to-end smoke + push + open PR

- [ ] **Step 1: Verify final branch state**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current   # fix/issue-455-mtaext-substitution
  git log --oneline main..HEAD
  ```

  Expected: 9 commits — 2 spec, 1 plan, 3 mtaext, 1 .gitignore, 1 deploy.yml, 1 CLAUDE.md, 1 runbook.

- [ ] **Step 2: Cross-file consistency check**

  Verify all four placeholder names match across mtaext, deploy.yml, and the runbook:

  ```bash
  cd D:/projects/tutorials-poc

  # mtaext placeholders (should be 4 distinct UPPERCASE names):
  echo "=== mtaext placeholders ==="
  grep -hoE '\$\{[A-Z_]+\}' deploy/*.mtaext | sort -u

  # CI workflow's envsubst whitelist (should be the same 4 names):
  echo "=== deploy.yml envsubst whitelist ==="
  grep -oE '\$[A-Z_]+ \$[A-Z_]+ \$[A-Z_]+ \$[A-Z_]+' .github/workflows/deploy.yml | head -2

  # CI workflow's env: block (should export the same 4 names):
  echo "=== deploy.yml env block names ==="
  grep -A1 "Resolve mtaext placeholders\|Verify envsubst" .github/workflows/deploy.yml | grep -oE '^\s*[A-Z_]+:' | sort -u
  ```

  Expected: all three groupings agree on the 4 names: `CONTENT_API_KEY`, `REBUILD_API_KEY`, `APPROUTER_URL`, `GITHUB_DISPATCH_TOKEN`.

- [ ] **Step 3: Local envsubst dry-run on dev.mtaext**

  ```bash
  cd D:/projects/tutorials-poc
  GITHUB_DISPATCH_TOKEN="dummy-pat-for-smoke-test" \
    envsubst '$GITHUB_DISPATCH_TOKEN' \
    < deploy/dev.mtaext \
    | grep -E "GITHUB_DISPATCH_TOKEN|^\\\$\\{"
  ```

  Expected: line `      GITHUB_DISPATCH_TOKEN: dummy-pat-for-smoke-test` and NO `${...}` lines remaining.

  Optional: run on qa.mtaext with all four env vars set:

  ```bash
  CONTENT_API_KEY=cak REBUILD_API_KEY=rak APPROUTER_URL=http://x GITHUB_DISPATCH_TOKEN=gdt \
    envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
    < deploy/qa.mtaext \
    | grep -E '\$\{|cak|rak|http://x|gdt' | head
  ```

  Expected: the four substituted values present; no `${...}` placeholders left.

- [ ] **Step 4: Push**

  ```bash
  cd D:/projects/tutorials-poc
  git push -u origin fix/issue-455-mtaext-substitution
  ```

- [ ] **Step 5: Open PR**

  ```bash
  cd D:/projects/tutorials-poc
  gh pr create \
    --repo sap-tutorials/tutorials-ims \
    --base main \
    --title "fix(ci): mtaext placeholder substitution via envsubst, not non-existent cf deploy --var (#455)" \
    --body "$(cat <<'EOF'
  ## What

  Replace the non-existent `cf deploy --var ...` mechanism in [.github/workflows/deploy.yml](.github/workflows/deploy.yml) with an `envsubst`-based pre-substitution step. Rename the four mtaext placeholders to UPPERCASE so they're POSIX-compatible env-var names. Add a `validate-mtaext-substitution` workflow job (deploy job's prerequisite) that catches substitution regressions before they reach a real deploy. Update [CLAUDE.md](CLAUDE.md) and [docs/developers/operations/github-dispatch-pat-rotation.md](docs/developers/operations/github-dispatch-pat-rotation.md) to document the new mechanics. Add `deploy/*.resolved.mtaext` to `.gitignore`.

  ## Why

  Per #455: `cf deploy --var` is **not** a real flag in the multiapps-cli-plugin. Verified three ways:

  1. `cf deploy --help` lists no `--var` option (only `--require-secure-parameters`, EXPERIMENTAL).
  2. The plugin's [`deploy_command.go`](https://raw.githubusercontent.com/cloudfoundry/multiapps-cli-plugin/master/commands/deploy_command.go) source has no `--var` definition.
  3. Local invocation with `--var foo=bar` prints help and exits with `Unable to resolve <module>#<placeholder>` if a placeholder remains unresolved.

  The `--var`-based deploy.yml block has been latent in CI since 2026-05-06 (commit `490a21b8`). The workflow has not run successfully since 2026-05-05 — every attempt fails earlier at `mbt build` for unrelated reasons (missing Hugo public dir before the cp step). No deploy has ever exercised `--var`, which is why the bug stayed hidden until 2026-06-19's manual local DEV deploy surfaced it.

  ## What changes

  - **`deploy/dev.mtaext`, `deploy/qa.mtaext`, `deploy/prod.mtaext`**: rename placeholders from kebab-case `${content-api-key}` to UPPERCASE `${CONTENT_API_KEY}` etc. (POSIX env-var compatible — required for `envsubst`).
  - **`.github/workflows/deploy.yml`**:
    - Replace `Deploy MTA` step with two steps: `Resolve mtaext placeholders` (runs envsubst into `deploy/<env>.resolved.mtaext`, fails workflow loudly if any placeholder survives) + simplified `Deploy MTA` that points at the resolved file.
    - New `validate-mtaext-substitution` job at top of workflow that runs envsubst with dummy values across all three mtaext files; the `deploy` job depends on it via `needs:`. Catches regressions before any real deploy.
  - **`.gitignore`**: exclude `deploy/*.resolved.mtaext`.
  - **`CLAUDE.md`**: replace the `GITHUB_DISPATCH_TOKEN` gotcha to document the new envsubst flow for both CI and local deploys.
  - **`docs/developers/operations/github-dispatch-pat-rotation.md`**: replace `cf deploy --var` references with the envsubst flow; delete the now-obsolete local-edit-and-revert workaround.

  ## Test plan

  - ✅ Cross-file placeholder name consistency: all four UPPERCASE names appear identically in mtaext placeholders, deploy.yml envsubst whitelist, and deploy.yml `env:` blocks.
  - ✅ Local envsubst smoke on `deploy/dev.mtaext` with `GITHUB_DISPATCH_TOKEN=dummy` yields the substituted value and no surviving `${...}` placeholders.
  - 🟡 The new `validate-mtaext-substitution` job runs in CI on every `workflow_dispatch` of `deploy.yml` (the only trigger that workflow has). Will run for the first time when this PR is merged and someone triggers a deploy.

  ## Out of scope

  - **The Hugo-prep failure** that has caused every CI deploy to fail at `mbt build` since 2026-05-05. Separate concern — different workflow step, different bug. This PR FIXES the substitution mechanism; the Hugo-prep fix is what would let the workflow actually finish a deploy.
  - **Migrating to `--require-secure-parameters`** or any non-`envsubst` substitution mechanism.

  ## Refs

  - Spec: [docs/superpowers/specs/2026-06-20-mtaext-envsubst-substitution-design.md](docs/superpowers/specs/2026-06-20-mtaext-envsubst-substitution-design.md)
  - Plan: [docs/superpowers/plans/2026-06-20-mtaext-envsubst-substitution.md](docs/superpowers/plans/2026-06-20-mtaext-envsubst-substitution.md)
  - PR that introduced `--var` (didn't work, never ran): #438
  - Memory: `feedback_default_off_flags_need_live_smoke` — exactly the pattern here

  Closes #455.
  EOF
  )"
  ```

  Expected: PR URL printed.

---

## Out of scope (per spec)

- The unrelated `mbt build` Hugo-prep failure that has killed every CI deploy since 2026-05-05.
- Switching to `cf deploy --require-secure-parameters` or any other non-envsubst mechanism.
- Encrypting the `*.resolved.mtaext` file at rest.

## Notes for the implementer

- **Re-issue `git checkout`** as part of every commit invocation (memory: `feedback_branch_slip_after_long_session`). Each commit step in this plan reminds you to run `git branch --show-current` first.
- **Don't squash commits.** Spec → plan → 3 mtaext renames → .gitignore → deploy.yml → CLAUDE.md → runbook is a clean reviewable story (9 commits total).
- **Don't commit `deploy/*.resolved.mtaext`.** The `.gitignore` rule defends, but treat the file as ephemeral.
- **The `secrets.DISPATCH_TOKEN` → env `GITHUB_DISPATCH_TOKEN` bridge** is intentional — GH Actions secrets can't start with `GITHUB_` (memory: `feedback_github_actions_secret_github_prefix_reserved`), but the runtime env var on `tutorials-srv` is `GITHUB_DISPATCH_TOKEN`. The deploy.yml `env:` block bridges the names.
