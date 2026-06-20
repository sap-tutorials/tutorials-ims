# MTA extension descriptor placeholder substitution — design

**Issue:** [#455](https://github.com/sap-tutorials/tutorials-ims/issues/455) — `deploy.yml` `--var` flags may not be honored by multiapps plugin (PR #438 follow-up)

**Date:** 2026-06-20

## Problem

[`.github/workflows/deploy.yml`](../../../.github/workflows/deploy.yml) uses `cf deploy mta_archives/*.mtar -e ... --var content-api-key="..." --var rebuild-api-key="..." --var approuter-url="..." --var github-dispatch-token="..."` to substitute `${...}` placeholders in extension descriptors at deploy time.

**The `--var` flag does not exist** in the [`multiapps-cli-plugin`](https://github.com/cloudfoundry/multiapps-cli-plugin) (the `cf deploy` subcommand provider). Verified by:

1. `cf deploy --help` does not list `--var` — only `--require-secure-parameters` (EXPERIMENTAL) for secrets.
2. Reading the plugin's [`deploy_command.go`](https://raw.githubusercontent.com/cloudfoundry/multiapps-cli-plugin/master/commands/deploy_command.go) source: only `--require-secure-parameters` is defined.
3. Local `cf deploy ... --var foo=bar -f` prints help and aborts with "Unable to resolve `tutorials-srv#github-dispatch-token`" when the placeholder remains unresolved.

The bug has been latent in CI since 2026-05-06 (commit `490a21b8`, "feat(deploy): enable blue-green deployment for production"). The deploy.yml workflow has not run successfully since 2026-05-05 — every attempt fails earlier at `mbt build` (missing Hugo public dir before the `cp` step). No deploy ever exercised `--var`, so nobody noticed.

`mbt build -e some.mtaext` does NOT substitute placeholders either — verified by running `mbt build -e <test>.mtaext` and inspecting the generated `META-INF/mtad.yaml`: `${test-placeholder}` survived literally.

## Goal

Replace `--var`-based substitution with a working mechanism that:

1. Substitutes the four current placeholders (`${content-api-key}`, `${rebuild-api-key}`, `${approuter-url}`, `${github-dispatch-token}`) at deploy time from CI secrets.
2. Works identically in CI and local Windows-Git-Bash deploys.
3. Fails loudly if any placeholder doesn't resolve, rather than passing an unresolved literal to `cf deploy`.
4. Is verifiable in isolation (no need for a real deploy to validate the substitution step).

## Approach

### 1. Rename placeholders to POSIX-compatible env-var names

The current placeholders use kebab-case (`content-api-key`). `envsubst` only substitutes valid POSIX env-var names — alphanumerics + underscores. Hyphens are not valid. So:

| Current placeholder | New placeholder |
|---|---|
| `${content-api-key}` | `${CONTENT_API_KEY}` |
| `${rebuild-api-key}` | `${REBUILD_API_KEY}` |
| `${approuter-url}` | `${APPROUTER_URL}` |
| `${github-dispatch-token}` | `${GITHUB_DISPATCH_TOKEN}` |

Files affected:

- [`deploy/dev.mtaext`](../../../deploy/dev.mtaext) — only `GITHUB_DISPATCH_TOKEN`
- [`deploy/qa.mtaext`](../../../deploy/qa.mtaext) — all four
- [`deploy/prod.mtaext`](../../../deploy/prod.mtaext) — all four

The new names match the GitHub Actions secret names (`secrets.CONTENT_API_KEY`, `secrets.DISPATCH_TOKEN`) and CF env var names already used at runtime — fewer renames once the user mentally maps "CI secret → mtaext placeholder".

> **Note on `secrets.DISPATCH_TOKEN`:** the GitHub Actions secret is named `DISPATCH_TOKEN` (no `GITHUB_` prefix because GitHub reserves `GITHUB_*` for system secrets). The mtaext placeholder name should still be `${GITHUB_DISPATCH_TOKEN}` to match the runtime env var name on `tutorials-srv`. The CI step exports `GITHUB_DISPATCH_TOKEN="${{ secrets.DISPATCH_TOKEN }}"` to bridge them.

### 2. Add an `envsubst` step in `.github/workflows/deploy.yml`

Replace the broken `--var`-based block with:

```yaml
      - name: Resolve mtaext placeholders
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
          # Fail loudly if any placeholder survived.
          if grep -nE '\$\{[A-Z_]+\}' "$OUT"; then
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

The resolved file lives in the runner's working tree only — never committed. The grep guard turns silent placeholder leakage into an immediate workflow failure.

### 3. Update local-deploy guidance in [CLAUDE.md](../../../CLAUDE.md)

Replace the existing "Local manual deploy needs `--var github-dispatch-token=...`" gotcha with the envsubst pattern:

```bash
# Local deploy on Windows (Git Bash) or any *nix:
export CONTENT_API_KEY=...                       # only needed for qa/prod
export REBUILD_API_KEY=...                       # only needed for qa/prod
export APPROUTER_URL=...                         # only needed for qa/prod
export GITHUB_DISPATCH_TOKEN=...                 # all envs

cd D:/projects/tutorials-poc
envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext

cd .deploy
mbt build
cf deploy mta_archives/tutorials-poc_*.mtar -e ../deploy/dev.resolved.mtaext -f

# Cleanup (optional — file is gitignored):
rm -f deploy/dev.resolved.mtaext
```

### 4. Update [docs/developers/operations/github-dispatch-pat-rotation.md](../../developers/operations/github-dispatch-pat-rotation.md)

The runbook references `cf deploy --var github-dispatch-token=` (added in PR #438). Replace with the envsubst flow + a note that the local-edit-and-revert workaround Tom used on 2026-06-19 is no longer needed.

### 5. Add `.gitignore` entry for `deploy/*.resolved.mtaext`

Defense-in-depth so a resolved mtaext (containing real secret values) never accidentally lands in a commit.

### 6. Add a CI substitution-smoke job in `.github/workflows/deploy.yml`

A small job at the top of the workflow that runs `envsubst` over a fixture mtaext with dummy values and asserts the placeholders resolved. Catches regressions where someone reverts the rename or removes the envsubst step:

```yaml
  validate-mtaext-substitution:
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
            if grep -nE '\$\{[A-Z_]+\}' "$OUT"; then
              echo "::error::Unresolved placeholder(s) in deploy/${env}.mtaext after envsubst"
              cat "$OUT"
              exit 1
            fi
          done
          echo "All three mtaext files resolve cleanly."
```

The `deploy` job depends on this via `needs: validate-mtaext-substitution`. If the smoke fails, the deploy never starts.

## Why this approach

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **envsubst + rename to UPPERCASE** (this design) | Standard Unix tool, available in CI and Git Bash. Restricted-name form prevents stray substitutions. Failure mode is immediate-and-loud. Local + CI use identical mechanics. | Placeholder rename is a one-time data churn affecting 4 names across 3 files. | **Chosen** |
| `yq` edit-in-place per property | Path-precise — no risk of substituting incidental `${OTHER}` text. Keeps hyphenated names. | Requires yq + per-property scripting. More moving parts. Diverges from the existing GitHub-Actions-secret naming convention (CONTENT_API_KEY, etc.) which already matches POSIX shape. | Rejected |
| Custom Node script | Most flexible. | Adds a maintained script for what envsubst does in one line. YAGNI. | Rejected |
| `cf deploy --require-secure-parameters` | The plugin's actual secret-handling option. | EXPERIMENTAL flag, undocumented stable interface, requires stdin or unclear file format. Not appropriate for production CI. | Rejected |

## Failure modes

| Mode | Symptom | Action |
|---|---|---|
| Env var not exported in the workflow `env:` block | Placeholder survives in resolved.mtaext; the `grep -nE '\$\{[A-Z_]+\}' "$OUT"` step fails the workflow with the offending name. | Add the missing `KEY: ${{ secrets.KEY }}` line. |
| Placeholder name typo (mtaext says `${CONTENT_API_KEYS}`, env var is `CONTENT_API_KEY`) | Same — placeholder survives, grep guard fails the workflow. | Fix the typo. |
| Resolved file accidentally committed | `.gitignore` entry on `deploy/*.resolved.mtaext` blocks it. If somehow committed anyway, secrets leak. | Pre-commit / pre-push hook would defend, but not adding one in this PR. The combination of `.gitignore` + workflow-only generation + secret rotation is sufficient. |
| Local user forgets to export env var | Placeholder survives; `cf deploy` aborts with "Unable to resolve". User exports the var and retries. | None — error is immediate and clear. |
| envsubst not installed locally | `envsubst: command not found`. | Document install: macOS `brew install gettext`, Linux `apt-get install gettext-base`, Windows already has it via Git Bash. |
| New placeholder added but envsubst whitelist not updated | New placeholder survives; the in-deploy.yml grep guard fails the workflow. | Add the new name to the whitelist string in BOTH the deploy.yml step AND the validate-mtaext-substitution job. |

## Out of scope

- **Fixing the broken Hugo-prep step in deploy.yml** that has caused every CI deploy to fail since 2026-05-05. Separate concern (different workflow step, different bug). The fix here MAKES the workflow able to substitute placeholders correctly; the Hugo-prep fix is what would let it actually finish deploying. File a separate issue if it isn't already.
- **Removing the `--require-secure-parameters` option** from any documentation. We're not using it.
- **Migrating to a non-MTA deploy mechanism** (e.g. plain `cf push` per app). Way out of scope.
- **Encrypting the resolved.mtaext file** at rest. The CI runner is ephemeral; the file lives for seconds. The local user's filesystem is their concern.

## Verification

1. **Unit smoke (added)**: the `validate-mtaext-substitution` workflow job runs `envsubst` over all three mtaext files with dummy env vars and `grep`s for any surviving `${...}` placeholders. Fails loudly if substitution is incomplete.
2. **Local manual deploy** (Tom on Windows): export the four env vars (or just `GITHUB_DISPATCH_TOKEN` for DEV), run the envsubst command, run `cf deploy ... -e deploy/dev.resolved.mtaext -f`. Expect: the deploy succeeds; `cf env tutorials-srv | grep GITHUB_DISPATCH_TOKEN` shows the actual PAT (not empty); `cf logs tutorials-srv --recent | grep rebuild-trigger` shows `[rebuild-trigger] active — admin writes will dispatch with environment='dev'`.
3. **CI deploy** (after the Hugo-prep issue is also fixed in a separate PR): triggering `gh workflow run deploy.yml -f environment=dev` runs validate-mtaext-substitution → resolves placeholders → builds MTAR → deploys. Same `cf env` / `cf logs` checks as #2.

## References

- Issue: [#455](https://github.com/sap-tutorials/tutorials-ims/issues/455)
- PR that introduced `--var` (didn't work, never ran): [#438](https://github.com/sap-tutorials/tutorials-ims/pull/438)
- Affected files: [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml), [deploy/dev.mtaext](../../../deploy/dev.mtaext), [deploy/qa.mtaext](../../../deploy/qa.mtaext), [deploy/prod.mtaext](../../../deploy/prod.mtaext), [docs/developers/operations/github-dispatch-pat-rotation.md](../../developers/operations/github-dispatch-pat-rotation.md), [CLAUDE.md](../../../CLAUDE.md), [.gitignore](../../../.gitignore)
- Memory: [[feedback_default_off_flags_need_live_smoke]] — exactly this pattern (PR landed, no live deploy validation)
- Memory: [[feedback_cf_set_env_drops_on_redeploy]] — the parent change that introduced GITHUB_DISPATCH_TOKEN as an mtaext-substituted variable in #438
