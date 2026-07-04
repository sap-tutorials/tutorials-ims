# Finish credstore migration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `CONTENT_API_KEY`, `GITHUB_DISPATCH_TOKEN`, and `APPROUTER_URL` from the MTA deploy-time envsubst plumbing so credstore is the sole write channel for the two secrets and the (unread) `APPROUTER_URL` env-var pathway disappears entirely.

**Architecture:** Three commits on branch `worktree-finish-credstore-migration`: (1) strip the property lines from `deploy/{dev,qa,prod}.mtaext`, `mta.yaml`, `.deploy/mta.yaml`; (2) strip both envsubst blocks from `.github/workflows/deploy.yml`; (3) update runbooks and root `CLAUDE.md`. No runtime code changes; no new tests. A live-credstore probe on DEV/QA/PROD gates the work before Task 1.

**Tech Stack:** MTA extension descriptors (mtaext), CAP `mta.yaml`, GitHub Actions YAML, `envsubst` from `gettext`, `cf deploy` via multiapps-cli-plugin.

## Global Constraints

- **Branch:** `worktree-finish-credstore-migration` (already created in worktree at `D:\projects\tutorials-poc\.claude\worktrees\finish-credstore-migration`). Confirm `git branch --show-current` in the same shell call before every commit.
- **Reference commits:** `d096ee59` (#683 YOUTUBE_API_KEY), `7cbd2558` (#871 REBUILD_API_KEY runtime), `2cc14f31` (#904 REBUILD_API_KEY plumbing strip) — mimic #904's shape exactly.
- **No runtime code touched:** `approuter/lib/credstore-secret.js`, `srv/lib/secret-resolver.js`, `srv/lib/credstore.js`, `srv/lib/content-store.js`, `srv/lib/rebuild-trigger.js` are read-only for this PR.
- **No new tests:** existing `test/unit/approuter-credstore-secret.test.js` (13 tests) + srv-side equivalents already cover the four-tier resolveSecret path.
- **Pre-flight gate:** Task 0 must pass on DEV, QA, and PROD before Task 1 begins. If any env's credstore is empty or drifted, halt, seed via `/admin-ui/#secrets-display`, re-probe, then start.
- **Post-merge deploy is out of scope** for this plan (tracked separately in the ambient task list as "Redo full DEV deploy from clean mtaext"). The plan ends at "PR opened, ready for review".

---

## Task 0: Pre-flight credstore probes (DEV / QA / PROD)

**Files:** None — verification only. Results captured in the PR body as a checklist during Task 4.

**Interfaces:**
- Consumes: nothing.
- Produces: three pass/fail results (one per env) recorded as a paste-ready markdown block for the PR body.

- [ ] **Step 0.1: DEV — confirm target and probe secret presence**

```bash
cf target -o tutorial-system -s dev
# Expected: Org: tutorial-system, Space: dev, API: https://api.cf.eu10-005.hana.ondemand.com
```

Open `/admin-ui/#secrets-display` on `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/` in a browser (needs XSUAA login). Verify both aliases:
- `CONTENT_API_KEY` — present, "last read" timestamp within the last 24h (proves the runtime is resolving to it, not falling back to env).
- `GITHUB_DISPATCH_TOKEN` — same check.

Record for the PR body:
```
DEV
  CONTENT_API_KEY:       present, last read <ISO timestamp>
  GITHUB_DISPATCH_TOKEN: present, last read <ISO timestamp>
```

- [ ] **Step 0.2: DEV — functional cross-check on CONTENT_API_KEY**

Read the current value from CF app env (envsubst has been writing it there on every CI deploy, so it's the ground truth for what the runtime accepts):

```bash
cf env tutorials-srv | grep '"CONTENT_API_KEY"' | head -1
# Expected: "CONTENT_API_KEY": "<some non-empty string>"
```

Confirm the credstore value matches by testing the /content/publish endpoint:

```bash
CONTENT_API_KEY_VALUE="<paste-from-cf-env-above>"
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "x-api-key: $CONTENT_API_KEY_VALUE" \
  -X POST -H "content-type: application/json" -d '{}' \
  https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/content/publish
# Expected: 400  (bad request — key accepted, payload rejected)
# BAD:      401  (unauthorized — credstore has a different value than env)
```

If 401, the credstore value has drifted from what CI is injecting. Halt: seed credstore with the value from `cf env` before proceeding.

- [ ] **Step 0.3: QA — confirm target and probe secret presence**

```bash
cf target -o tutorial-system -s qa
```

Open `/admin-ui/#secrets-display` on `https://tutorial-system-qa-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/`.

Verify both aliases present, "last read" recent. `CONTENT_API_KEY` is the standard alias name (QA channel uses a separate `CONTENT_API_KEY_QA` alias for `rebuild-content-qa` workflow; that alias is not in scope for this migration).

Record for PR body:
```
QA
  CONTENT_API_KEY:       present, last read <ISO timestamp>
  GITHUB_DISPATCH_TOKEN: present, last read <ISO timestamp>
```

- [ ] **Step 0.4: PROD — confirm target and probe secret presence**

```bash
cf target -o tutorial-system -s prod
```

Open `/admin-ui/#secrets-display` on the prod approuter URL. Verify both aliases. **No functional probe on PROD** — a curl to `/content/publish` even with a bad body would show up in prod logs. Presence + recent-read timestamp is the acceptance criterion.

Record for PR body:
```
PROD
  CONTENT_API_KEY:       present, last read <ISO timestamp>
  GITHUB_DISPATCH_TOKEN: present, last read <ISO timestamp>
```

- [ ] **Step 0.5: Gate — halt if any probe failed**

If ANY of the three envs shows either alias missing, empty, or with a "last read" older than 7 days, STOP. Do NOT proceed to Task 1.

Remediation: use the admin UI at `/admin-ui/#secrets-display` in the failing env to create/update the alias. Value source: `cf env <app>` from that env (envsubst has been writing it there). For `GITHUB_DISPATCH_TOKEN` specifically, if it's missing everywhere the rotation owner in `docs/developers/operations/github-dispatch-pat-rotation.md` is the source of truth for a fresh PAT.

Re-run Steps 0.1-0.4 after seeding.

---

## Task 1: Strip mtaext + mta.yaml base declarations

**Files:**
- Modify: `deploy/dev.mtaext:9-15,29-40` (three property lines + comment blocks)
- Modify: `deploy/qa.mtaext:9-19` (three property lines + comment block)
- Modify: `deploy/prod.mtaext:10-22` (three property lines + comment block)
- Modify: `mta.yaml:113-138,204-227` (three base declarations + rewrite APPROUTER_URL comment)
- Modify: `.deploy/mta.yaml:75-89` (one base declaration)

**Interfaces:**
- Consumes: Task 0 pass on all three envs.
- Produces: mtaext descriptors free of `${CONTENT_API_KEY}`, `${GITHUB_DISPATCH_TOKEN}`, `${APPROUTER_URL}` placeholders; base `mta.yaml` and `.deploy/mta.yaml` free of the corresponding empty-string declarations that were only there to satisfy the MTA-spec "base must declare before mtaext can override" rule.

- [ ] **Step 1.1: Verify branch**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/finish-credstore-migration
git branch --show-current
# Expected: worktree-finish-credstore-migration
git status --short
# Expected: clean (spec commit dc48292c already landed)
```

- [ ] **Step 1.2: Edit `deploy/dev.mtaext`**

Replace the current file contents with:

```yaml
_schema-version: 3.3.0
ID: tutorials-ims-dev
extends: tutorials-ims

modules:
  - name: tutorials-srv
    properties:
      EXPOSE_CAP_UI: true
      # CONTENT_API_KEY + GITHUB_DISPATCH_TOKEN previously injected here via
      # envsubst. Removed in the credstore-migration follow-up: srv reads both
      # exclusively from the BTP Credential Store via
      # srv/lib/secret-resolver.js. Rotation happens through
      # /admin-ui/#secrets-display; there is no deploy-time write channel any
      # more. See docs/superpowers/specs/2026-07-04-finish-credstore-migration-design.md
      # for the "two-stores-can-drift" rationale.
      #
      # KG Phase 1 flag flipped 2026-06-19 (#381 / #442). Override the
      # mta.yaml default ('false') so MTA redeploys preserve the DEV-only
      # flip — `cf set-env` overrides do NOT survive `cf deploy` of a new
      # MTA. prod.mtaext / qa.mtaext intentionally inherit 'false' until
      # Phase 1 is signed off.
      KNOWLEDGE_GRAPH_ENABLED: 'true'

  - name: tutorials-approuter
    parameters:
      app-name: tutorials-dev-approuter
    properties:
      XS_APP_LOG_LEVEL: debug
      DEBUG: "xs-approuter:*"
      # REBUILD_API_KEY was formerly injected here via envsubst against
      # deploy.yml's $REBUILD_API_KEY. Removed as the third and final rollout
      # step of PR #871 (issue #903): the approuter now reads REBUILD_API_KEY
      # exclusively from the BTP Credential Store via
      # approuter/lib/credstore-secret.js. APPROUTER_URL followed the same
      # pattern in the finish-credstore-migration PR: it had zero runtime
      # readers so it was removed rather than migrated.
```

- [ ] **Step 1.3: Edit `deploy/qa.mtaext`**

Replace the current file contents with:

```yaml
_schema-version: 3.3.0
ID: tutorials-ims-qa
extends: tutorials-ims

modules:
  - name: tutorials-srv
    properties:
      EXPOSE_CAP_UI: true
      # CONTENT_API_KEY + GITHUB_DISPATCH_TOKEN moved to credstore-only in the
      # finish-credstore-migration PR. See deploy/dev.mtaext for the rationale.

  - name: tutorials-approuter
    parameters:
      app-name: tutorials-qa-approuter
    properties:
      # REBUILD_API_KEY was formerly injected here — removed in PR #903
      # rollout step 3 (#871 follow-up). APPROUTER_URL followed the same
      # pattern in the finish-credstore-migration PR (no runtime readers).

resources:
  - name: tutorials-xsuaa
    parameters:
      service-name: xsuaa-imsqa
```

- [ ] **Step 1.4: Edit `deploy/prod.mtaext`**

Replace the current file contents with:

```yaml
_schema-version: 3.3.0
ID: tutorials-ims-prod
extends: tutorials-ims

modules:
  - name: tutorials-srv
    parameters:
      instances: 2
    properties:
      # CONTENT_API_KEY + GITHUB_DISPATCH_TOKEN moved to credstore-only in the
      # finish-credstore-migration PR. See deploy/dev.mtaext for the rationale.

  - name: tutorials-approuter
    parameters:
      app-name: tutorials-prod-approuter
      instances: 2
      keep-existing-routes: true
    properties:
      # REBUILD_API_KEY was formerly injected here — removed in PR #903
      # rollout step 3 (#871 follow-up). APPROUTER_URL followed the same
      # pattern in the finish-credstore-migration PR (no runtime readers).

resources:
  - name: tutorials-xsuaa
    parameters:
      service-name: xsuaa-imsprod
```

- [ ] **Step 1.5: Edit `mta.yaml` — strip srv base declarations at lines 113-138**

In `mta.yaml`, find the `tutorials-srv` module's `properties:` block (currently lines 113-138). Replace the block:

```yaml
    properties:
      EXPOSE_CAP_UI: true
      NODE_ENV: production
      # Per-environment overrides (set via deploy/<env>.mtaext). MTA spec
      # requires base mta.yaml to declare a property before an mtaext can
      # override it — empty/safe defaults here so dev/qa/prod mtaext writes
      # are valid descriptor merges. CI's `Build & Deploy` workflow has been
      # failing at cf login since 2026-06-21 (UAA/OTP cutover) so this gap
      # never surfaced; local deploys hit it on the descriptor-merge step.
      CONTENT_API_KEY: ""
      # GitHub fine-grained PAT for srv/lib/rebuild-trigger.js. Empty here
      # means rebuild-trigger gracefully no-ops (logs one boot warning).
      # Real value will be set via credstore + admin Secrets UI once Phase 2-C
      # bootstrap completes; mtaext placeholder remains for CI-injected values.
      GITHUB_DISPATCH_TOKEN: ""
      # Knowledge graph (PR 7+ of #381): default OFF; flip per-environment via cf set-env.
      # When 'false', `/graph/*` returns 503 (PR 5 gate) and the sidebar island renders nothing.
      KNOWLEDGE_GRAPH_ENABLED: 'false'
      KG_EXTRACT_BUILD_CAP: '200'
      KG_MERGE_SIM_THRESHOLD: '0.92'
      # NOTE: SMTP_HOST/PORT/USER/FROM and REBUILD_TARGET_ENV used to live here.
      # Removed in the credstore-runtime-config follow-up: all 5 SMTP fields are
      # now resolved from BTP Credential Store via srv/lib/secret-resolver.js;
      # REBUILD_TARGET_ENV is resolved from TenantSettings via the admin UI.
      # Admin /admin-ui/#secrets-display + /#tenantsettings-display are the
      # sole sources of truth — env-var fallback was removed for both.
```

with:

```yaml
    properties:
      EXPOSE_CAP_UI: true
      NODE_ENV: production
      # Knowledge graph (PR 7+ of #381): default OFF; flip per-environment via cf set-env.
      # When 'false', `/graph/*` returns 503 (PR 5 gate) and the sidebar island renders nothing.
      KNOWLEDGE_GRAPH_ENABLED: 'false'
      KG_EXTRACT_BUILD_CAP: '200'
      KG_MERGE_SIM_THRESHOLD: '0.92'
      # NOTE: CONTENT_API_KEY, GITHUB_DISPATCH_TOKEN, SMTP_HOST/PORT/USER/FROM
      # and REBUILD_TARGET_ENV used to live here. All resolved from the BTP
      # Credential Store now (via srv/lib/secret-resolver.js) or TenantSettings
      # (via the admin UI). The single source of truth for secret rotation is
      # /admin-ui/#secrets-display; env-var fallbacks in resolveSecret still
      # work for local `cds bind --exec` runs but no deploy path writes to them.
```

- [ ] **Step 1.6: Edit `mta.yaml` — strip approuter APPROUTER_URL declaration at lines 204-227**

In `mta.yaml`, find the `tutorials-approuter` module's `properties:` block. Replace the section:

```yaml
    properties:
      XS_APP_LOG_LEVEL: info
      # Bearer-token gate for POST /admin/rebuild. Runtime resolution:
      # approuter/lib/credstore-secret.js reads from the BTP Credential Store
      # (alias: REBUILD_API_KEY, namespace: tutorials), falling back to this
      # empty env-var if the credstore is unreachable.
      #
      # Rollout history:
      #   #698  — first added as `REBUILD_API_KEY: ${REBUILD_API_KEY}` per-env
      #           via envsubst on deploy/{dev,qa,prod}.mtaext.
      #   #871  — approuter switched to credstore-first resolution
      #           (env fallback preserved).
      #   #903  — mtaext + envsubst plumbing stripped. Runtime reads from
      #           credstore only. Empty base declaration retained so a
      #           missing credstore binding fails at the 503 branch of
      #           rebuildHandler (approuter/server.js:236) rather than a
      #           harder-to-debug undefined-env crash.
      REBUILD_API_KEY: ""
      # Self-URL of this approuter app (used for in-cluster callbacks).
      # Same base-declaration story — qa/prod inject via mtaext, dev needs
      # it too. No code path reads it today (grep -rn 'process.env.APPROUTER_URL'
      # finds nothing), but the placeholder is documented in deploy.yml's
      # envsubst step (line ~38) so we keep the wiring consistent.
      APPROUTER_URL: ""
```

with:

```yaml
    properties:
      XS_APP_LOG_LEVEL: info
      # Bearer-token gate for POST /admin/rebuild. Runtime resolution:
      # approuter/lib/credstore-secret.js reads from the BTP Credential Store
      # (alias: REBUILD_API_KEY, namespace: tutorials), falling back to this
      # empty env-var if the credstore is unreachable.
      #
      # Rollout history:
      #   #698  — first added as `REBUILD_API_KEY: ${REBUILD_API_KEY}` per-env
      #           via envsubst on deploy/{dev,qa,prod}.mtaext.
      #   #871  — approuter switched to credstore-first resolution
      #           (env fallback preserved).
      #   #903  — mtaext + envsubst plumbing stripped. Runtime reads from
      #           credstore only. Empty base declaration retained so a
      #           missing credstore binding fails at the 503 branch of
      #           rebuildHandler (approuter/server.js:236) rather than a
      #           harder-to-debug undefined-env crash.
      REBUILD_API_KEY: ""
      # APPROUTER_URL previously declared here as an empty-string base for
      # deploy.yml's envsubst allowlist. Removed in the finish-credstore-migration
      # PR: no code path reads it at runtime (grep -rn 'process.env.APPROUTER_URL'
      # finds nothing), and the CI-side per-env value lives in
      # vars.APPROUTER_URL_{DEV,QA,PROD} (used by smoke tests + the
      # rebuild-content dispatch target) — those workflow vars stay.
```

- [ ] **Step 1.7: Edit `.deploy/mta.yaml` — strip GITHUB_DISPATCH_TOKEN base declaration at lines 75-89**

In `.deploy/mta.yaml`, find the `tutorials-srv` module's `properties:` block (currently lines 75-100). Replace:

```yaml
    properties:
      NODE_ENV: production
      # Per-environment overrides (set via deploy/<env>.mtaext). MTA spec
      # requires base mta.yaml to declare a property before an mtaext can
      # override it — empty/safe defaults here so dev/qa/prod mtaext writes
      # are valid descriptor merges. CI's `Build & Deploy` workflow has been
      # failing at cf login since 2026-06-21 (UAA/OTP cutover) so this gap
      # never surfaced; local deploys hit it on the descriptor-merge step.
      EXPOSE_CAP_UI: false
      CONTENT_API_KEY: ""
      # GitHub fine-grained PAT for srv/lib/rebuild-trigger.js. Empty here
      # means rebuild-trigger gracefully no-ops (logs one boot warning).
      # Real value will be set via credstore + admin Secrets UI once Phase 2-C
      # bootstrap completes; mtaext placeholder remains for CI-injected values.
      GITHUB_DISPATCH_TOKEN: ""
      # Knowledge graph (PR 7+ of #381): default OFF; flip per-environment via cf set-env.
      # When 'false', `/graph/*` returns 503 (PR 5 gate) and the sidebar island renders nothing.
      KNOWLEDGE_GRAPH_ENABLED: 'false'
      KG_EXTRACT_BUILD_CAP: '200'
      KG_MERGE_SIM_THRESHOLD: '0.92'
      # NOTE: SMTP_HOST/PORT/USER/FROM and REBUILD_TARGET_ENV used to live here.
      # Removed in the credstore-runtime-config follow-up: all 5 SMTP fields are
      # now resolved from BTP Credential Store via srv/lib/secret-resolver.js;
      # REBUILD_TARGET_ENV is resolved from TenantSettings via the admin UI.
      # Admin /admin-ui/#secrets-display + /#tenantsettings-display are the
      # sole sources of truth — env-var fallback was removed for both.
```

with:

```yaml
    properties:
      NODE_ENV: production
      EXPOSE_CAP_UI: false
      # Knowledge graph (PR 7+ of #381): default OFF; flip per-environment via cf set-env.
      # When 'false', `/graph/*` returns 503 (PR 5 gate) and the sidebar island renders nothing.
      KNOWLEDGE_GRAPH_ENABLED: 'false'
      KG_EXTRACT_BUILD_CAP: '200'
      KG_MERGE_SIM_THRESHOLD: '0.92'
      # NOTE: CONTENT_API_KEY, GITHUB_DISPATCH_TOKEN, SMTP_HOST/PORT/USER/FROM
      # and REBUILD_TARGET_ENV used to live here. All resolved from the BTP
      # Credential Store now (via srv/lib/secret-resolver.js) or TenantSettings
      # (via the admin UI). Mirror of the note in the sibling mta.yaml.
```

- [ ] **Step 1.8: Verify — no placeholders remain in any mtaext, no base declarations remain in mta.yaml files**

```bash
grep -nE '\$\{(CONTENT_API_KEY|GITHUB_DISPATCH_TOKEN|APPROUTER_URL)\}' deploy/*.mtaext
# Expected: no output

grep -nE '^\s+(CONTENT_API_KEY|GITHUB_DISPATCH_TOKEN|APPROUTER_URL):\s*""' mta.yaml .deploy/mta.yaml
# Expected: no output
```

If either grep finds anything, fix and re-run.

- [ ] **Step 1.9: Confirm the MTA descriptor still parses**

```bash
node -e "const yaml=require('js-yaml');const fs=require('fs');['mta.yaml','.deploy/mta.yaml','deploy/dev.mtaext','deploy/qa.mtaext','deploy/prod.mtaext'].forEach(f=>{try{yaml.load(fs.readFileSync(f,'utf8'),{schema:yaml.FAILSAFE_SCHEMA});console.log(f,'OK')}catch(e){console.error(f,'FAIL',e.message);process.exit(1)}})"
# Expected: five OK lines, no FAIL.
# (FAILSAFE_SCHEMA parses strings/arrays/maps only — no custom-tag constructors,
# no !!python/... or !!js/... type coercion. All we're checking here is that
# the YAML is syntactically valid, not that types round-trip.)
```

- [ ] **Step 1.10: Commit**

```bash
git add deploy/dev.mtaext deploy/qa.mtaext deploy/prod.mtaext mta.yaml .deploy/mta.yaml
git commit -m "chore(mta): strip CONTENT_API_KEY / GITHUB_DISPATCH_TOKEN / APPROUTER_URL envsubst plumbing from mtaext + mta.yaml

Finishes the credstore migration for these three keys, mirroring
#683 (YOUTUBE_API_KEY) and #904 (REBUILD_API_KEY).

- CONTENT_API_KEY + GITHUB_DISPATCH_TOKEN: srv already reads both via
  resolveSecret() (srv/lib/content-store.js:229,
  srv/lib/rebuild-trigger.js:68). The envsubst-populated env-var was a
  redundant second write channel — exactly the two-stores-can-drift
  class that produced the 2026-07-01→02 outage #904 fixed for
  REBUILD_API_KEY.
- APPROUTER_URL: no runtime readers (mta.yaml:224 explicitly said so).
  Removed rather than migrated. vars.APPROUTER_URL_* GitHub Actions
  variables (used by smoke tests + rebuild-content dispatch) stay
  untouched.

Companion commits update .github/workflows/deploy.yml (drop envsubst
allowlist + secret env blocks) and the local-deploy runbooks."
```

---

## Task 2: Strip deploy.yml envsubst plumbing

**Files:**
- Modify: `.github/workflows/deploy.yml:26-47` (validate-mtaext-substitution precheck block)
- Modify: `.github/workflows/deploy.yml:358-397` (deploy-vars + Resolve mtaext placeholders blocks)

**Interfaces:**
- Consumes: Task 1's stripped mtaext files.
- Produces: workflow that no longer envsubsts the three keys; grep-guard for stray `${…}` retained so future placeholder regressions still fail loudly.

- [ ] **Step 2.1: Edit `.github/workflows/deploy.yml` — precheck job (lines 21-47)**

In `.github/workflows/deploy.yml`, replace the `validate-mtaext-substitution` job block (currently lines 21-47):

```yaml
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
          APPROUTER_URL: https://dummy.example.com
          GITHUB_DISPATCH_TOKEN: dummy-token
        run: |
          set -euo pipefail
          for env in dev qa prod; do
            OUT=$(mktemp)
            envsubst '$CONTENT_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
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
```

with:

```yaml
  validate-mtaext-substitution:
    # [#455 / finish-credstore-migration] Verify no envsubst placeholders
    # remain in any mtaext. After the credstore migration, the three
    # deploy-time secrets (CONTENT_API_KEY, GITHUB_DISPATCH_TOKEN,
    # APPROUTER_URL) no longer live here — the grep-guard catches
    # regressions if anyone tries to reintroduce a ${…} placeholder for
    # a fourth key without also wiring the corresponding envsubst step
    # in the deploy job.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verify no unresolved placeholders in any mtaext
        run: |
          set -euo pipefail
          for env in dev qa prod; do
            # The character class also catches hyphenated leftovers (e.g.
            # ${content-api-key}) so a half-finished rename surfaces here too.
            if grep -nE '\$\{[A-Za-z_-]+\}' "deploy/${env}.mtaext"; then
              echo "::error::deploy/${env}.mtaext still contains \${…} placeholders — see docs/superpowers/specs/2026-07-04-finish-credstore-migration-design.md for the removal rationale."
              exit 1
            fi
          done
          echo "All three mtaext files are placeholder-free."
```

- [ ] **Step 2.2: Edit `.github/workflows/deploy.yml` — deploy step (lines 358-397)**

In the same file, find the two adjacent steps `Resolve deploy variables` (lines 358-365) and `Resolve mtaext placeholders` (lines 367-397). Replace both:

```yaml
      - name: Resolve deploy variables
        id: deploy-vars
        run: |
          case "${{ steps.env.outputs.target }}" in
            dev)  echo "approuter_url=${{ secrets.APPROUTER_URL_DEV }}" >> "$GITHUB_OUTPUT" ;;
            qa)   echo "approuter_url=${{ secrets.APPROUTER_URL_QA }}" >> "$GITHUB_OUTPUT" ;;
            prod) echo "approuter_url=${{ secrets.APPROUTER_URL_PROD }}" >> "$GITHUB_OUTPUT" ;;
          esac

      - name: Resolve mtaext placeholders
        # [#455] envsubst replaces ${VAR} placeholders with real values from
        # CI secrets BEFORE cf deploy sees the file. The --var flag is NOT
        # supported by the multiapps-cli-plugin (verified by reading the
        # plugin's source); the previous --var-based block was non-functional
        # but had never run successfully (CI was failing at mbt build for
        # unrelated reasons since 2026-05-05).
        #
        # [#903 / #871 follow-up] REBUILD_API_KEY was formerly on this
        # allowlist. Removed 2026-07-02: approuter reads it exclusively
        # from the credstore now, so keeping it in the envsubst plumbing
        # only reintroduces the two-stores-can-drift class of failure.
        env:
          CONTENT_API_KEY: ${{ secrets.CONTENT_API_KEY }}
          APPROUTER_URL: ${{ steps.deploy-vars.outputs.approuter_url }}
          GITHUB_DISPATCH_TOKEN: ${{ secrets.DISPATCH_TOKEN }}
        run: |
          set -euo pipefail
          IN=deploy/${{ steps.env.outputs.target }}.mtaext
          OUT=deploy/${{ steps.env.outputs.target }}.resolved.mtaext
          # Restrict substitution to known names — defends against incidental
          # ${OTHER} sequences elsewhere in the file (description text, etc.).
          envsubst '$CONTENT_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
            < "$IN" > "$OUT"
          # Fail loudly if any placeholder survived. The character class
          # accepts hyphenated names too (e.g. ${content-api-key}) so a
          # half-finished rename surfaces the same way as a typo.
          if grep -nE '\$\{[A-Za-z_-]+\}' "$OUT"; then
            echo "::error::Unresolved placeholder(s) in $OUT — check that the env-var is exported and matches the placeholder name."
            exit 1
          fi
```

with (deletes both steps outright — `deploy-vars`'s only output was `approuter_url`, consumed only by the removed `Resolve mtaext placeholders` step):

```yaml
      - name: Verify no unresolved placeholders (target env)
        # [finish-credstore-migration] After stripping the three deploy-time
        # secrets from the mtaext files, cf deploy consumes them verbatim.
        # This guard mirrors validate-mtaext-substitution but scoped to the
        # target env for a clearer error in the deploy job's logs if someone
        # reintroduces a ${…} placeholder.
        run: |
          set -euo pipefail
          IN=deploy/${{ steps.env.outputs.target }}.mtaext
          if grep -nE '\$\{[A-Za-z_-]+\}' "$IN"; then
            echo "::error::$IN contains \${…} placeholders — see docs/superpowers/specs/2026-07-04-finish-credstore-migration-design.md before adding new deploy-time envsubst plumbing."
            exit 1
          fi
```

- [ ] **Step 2.3: Update the Deploy MTA step to reference the plain mtaext (not `.resolved.mtaext`)**

Find the `Deploy MTA` step (lines 399+) and any subsequent references to `deploy/${{ steps.env.outputs.target }}.resolved.mtaext`. Change them to `deploy/${{ steps.env.outputs.target }}.mtaext`.

```bash
# Sanity: search for any remaining .resolved.mtaext reference in deploy.yml
grep -n 'resolved.mtaext' .github/workflows/deploy.yml
# Expected: no output. If any lines match, replace them per above.
```

- [ ] **Step 2.4: Verify workflow parses**

```bash
python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('OK')"
# Expected: OK
```

- [ ] **Step 2.5: Verify the three keys are gone from every deploy.yml reference**

```bash
grep -nE 'CONTENT_API_KEY|GITHUB_DISPATCH_TOKEN|APPROUTER_URL' .github/workflows/deploy.yml
# Expected: no output.
```

If any references remain (e.g. in the smoke/axe steps below the deploy job), those are the SMOKE_BASE_URL uses that read from `vars.APPROUTER_URL_*` — those are legitimate and out of scope. Sanity: the only surviving matches should be to `${{ vars.APPROUTER_URL_… }}`, not `${{ secrets.… }}` and not bare env-var references. If any match is on `secrets.CONTENT_API_KEY`, `secrets.DISPATCH_TOKEN`, or `secrets.APPROUTER_URL_*` inside the deploy job (as opposed to the smoke or rebuild jobs), that's a leftover — remove it.

- [ ] **Step 2.6: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): drop CONTENT_API_KEY / GITHUB_DISPATCH_TOKEN / APPROUTER_URL from envsubst plumbing

Companion to the mtaext strip. Removes both envsubst blocks:

- validate-mtaext-substitution precheck no longer runs envsubst; it just
  greps for any surviving \${…} placeholder. Kept as a regression guard
  for future placeholder additions.
- deploy step no longer resolves mtaext to a .resolved.mtaext. cf deploy
  consumes deploy/<env>.mtaext verbatim.

secrets.CONTENT_API_KEY, secrets.DISPATCH_TOKEN, and
secrets.APPROUTER_URL_{DEV,QA,PROD} become dead after this merges — GH
admin should delete them in a follow-up cleanup PR. vars.APPROUTER_URL_*
(used by smoke tests and rebuild-content dispatch) stays."
```

---

## Task 3: Update runbooks and root CLAUDE.md

**Files:**
- Modify: `docs/developers/operations/mta-deployment.md:395-424` (empty-value-placeholders section)
- Modify: `docs/developers/operations/github-dispatch-pat-rotation.md:63-79` (local rotation validation block)
- Modify: `CLAUDE.md:96` (Local manual deploy with placeholders bullet)

**Interfaces:**
- Consumes: Task 1 + 2 landed.
- Produces: runbooks and root CLAUDE.md that no longer instruct readers to run the removed envsubst incantation.

- [ ] **Step 3.1: Edit `docs/developers/operations/mta-deployment.md`**

Locate the "Empty-value placeholders become YAML `null` and MTA rejects them" section (currently ~lines 395-424). Replace the entire section with:

```markdown
### Local deploy no longer needs envsubst

As of the finish-credstore-migration PR (2026-07-04), `deploy/{dev,qa,prod}.mtaext` contain no `${…}` placeholders — the three deploy-time secrets (`CONTENT_API_KEY`, `GITHUB_DISPATCH_TOKEN`) live exclusively in the BTP Credential Store, and `APPROUTER_URL` was removed entirely (no code reads it).

The local deploy is now one line:

```bash
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

**Secrets seeded elsewhere:** Manage rotation through `/admin-ui/#secrets-display` on the target env's approuter. If a fresh env has never had secrets seeded, `contentAuthMiddleware` returns 503 "Content API not configured" — seed the aliases before running `POST /content/publish`.

**Prior migrations for context:**
- `REBUILD_API_KEY` — moved to credstore in #871, envsubst stripped in #904 (2026-07-02).
- `YOUTUBE_API_KEY` — moved to credstore in #683.
- SMTP transport (`SMTP_HOST/PORT/USER/FROM/PASS`) — moved to credstore in #545/#580.
- `REBUILD_TARGET_ENV` — moved to `TenantSettings` HANA entity, managed via `/admin-ui/#tenantsettings-display`.

The envsubst allowlist in `.github/workflows/deploy.yml` is now empty — the precheck job just greps for surviving `${…}` placeholders as a regression guard.
```

- [ ] **Step 3.2: Edit `docs/developers/operations/github-dispatch-pat-rotation.md`**

Locate the "Local rotation validation" block (currently ~lines 63-79). Replace it with:

```markdown
   **Local rotation validation** (optional — verify the new token before merging the secret bump to all envs):

   Rotate through the admin UI at `/admin-ui/#secrets-display` on the target env's approuter (alias `GITHUB_DISPATCH_TOKEN`). The runtime picks up the new value on the next `resolveSecret` call — the 5-minute TTL means propagation is near-immediate. Confirm via:

   ```bash
   cf logs tutorials-srv --recent | grep 'rebuild-trigger'
   # Expected: [rebuild-trigger] active — admin writes will dispatch with environment='<env>'
   # NOT expected: [rebuild-trigger] unset-token warning
   ```

   If you need to invalidate the resolver cache before the 5-minute TTL, use the admin UI's "invalidate" action on the alias — this calls `invalidateSecret('GITHUB_DISPATCH_TOKEN')` server-side.
```

- [ ] **Step 3.3: Edit root `CLAUDE.md`**

Locate the "Local manual deploy with placeholders" bullet (currently line 96 of the root `CLAUDE.md`). Replace the whole bullet:

```markdown
- **Local manual deploy with placeholders** — `export` the four env vars (`CONTENT_API_KEY`, `REBUILD_API_KEY`, `APPROUTER_URL`, `GITHUB_DISPATCH_TOKEN`), run `envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' < deploy/dev.mtaext > deploy/dev.resolved.mtaext`, then `cf deploy … -e ../deploy/dev.resolved.mtaext -f`. `cf deploy --var` is NOT supported by multiapps-cli-plugin.
```

with:

```markdown
- **Local deploy is envsubst-free** — All four secrets (`CONTENT_API_KEY`, `REBUILD_API_KEY`, `APPROUTER_URL`, `GITHUB_DISPATCH_TOKEN`) formerly injected via `envsubst` now live exclusively in the BTP Credential Store (or have been removed entirely, in APPROUTER_URL's case). Run `cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f` directly. Rotation happens through `/admin-ui/#secrets-display` on the target env's approuter. See [mta-deployment.md](docs/developers/operations/mta-deployment.md) "Local deploy no longer needs envsubst" for the full context.
```

- [ ] **Step 3.4: Verify — no runbook still tells the reader to envsubst**

```bash
grep -RnE 'envsubst.*CONTENT_API_KEY|envsubst.*GITHUB_DISPATCH_TOKEN|envsubst.*APPROUTER_URL' docs/ CLAUDE.md
# Expected: no output
```

If anything matches, edit that file to remove the outdated instruction.

- [ ] **Step 3.5: Commit**

```bash
git add docs/developers/operations/mta-deployment.md docs/developers/operations/github-dispatch-pat-rotation.md CLAUDE.md
git commit -m "docs: update runbooks + root CLAUDE.md for envsubst-free local deploy

Companion to the mtaext + deploy.yml strip. Removes the four-env-var
export + envsubst incantation from:
- docs/developers/operations/mta-deployment.md (empty-placeholder section)
- docs/developers/operations/github-dispatch-pat-rotation.md (local rotation validation)
- CLAUDE.md root (Local manual deploy with placeholders bullet)

The new one-liner is: cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
Rotation happens through /admin-ui/#secrets-display."
```

---

## Task 4: Push branch and open draft PR

**Files:** None — GitHub operation only.

**Interfaces:**
- Consumes: Tasks 1-3 committed on `worktree-finish-credstore-migration`.
- Produces: draft PR against `main` with the three-env probe checklist from Task 0 in the body.

- [ ] **Step 4.1: Verify branch state**

```bash
git branch --show-current
# Expected: worktree-finish-credstore-migration
git log --oneline main..HEAD
# Expected: exactly 4 commits (spec + 3 implementation commits):
#   <sha> docs: update runbooks + root CLAUDE.md for envsubst-free local deploy
#   <sha> ci(deploy): drop CONTENT_API_KEY / GITHUB_DISPATCH_TOKEN / APPROUTER_URL from envsubst plumbing
#   <sha> chore(mta): strip CONTENT_API_KEY / GITHUB_DISPATCH_TOKEN / APPROUTER_URL envsubst plumbing from mtaext + mta.yaml
#   dc48292c docs(specs): design for finishing credstore migration (…)
```

- [ ] **Step 4.2: Push the branch**

```bash
git push -u origin worktree-finish-credstore-migration
# Expected: branch pushed, remote tracking set up.
```

- [ ] **Step 4.3: Open the PR**

```bash
gh pr create --draft --base main --head worktree-finish-credstore-migration \
  --title "chore(deploy): finish credstore migration — strip CONTENT_API_KEY / GITHUB_DISPATCH_TOKEN / APPROUTER_URL envsubst plumbing" \
  --body-file /dev/stdin <<'EOF'
## Problem

A local `cf deploy` against `tutorial-system/dev` on 2026-07-04 failed at descriptor resolution:

```
Error resolving merged descriptor properties and parameters: Unable to resolve "tutorials-srv#CONTENT_API_KEY"
```

Root cause: `deploy/dev.mtaext` still contains `${CONTENT_API_KEY}`, `${GITHUB_DISPATCH_TOKEN}`, and `${APPROUTER_URL}` placeholders that only resolve when CI's `envsubst` step runs. The workstation cannot deploy without either manually exporting values that are supposed to live in credstore, or finishing this migration.

For `CONTENT_API_KEY` and `GITHUB_DISPATCH_TOKEN` the runtime is already credstore-first (`srv/lib/content-store.js:229`, `srv/lib/rebuild-trigger.js:68` both call `resolveSecret`). The envsubst-populated env var is a redundant second write channel — exactly the "two stores can drift" class that produced the 2026-07-01→02 HTTP 401 outage that #904 fixed for `REBUILD_API_KEY`.

For `APPROUTER_URL` there are **zero runtime readers** (`mta.yaml:224` explicitly documented this). Removed rather than migrated.

## Changes

Three commits:

1. **`chore(mta): strip … from mtaext + mta.yaml`** — drops 3 property lines from each of `deploy/{dev,qa,prod}.mtaext`, drops the base declarations from `mta.yaml` and `.deploy/mta.yaml`.
2. **`ci(deploy): drop … from envsubst plumbing`** — trims both envsubst blocks in `.github/workflows/deploy.yml` (precheck + deploy step). Grep-guard for `${…}` regressions retained.
3. **`docs: update runbooks + root CLAUDE.md …`** — removes stale envsubst incantations from `docs/developers/operations/{mta-deployment,github-dispatch-pat-rotation}.md` and the "Local manual deploy" bullet in `CLAUDE.md`.

Full rationale: `docs/superpowers/specs/2026-07-04-finish-credstore-migration-design.md` (committed as `dc48292c`).

## Pre-flight probe results

- [ ] **DEV**  — `CONTENT_API_KEY` present, last read <ISO>; `GITHUB_DISPATCH_TOKEN` present, last read <ISO>; functional cross-check on `/content/publish` returned 400 (not 401)
- [ ] **QA**   — `CONTENT_API_KEY` present, last read <ISO>; `GITHUB_DISPATCH_TOKEN` present, last read <ISO>
- [ ] **PROD** — `CONTENT_API_KEY` present, last read <ISO>; `GITHUB_DISPATCH_TOKEN` present, last read <ISO>

(Fill in the timestamps recorded in Task 0.)

## Not in this PR (deliberate)

- **No runtime code changes.** `resolveSecret` and its env-fallback tier stay wired for local `cds bind --exec` and tests.
- **No consolidation of the two resolver copies** (`approuter/lib/credstore-secret.js` CJS + `srv/lib/secret-resolver.js` ESM). Legitimate follow-up; flagged in #871's body.
- **No GitHub Actions secrets cleanup.** After this merges, `secrets.CONTENT_API_KEY`, `secrets.DISPATCH_TOKEN`, `secrets.APPROUTER_URL_{DEV,QA,PROD}` become dead — a maintainer with GH admin should delete them. `vars.APPROUTER_URL_*` (used by smoke tests + rebuild-content dispatch) **stays**.

## Testing

No new tests. Existing `test/unit/approuter-credstore-secret.test.js` (13 tests) plus srv-side equivalents cover the four-tier `resolveSecret` path. The verification signal is the pre-flight probe checklist above.

## Rollback

`git revert` on main restores envsubst plumbing. Runtime 503 on deploy → invalidate cache + re-seed via `/admin-ui/#secrets-display`. Emergency break-glass: `cf set-env tutorials-srv CONTENT_API_KEY <value> && cf restage tutorials-srv` (reintroduces drift class — emergency only).
EOF
```

- [ ] **Step 4.4: Report PR URL**

`gh pr create` prints the URL. Record it. Announce to the user: "PR opened as draft at `<url>` — pre-flight probe results still need to be filled in from Task 0 results before flipping to ready-for-review."

- [ ] **Step 4.5: Fill in Task 0 probe results in the PR body**

Use `gh pr edit <number> --body-file <file>` to replace the three `<ISO>` placeholders with the actual timestamps recorded during Task 0.

- [ ] **Step 4.6: Flip to ready-for-review after CI green**

Wait for CI (which now just runs `validate-mtaext-substitution` grep-guard + the deploy validation up to the point where a real cf-login would be needed — CI has been failing there since 2026-06-21, which is fine; the validate-mtaext-substitution job status is the meaningful signal).

```bash
gh pr ready <number>
```

Announce completion: "Ready for review at `<url>`."

---

## Self-review notes

**Spec coverage:**
- Spec §"Deploy descriptors" → Task 1 Steps 1.2-1.4 ✓
- Spec §"Base MTA descriptor" → Task 1 Steps 1.5-1.7 ✓
- Spec §"CI workflow" → Task 2 Steps 2.1-2.3 ✓
- Spec §"Runbooks" → Task 3 Steps 3.1-3.2 ✓
- Spec §"Root CLAUDE.md" → Task 3 Step 3.3 ✓
- Spec §"Rollout Step 0" → Task 0 in full ✓
- Spec §"Rollout Step 1" three-commit shape → Tasks 1/2/3 ✓
- Spec §"Rollout Step 2" PR → Task 4 ✓
- Spec §"Rollback" → covered in the PR body content in Step 4.3 ✓
- Spec §"Testing" — no new tests → confirmed in Global Constraints ✓

**Placeholder scan:** No "TBD"/"TODO" in any step. `<ISO>` and `<number>`/`<url>` in Step 4.3-4.6 are runtime-collected values (timestamps, PR number, PR URL) — legitimate placeholders that the executor fills in, not gaps in the plan.

**Type consistency:** No types involved (config/YAML/docs only). File paths verified consistent across tasks by reading current-state files during plan drafting.

**Right-sizing:** Task 0 is the pre-flight gate (its own commit-less deliverable — probe results); Tasks 1/2/3 are the three commits called out in the spec's rollout section; Task 4 is the PR. Five tasks total, matching the design's rollout shape.
