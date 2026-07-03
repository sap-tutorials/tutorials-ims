# #807 — Scaling-playbook baseline validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop the k6 suite PR (#965) left open — dispatch the suite against DEV, correlate `k6` p95 with `/admin/metrics/live` cache and pool metrics, tighten `test/load/config.js` thresholds, and append a validation-log row to `docs/developers/architecture/scaling-playbook.md`.

**Architecture:** No product-code changes. This is an ops-execution task with a small doc/config PR at the end. Executor runs `gh workflow run load-test.yml` five times (smoke → tutorials-cold → tutorials-hot → baseline × 2 → ws), captures `/admin/metrics/live` before/after each, downloads k6 summaries, computes tightened threshold values (`max(1.5 × observed_p95, 100)` rounded to nearest 50 ms — never loosen), edits `test/load/config.js`, appends the validation log, opens a draft PR.

**Tech Stack:** k6 (`grafana/k6:0.51.0` in CI), `gh` CLI, `cf` CLI, `curl`, `jq`, GitHub Actions (`.github/workflows/load-test.yml`), CAP (`/admin/metrics/live` route, `basicAuthMiddleware`), runtime-config (`tenantSettings.techUsers`).

## Global Constraints

- DEV-only. Never dispatch against PROD. `LOAD_BASE_URL` defaults to `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com`.
- No product-source code changes. Only `test/load/config.js`, `docs/developers/architecture/scaling-playbook.md`, and the spec/plan files under `docs/superpowers/`.
- Threshold rule: `max(1.5 × observed_p95, 100)` rounded to nearest 50 ms. **Never loosen** an existing ceiling — if the formula proposes a higher value than current, leave current unchanged.
- `observed_p95` = `max(run1, run2)` of the two `baseline` dispatches (≥5 min apart). If either aborts, re-dispatch — do not tighten off a single sample.
- Correlation window: `/admin/metrics/live` snapshot **immediately before** dispatch and **immediately after** run completion. Save both.
- Auth: temporary `Admin`-scoped entry in `tenantSettings.techUsers` (exported as `ADMIN_BASIC_AUTH="user:pass"`). Rotate in Task 8.
- Cold-cache dispatch: **do not** run `cf restart-app-instance` — LRU residual is expected and reported as `hit/(hit+miss)` ratio during the scenario window.
- Playbook rows validated by this pass: #1 (AppRouter), #5 (in-memory caches), #7 (HANA pool). Rows #2, #3, #4, #6, #12–14 are explicitly not exercised.
- Deliverables in one PR titled `chore(#807): scaling-playbook baseline validation + tightened k6 thresholds`. Draft first, promoted to ready only after a re-dispatch of `baseline` passes against the tightened thresholds.
- Working directory: `.claude/worktrees/807-scaling-baseline` on branch `worktree-807-scaling-baseline`. Do not switch branches mid-task.
- Base URL (srv): `https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com`.

## File Structure

- **Create** `.load-artifacts/` (worktree-local, gitignored) — holds `before-<scenario>.json`, `after-<scenario>.json`, and downloaded k6 summaries. Not committed. Add to `.gitignore` in Task 1.
- **Modify** `test/load/config.js` — tighten `THRESHOLDS` entries (Task 6).
- **Modify** `docs/developers/architecture/scaling-playbook.md` — append `## Validation log` section; add "validated 2026-07-04" notes to Row #1 / #5 / #7 in the table (Task 7).
- **Read-only reference** during execution: `docs/superpowers/specs/2026-07-03-807-scaling-baseline-validation-design.md` (this plan's spec).

---

### Task 1: Pre-flight — verify environment, add gitignore entry

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `.load-artifacts/` directory exists, is ignored by git, and is used by Tasks 2–5 as the scratch dir.

- [ ] **Step 1: Confirm branch and working directory**

Run in the same shell you'll use for the rest of the plan:

```bash
pwd
git branch --show-current
```

Expected:
```
D:/projects/tutorials-poc/.claude/worktrees/807-scaling-baseline
worktree-807-scaling-baseline
```

If either is wrong: STOP. Re-enter the worktree via `EnterWorktree` before continuing.

- [ ] **Step 2: Confirm DEV CF target**

```bash
cf target
```

Expected: `org` and `space` correspond to DEV (subaccount `tutorial-system`, space `dev`). If not, `cf login` and re-target. **Do not proceed** if the target is anything other than DEV.

- [ ] **Step 3: Confirm both apps are running**

```bash
cf apps
```

Expected: `tutorials-approuter` and `tutorials-srv` both `started`, instance count `1/1`.

- [ ] **Step 4: Confirm `METRICS_DB_WRAP=true` on srv**

```bash
cf env tutorials-srv | grep -E 'METRICS_ENABLED|METRICS_DB_WRAP'
```

Expected: `METRICS_DB_WRAP: true`. If `METRICS_ENABLED` is present it must not be `false`. Absent = default true, that's fine.

If `METRICS_DB_WRAP` is not `true`: STOP. This variable was enabled in PR #937 (#909). Do not attempt to set it here; that would deviate from the scope. File an issue and stop.

- [ ] **Step 5: Confirm no rebuild-content workflow is in flight**

```bash
gh run list --workflow=rebuild-content.yml --limit 5 --repo sap-tutorials/tutorials-ims
```

Expected: no run with `status` = `in_progress` or `queued`. If one is running, wait for it to finish, then wait 10 more minutes so the LRU stabilises before proceeding.

- [ ] **Step 6: Add `.load-artifacts/` to `.gitignore`**

Read the top of `.gitignore` to find an appropriate section (usually near `.tutorial-cache/` or `.migration-data/`). Append this line in that section:

```
.load-artifacts/
```

- [ ] **Step 7: Create the scratch directory**

```bash
mkdir -p .load-artifacts
```

- [ ] **Step 8: Verify gitignore**

```bash
git status --short
```

Expected: `.gitignore` shows as modified. `.load-artifacts/` does NOT appear (proving it's ignored).

- [ ] **Step 9: Commit**

```bash
git add .gitignore
git -c core.autocrlf=false commit -m "chore(#807): gitignore .load-artifacts/ scratch dir

Local scratch for k6 summaries and /admin/metrics/live captures during
the #807 baseline validation pass. Not committed.

Refs #807"
```

---

### Task 2: Provision temporary Admin tech-user

**Files:**
- No files edited. Runtime-config change via admin UI.

**Interfaces:**
- Consumes: DEV CF login from Task 1.
- Produces: `ADMIN_BASIC_AUTH` env var in the executor's shell of the form `"user:pass"`. Used by Tasks 3–5 in `curl -su "$ADMIN_BASIC_AUTH" …`.

- [ ] **Step 1: Read current tenantSettings.techUsers**

Open `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/#tenant-display` in a browser (XSUAA-authenticated). Look at the `techUsers` text-area. Format is:

```
user1:pass1:role1,role2;user2:pass2:role3
```

Note the existing entries. **Do not delete any.**

- [ ] **Step 2: Choose a unique tech-user name**

Format: `k6-807-<8-random-lowercase-hex>`. Example: `k6-807-a1b2c3d4`.

Generate a strong random password (e.g. `openssl rand -base64 24` — 32 chars, no colons). Verify the password contains no `:` or `;` (those are the field/entry separators).

- [ ] **Step 3: Append the new tech-user**

If the field is currently `svc-account:existingpass:Admin`, change it to:

```
svc-account:existingpass:Admin;k6-807-a1b2c3d4:<generated-password>:Admin
```

Click **Save**. The change takes effect within a few seconds (the tenant-settings resolver caches for 60s but is invalidated on write).

- [ ] **Step 4: Export `ADMIN_BASIC_AUTH`**

In your executor shell:

```bash
export ADMIN_BASIC_AUTH="k6-807-a1b2c3d4:<generated-password>"
```

**Do NOT commit this value anywhere.** It lives only in the executor's shell.

- [ ] **Step 5: Verify auth works**

```bash
export SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
curl -su "$ADMIN_BASIC_AUTH" -w '\nHTTP %{http_code}\n' "$SRV_URL/admin/metrics/live" | tail -20
```

Expected: `HTTP 200`, and the body is a JSON object containing keys `snapshot`, `instanceId`, `uptimeSec`, `dbWrapEnabled` (`true`), `generatedAt`.

If HTTP 401: password was mistyped or `:` sneaked into it. Re-generate.
If HTTP 403: the `Admin` role suffix is missing on the tech-user entry. Return to Step 3 and fix.
If HTTP 503: `basicAuthMiddleware` didn't parse the entry. Check for stray whitespace in the text-area value.

**Do not commit anything in this task.** No git operations.

---

### Task 3: Dispatch smoke — safety check

**Files:**
- Create: `.load-artifacts/before-smoke.json`, `.load-artifacts/after-smoke.json`, `.load-artifacts/smoke-run-id.txt`, `.load-artifacts/k6-summary-01-smoke.json`

**Interfaces:**
- Consumes: `ADMIN_BASIC_AUTH`, `SRV_URL` from Task 2.
- Produces: A green `smoke` Actions run recorded in `.load-artifacts/smoke-run-id.txt`. If red, halt and document.

- [ ] **Step 1: Capture before-snapshot**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/before-smoke.json
jq '.snapshot | keys' .load-artifacts/before-smoke.json | head -20
```

Expected: JSON object, keys array includes `counters`, `gauges`, `histograms`.

- [ ] **Step 2: Dispatch smoke**

```bash
gh workflow run load-test.yml -f scenario=smoke --repo sap-tutorials/tutorials-ims
sleep 5
gh run list --workflow=load-test.yml --limit 1 --repo sap-tutorials/tutorials-ims
```

Copy the run ID from the first row into a variable:

```bash
export RUN_ID=<run-id-from-list>
echo "$RUN_ID" > .load-artifacts/smoke-run-id.txt
```

- [ ] **Step 3: Wait for completion**

```bash
gh run watch "$RUN_ID" --repo sap-tutorials/tutorials-ims
```

Expected: exit 0, workflow status `completed`, conclusion `success`. Smoke is 30 s of k6 plus ~2 min of CI overhead → total ~3 min.

If conclusion is `success` but a step is annotated `SKIP: publish in progress`: the publish-in-flight guard tripped. Wait 5 min, re-run this task from Step 1.

If conclusion is `failure`: STOP. The k6 suite is regressing against DEV. Do not proceed to later scenarios. Open a follow-up issue with the run URL and pause #807.

- [ ] **Step 4: Capture after-snapshot**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/after-smoke.json
```

- [ ] **Step 5: Download the k6 artifact**

```bash
gh run download "$RUN_ID" -n k6-summaries -D .load-artifacts/ --repo sap-tutorials/tutorials-ims
ls -la .load-artifacts/k6-summary-*.json
```

Expected: `k6-summary-01-smoke.json` present.

- [ ] **Step 6: Sanity-check the summary**

```bash
jq '.metrics.http_req_failed.values.rate' .load-artifacts/k6-summary-01-smoke.json
jq '.metrics.http_req_duration.values["p(95)"]' .load-artifacts/k6-summary-01-smoke.json
```

Expected: `rate` < 0.01, `p(95)` < some sane number (< 2000 ms). Any wildly out-of-band number here means DEV itself is unhealthy — stop and investigate.

- [ ] **Step 7: Commit (artifact metadata only)**

Nothing to commit — `.load-artifacts/` is ignored. Skip.

---

### Task 4: Dispatch tutorials-cold + tutorials-hot

**Files:**
- Create: `.load-artifacts/before-tutorials-cold.json`, `.load-artifacts/after-tutorials-cold.json`, `.load-artifacts/before-tutorials-hot.json`, `.load-artifacts/after-tutorials-hot.json`, `.load-artifacts/tutorials-cold-run-id.txt`, `.load-artifacts/tutorials-hot-run-id.txt`, `.load-artifacts/k6-summary-04-tutorial-serve.json` (once per mode, saved under `-cold` / `-hot` suffixed names — see Step 3 workaround).

**Interfaces:**
- Consumes: same as Task 3.
- Produces: two k6 summaries + four `/admin/metrics/live` captures. Both runs green (or documented follow-up).

⚠️ The workflow doesn't expose `LOAD_MODE` as a dispatch input. The workflow's `run` step hardcodes the env for the whole job. We dispatch twice — the workflow defaults `MODE` to `cold` (see `test/load/config.js:30`). To force `hot` we need a workaround. Read Step 2 carefully before dispatching.

- [ ] **Step 1: Capture before-cold snapshot**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/before-tutorials-cold.json
```

- [ ] **Step 2: Dispatch tutorials (cold — default)**

The workflow's k6 invocation does not pass `LOAD_MODE`, so the config falls back to `cold` (`test/load/config.js:30`, `MODE = envOr('LOAD_MODE', 'cold')`). Cold is what we want for the first run.

```bash
gh workflow run load-test.yml -f scenario=tutorials --repo sap-tutorials/tutorials-ims
sleep 5
gh run list --workflow=load-test.yml --limit 1 --repo sap-tutorials/tutorials-ims
```

```bash
export RUN_ID=<new-run-id>
echo "$RUN_ID" > .load-artifacts/tutorials-cold-run-id.txt
gh run watch "$RUN_ID" --repo sap-tutorials/tutorials-ims
```

Expected: `success`. If `failure` due to `p95 < 500ms` violation, that's still useful data — proceed but note it. If `failure` due to `http_req_failed` rate: STOP.

- [ ] **Step 3: Capture after-cold snapshot + summary**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/after-tutorials-cold.json
gh run download "$RUN_ID" -n k6-summaries -D .load-artifacts/ --repo sap-tutorials/tutorials-ims
# The artifact name is always k6-summary-04-tutorial-serve.json; rename so
# hot doesn't overwrite it.
mv .load-artifacts/k6-summary-04-tutorial-serve.json .load-artifacts/k6-summary-04-tutorial-serve-cold.json
```

- [ ] **Step 4: Warm-up bridge**

Since we cannot force `LOAD_MODE=hot` through the workflow, we approximate hot mode by running `tutorials` a second time back-to-back — the first run's fetched slugs will be LRU-resident for the second. `hot` mode in the scenario picks 10 fixed slugs; the second dispatch's cold-mode random slugs overlap heavily with the first's 50-VU × 3-min traffic, so the cache-hit ratio should climb noticeably in the second run.

**Alternative if you want true `hot`:** invoke k6 directly against DEV from your workstation with `LOAD_MODE=hot npm run loadtest:tutorials` and skip Step 5's `gh workflow run`. Document in the log which method you used.

For this plan we assume the two-back-to-back-dispatch approach. If you take the alternative, document it in the log (Task 7 template's "Notes" column).

- [ ] **Step 5: Capture before-hot snapshot**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/before-tutorials-hot.json
```

- [ ] **Step 6: Dispatch tutorials again (approximates hot)**

```bash
gh workflow run load-test.yml -f scenario=tutorials --repo sap-tutorials/tutorials-ims
sleep 5
gh run list --workflow=load-test.yml --limit 1 --repo sap-tutorials/tutorials-ims
export RUN_ID=<new-run-id>
echo "$RUN_ID" > .load-artifacts/tutorials-hot-run-id.txt
gh run watch "$RUN_ID" --repo sap-tutorials/tutorials-ims
```

- [ ] **Step 7: Capture after-hot snapshot + rename summary**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/after-tutorials-hot.json
gh run download "$RUN_ID" -n k6-summaries -D .load-artifacts/ --repo sap-tutorials/tutorials-ims
mv .load-artifacts/k6-summary-04-tutorial-serve.json .load-artifacts/k6-summary-04-tutorial-serve-hot.json
```

- [ ] **Step 8: Compute cache-hit ratio delta**

```bash
diff_counter() {
  local key="$1"
  local before after
  before=$(jq -r ".snapshot.counters.\"$key\" // 0" ".load-artifacts/before-tutorials-cold.json")
  after=$(jq -r ".snapshot.counters.\"$key\" // 0" ".load-artifacts/after-tutorials-hot.json")
  echo "$key: $before -> $after (delta $((after - before)))"
}

diff_counter content.cache.hit
diff_counter content.cache.miss
diff_counter render.cache.hit
diff_counter render.cache.miss
diff_counter cache.evict
```

Expected: the `content.cache.hit` delta grows across both runs; `content.cache.miss` delta is largely bounded by the number of unique slugs served (< tutorialSlugs.length in `fetchSlugs` output). `cache.evict` delta should be low unless we blew past the 50 MB LRU cap.

Note the numbers — they go into Task 7's log.

- [ ] **Step 9: Commit (still nothing — artifacts ignored)**

Skip.

---

### Task 5: Dispatch baseline (twice) + ws

**Files:**
- Create: `.load-artifacts/before-baseline-1.json`, `.load-artifacts/after-baseline-1.json`, `.load-artifacts/k6-summary-02-public-baseline-1.json`, `-baseline-2.json` counterparts, `.load-artifacts/before-ws.json`, `.load-artifacts/after-ws.json`, `.load-artifacts/k6-summary-05-websocket-handshake.json`.

**Interfaces:**
- Consumes: same as Task 3.
- Produces: two baseline summaries (for `max(run1, run2)` p95), one ws summary, four `/admin/metrics/live` captures.

- [ ] **Step 1: Dispatch baseline #1**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/before-baseline-1.json
gh workflow run load-test.yml -f scenario=baseline --repo sap-tutorials/tutorials-ims
sleep 5
gh run list --workflow=load-test.yml --limit 1 --repo sap-tutorials/tutorials-ims
export RUN_ID=<new-run-id>
gh run watch "$RUN_ID" --repo sap-tutorials/tutorials-ims
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/after-baseline-1.json
gh run download "$RUN_ID" -n k6-summaries -D .load-artifacts/ --repo sap-tutorials/tutorials-ims
mv .load-artifacts/k6-summary-02-public-baseline.json .load-artifacts/k6-summary-02-public-baseline-1.json
echo "$RUN_ID" > .load-artifacts/baseline-1-run-id.txt
```

If the workflow reports `SKIP: publish in progress`: wait 5 min, re-run from the top of this Step.

- [ ] **Step 2: Wait ≥5 minutes**

```bash
sleep 330
```

(5.5 min — buys us a fresh 5-min metrics rollup window between the two samples.)

- [ ] **Step 3: Dispatch baseline #2**

Repeat Step 1 with `-baseline-2` suffixes.

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/before-baseline-2.json
gh workflow run load-test.yml -f scenario=baseline --repo sap-tutorials/tutorials-ims
sleep 5
gh run list --workflow=load-test.yml --limit 1 --repo sap-tutorials/tutorials-ims
export RUN_ID=<new-run-id>
gh run watch "$RUN_ID" --repo sap-tutorials/tutorials-ims
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/after-baseline-2.json
gh run download "$RUN_ID" -n k6-summaries -D .load-artifacts/ --repo sap-tutorials/tutorials-ims
mv .load-artifacts/k6-summary-02-public-baseline.json .load-artifacts/k6-summary-02-public-baseline-2.json
echo "$RUN_ID" > .load-artifacts/baseline-2-run-id.txt
```

- [ ] **Step 4: Dispatch ws (smoke-level)**

```bash
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/before-ws.json
gh workflow run load-test.yml -f scenario=ws --repo sap-tutorials/tutorials-ims
sleep 5
gh run list --workflow=load-test.yml --limit 1 --repo sap-tutorials/tutorials-ims
export RUN_ID=<new-run-id>
gh run watch "$RUN_ID" --repo sap-tutorials/tutorials-ims
curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > .load-artifacts/after-ws.json
gh run download "$RUN_ID" -n k6-summaries -D .load-artifacts/ --repo sap-tutorials/tutorials-ims
echo "$RUN_ID" > .load-artifacts/ws-run-id.txt
```

If ws fails on `ws_connecting{scenario:ws}` p95 or `ws_session_errors`: **do not block #807**. Open a follow-up issue with the run URL, referencing Row #4 of the scaling playbook, and continue.

- [ ] **Step 5: Sanity dump of the collected p95 numbers**

```bash
for f in .load-artifacts/k6-summary-*.json; do
  echo "=== $f ==="
  jq -r '.metrics | to_entries | map(select(.key | startswith("http_req_duration{endpoint:"))) | .[] | "\(.key): p95=\(.value.values["p(95)"] | tonumber | . * 100 | round / 100)ms"' "$f" | sort -u
done
```

Save the output somewhere accessible — Task 6 needs it.

---

### Task 6: Compute + apply tightened THRESHOLDS

**Files:**
- Modify: `test/load/config.js` (only the `THRESHOLDS` object)

**Interfaces:**
- Consumes: k6 summaries from Tasks 3–5.
- Produces: a diff on `test/load/config.js` where each `p(95)<X` value is either unchanged (`proposed >= current`) or tightened to the proposed value.

- [ ] **Step 1: Extract `observed_p95` per keyed endpoint**

For each of the keyed endpoints listed in `test/load/config.js` (`build-catalog`, `build-navigator`, `tutorial`, `advocates-list`, `advocates-photo`, plus scenario-tagged variants), compute:

```
observed_p95 = max(
  p95 from k6-summary-02-public-baseline-1.json,
  p95 from k6-summary-02-public-baseline-2.json
)
```

For the `scenario:ramp` entries: **skip** — we did not run ramp. Leave those thresholds untouched.

For `scenario:tutorial-serve,mode:hot` and `mode:cold`: take p95 from `k6-summary-04-tutorial-serve-hot.json` and `-cold.json` respectively.

For `scenario:ws` entries: from `k6-summary-05-websocket-handshake.json`.

Extraction helper (jq):

```bash
p95_for() {
  local file="$1"
  local key="$2"
  jq -r --arg k "$key" '.metrics[$k].values["p(95)"] // "missing"' "$file"
}

# Example
p95_for .load-artifacts/k6-summary-02-public-baseline-1.json 'http_req_duration{endpoint:build-catalog}'
p95_for .load-artifacts/k6-summary-02-public-baseline-2.json 'http_req_duration{endpoint:build-catalog}'
```

Record each `observed_p95` in a scratch note (not committed).

- [ ] **Step 2: Compute `proposed_ceiling` per key**

For each `observed_p95`:

```
proposed = max(1.5 * observed_p95, 100)
proposed_rounded = round(proposed / 50) * 50
```

Example: `observed_p95 = 87 ms` → `1.5 × 87 = 130.5` → `max(130.5, 100) = 130.5` → rounded to nearest 50 → **150 ms**.

Example: `observed_p95 = 240 ms` → `1.5 × 240 = 360` → rounded → **350 ms**.

- [ ] **Step 3: Apply the "never loosen" rule**

For each key, look up the current threshold in `test/load/config.js:35–62`. Compare:

- If `proposed_rounded < current`: use `proposed_rounded` — tighten.
- If `proposed_rounded >= current`: keep `current` — do not loosen.

Record which keys tightened and which stayed. This mapping goes into Task 7's log.

- [ ] **Step 4: Edit `test/load/config.js`**

Open `test/load/config.js`. Update each `THRESHOLDS` entry that changed. Do not touch:
- The threshold structure (keys, arrays, or the `envOr`/`envInt` helpers).
- The `scenario:ramp,*` entries (unmeasured).
- Anything outside the `THRESHOLDS` object.

Example change:

```javascript
// Before
  'http_req_duration{endpoint:build-catalog}': ['p(95)<500'],

// After (if observed_p95 was ~230 ms → proposed 350)
  'http_req_duration{endpoint:build-catalog}': ['p(95)<350'],
```

- [ ] **Step 5: Sanity-check the diff**

```bash
git diff test/load/config.js
```

Expected: only `THRESHOLDS` value strings changed. No structural changes. Every tightened key has `p(95)<X` where `X` is a multiple of 50 and `< old_X`.

- [ ] **Step 6: Re-dispatch baseline against tightened thresholds**

This is the make-or-break step. If a tightened threshold flags on this run, we backed off too little.

Push the current worktree branch temporarily so the workflow runs against it — **but** the workflow currently checks out `main`, not the branch. Since we edited `test/load/config.js` locally and it's not on `main` yet, the workflow can't see it.

Two options:

**Option A (recommended):** Dispatch `baseline` on `main` (unchanged config), and rely on the existing safe headroom. Trust the `1.5×` math. Do the *real* re-verification after the PR merges to `main` (Task 9 covers this).

**Option B:** Push the worktree branch and dispatch with `--ref worktree-807-scaling-baseline`:

```bash
git push -u origin worktree-807-scaling-baseline
gh workflow run load-test.yml --ref worktree-807-scaling-baseline -f scenario=baseline --repo sap-tutorials/tutorials-ims
```

Then wait, and if the run flags any of our tightened thresholds, back that specific threshold off by one step (50 ms) and re-run.

Pick Option A unless you have reason to distrust the `1.5×` math for a specific endpoint. Document the choice in Task 7's log.

- [ ] **Step 7: Commit thresholds**

```bash
git add test/load/config.js
git -c core.autocrlf=false commit -m "chore(#807): tighten k6 THRESHOLDS to 1.5x observed baseline p95

Tightened per-endpoint p(95) ceilings after the first live dispatch
against DEV. Formula: max(1.5 x observed_p95, 100), rounded to nearest
50 ms. Ramp entries untouched (ramp not run for this pass).

See docs/developers/architecture/scaling-playbook.md#validation-log
for the observed numbers and full mapping.

Refs #807"
```

---

### Task 7: Append validation log to scaling-playbook.md

**Files:**
- Modify: `docs/developers/architecture/scaling-playbook.md` — append new `## Validation log` section before the final `**Last updated:**` line; add "validated 2026-07-04" notes to Row #1 / #5 / #7 in the constraint table.

**Interfaces:**
- Consumes: numbers from Tasks 3–5, threshold decisions from Task 6.
- Produces: a completed validation log entry with real numbers (no placeholders) linking to the Actions runs.

- [ ] **Step 1: Read the current end of `scaling-playbook.md`**

The document ends with:

```markdown
**Last updated:** 2026-06-29 (#749 PR). When you crack off a row, update its status here and link to the implementing PR.
```

We insert a new `## Validation log` section **before** this line, and update it to `2026-07-04 (#807 baseline validation)`.

- [ ] **Step 2: Update table Row #1 status cell**

In the constraint table (around line 25), Row #1's "Fix path" cell currently reads:

```
**#749 (this PR)** — CF Autoscaler + `instances: 1..4`. XSUAA cookie-based, stateless.
```

Append `Validated 2026-07-04 at N=1 baseline traffic (#807).`:

```
**#749** — CF Autoscaler + `instances: 1..4`. XSUAA cookie-based, stateless. Validated 2026-07-04 at N=1 baseline traffic (#807).
```

- [ ] **Step 3: Update Row #5 and Row #7 status notes**

Row #5's "Effort" cell — append: ` Baseline-observed at N=1 (2026-07-04): content-store LRU sat at ~X MB, no evictions during 2-min baseline. See validation log.`

Row #7's "Fix path" cell — append: ` Baseline-observed at N=1 (2026-07-04): db.acquire.ms p95 = Xms, db.pool.timeout = 0 across 5 scenarios. See validation log.`

(Replace `X` with the numbers from the captured snapshots.)

- [ ] **Step 4: Append the Validation log section**

Insert this block **before** the `**Last updated:**` line. Fill in every `<value>` with the real number recorded in Tasks 3–5.

```markdown
## Validation log

### 2026-07-04 — Baseline pass under N=1 (Issue #807)

- **Actions runs:**
  - smoke: <run URL from .load-artifacts/smoke-run-id.txt>
  - tutorials cold: <URL from tutorials-cold-run-id.txt>
  - tutorials hot (approximation — see notes): <URL from tutorials-hot-run-id.txt>
  - baseline #1: <URL from baseline-1-run-id.txt>
  - baseline #2: <URL from baseline-2-run-id.txt>
  - ws: <URL from ws-run-id.txt>
- **Base URL:** https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com
- **k6 version:** 0.51.0
- **srv instances:** 1
- **approuter instances:** 1
- **`METRICS_DB_WRAP`:** true
- **Method:** two `baseline` dispatches ≥5 min apart; `observed_p95 = max(run1, run2)`. Cold-cache dispatch did NOT restart srv (LRU residual is expected — see notes column).

**k6 p95 (baseline scenario, worse of two runs) and threshold changes:**

| Endpoint | Observed p95 | Old threshold | New threshold | Rule applied |
|---|---|---|---|---|
| build-catalog | <ms> | 500 | <ms> | tightened / kept |
| build-navigator | <ms> | 500 | <ms> | … |
| tutorial | <ms> | 300 | <ms> | … |
| advocates-list | <ms> | 200 | <ms> | … |
| advocates-photo | <ms> | 300 | <ms> | … |

**Tutorial-serve cache mode:**

| Mode | p95 | hit-rate (from live-metrics delta) | Notes |
|---|---|---|---|
| cold | <ms> | <hit / (hit + miss) %> | LRU residual present (no restart). |
| hot (approx) | <ms> | <%> | Approximated by a second back-to-back `tutorials` dispatch — `LOAD_MODE=hot` cannot be forced through the workflow. |

**Cache metrics (from `/admin/metrics/live` deltas, cold-before → hot-after):**

- `content.cache.hit`: +<N>
- `content.cache.miss`: +<N>
- `render.cache.hit`: +<N>
- `render.cache.miss`: +<N>
- `cache.bytes` gauge (`before-tutorials-cold` → `after-tutorials-hot`): <X> → <Y> MB
- `cache.evict`: +<N> (target: 0 during the 6 min of tutorial traffic)

**DB pool metrics (from `/admin/metrics/live`, tutorials-cold window):**

- `db.acquire.ms.p95`: <ms>
- `db.pool.timeout`: <N> (target: 0)
- `db.tx.ms.p95`: <ms>
- `db.tx.run.ms.p95`: <ms>

**Playbook rows validated at N=1:**

- **Row #1 (AppRouter):** Held under baseline — auto-scaler config remains inert at 1..4.
- **Row #5 (in-memory caches):** 50 MB LRU on `content-store.js` sat at ~<X> MB across the 6 min of tutorial traffic. Headroom fine at N=1; projected ~<2X> MB at N=2 srv.
- **Row #7 (HANA pool):** p95 acquire = <X>ms with `db.pool.timeout = 0`. `@sap/hana-client` defaults are adequate at N=1 baseline traffic.

**Rows NOT exercised by this pass:**

- Row #4 (WebSocket) — only smoke-level (20-VU handshake churn). Result: <pass/fail — link>.
- Rows #2, #3, #6, #12–14 — not touched by baseline traffic; deferred until the traffic pattern that stresses each row is observed.

**Threshold PR:** <this PR's URL>. Post-merge re-dispatch confirmation: <run URL from Task 9>.

**Notes:**
- Cold-cache dispatch did not run `cf restart-app-instance` — the `hit/(hit+miss)` ratio during the scenario window is what's reported, not absolute counters relative to a clean state.
- Hot-cache dispatch used a second back-to-back `tutorials` run rather than `LOAD_MODE=hot`, since the workflow doesn't accept `LOAD_MODE` as an input. This is a slight overstatement of hot-path p95 (slugs still sample the full pool of tutorialSlugs, not just 10). Follow-up: expose `LOAD_MODE` as a workflow input if this becomes the primary validation cadence.
```

- [ ] **Step 5: Update the trailer line**

Change the last line from:

```
**Last updated:** 2026-06-29 (#749 PR). When you crack off a row, update its status here and link to the implementing PR.
```

to:

```
**Last updated:** 2026-07-04 (#807 baseline validation). When you crack off a row, update its status here and link to the implementing PR.
```

- [ ] **Step 6: Placeholder scan**

Search your edited section for any remaining `<...>`, `<ms>`, `<N>`, `<X>`, or `<URL>` markers:

```bash
grep -nE '<[a-zA-Z][^>]*>' docs/developers/architecture/scaling-playbook.md
```

Expected: zero matches. If any remain, fill them in — the log is not merge-ready until every placeholder is a real number or URL.

- [ ] **Step 7: Build the VitePress docs site locally**

```bash
npm run docs:build
```

Expected: exit 0. The `predocs:build` script (`check-docs-sidebar`) will fail if we accidentally break a link or add an unregistered page. We didn't add any pages here (spec/plan are under `superpowers/**` which is srcExcluded — `docs/.vitepress/config.ts:46`), so this should pass cleanly.

- [ ] **Step 8: Commit the log**

```bash
git add docs/developers/architecture/scaling-playbook.md
git -c core.autocrlf=false commit -m "docs(#807): scaling-playbook validation log for 2026-07-04 baseline pass

Records k6 p95, cache-hit deltas, and HANA pool metrics from the
DEV baseline dispatch. Marks Row #1 validated, adds observed-at-N=1
datapoints to Rows #5 and #7. Rows not exercised are called out
explicitly.

Refs #807"
```

---

### Task 8: Rotate the temporary tech-user + commit the plan

**Files:**
- Modify (via admin UI, no git): `tenantSettings.techUsers` — remove the `k6-807-<hex>` entry.
- Add to worktree: `docs/superpowers/plans/2026-07-03-807-scaling-baseline-validation.md` (this file).

**Interfaces:**
- Consumes: temp tech-user credentials from Task 2, this plan file.
- Produces: tech-user removed from runtime-config (verified 401), plan committed.

- [ ] **Step 1: Verify the tech-user is no longer needed**

The threshold PR and log are committed. Every remaining task (open PR, wait for review) needs no `/admin/metrics/live` access. Safe to rotate.

- [ ] **Step 2: Open the admin UI tenant settings**

`https://…/admin-ui/#tenant-display`. Locate the `k6-807-<hex>:...:Admin` entry in the `techUsers` field.

- [ ] **Step 3: Remove the entry**

Delete that entry (and the trailing `;` if it's the last one; or the leading `;` if there are entries after). **Do not touch other entries** — one keystroke error here breaks legitimate tech-user auth. Save.

- [ ] **Step 4: Verify 401**

```bash
curl -su "$ADMIN_BASIC_AUTH" -w '\nHTTP %{http_code}\n' "$SRV_URL/admin/metrics/live" | tail -2
```

Expected: `HTTP 401` or `403` (depending on whether `basicAuthMiddleware` even matches the username now). If HTTP 200: the rotation didn't take effect — the resolver may cache for up to 60 s. Wait 90 s and retry. If it stays 200: STOP. Investigate manually before continuing.

- [ ] **Step 5: Unset the env var locally**

```bash
unset ADMIN_BASIC_AUTH
```

- [ ] **Step 6: Add this plan file to the worktree**

The spec was committed in the brainstorming phase (commit `79c2d8c2`). This plan file lives at `docs/superpowers/plans/2026-07-03-807-scaling-baseline-validation.md` — the same file you are reading now.

```bash
git add docs/superpowers/plans/2026-07-03-807-scaling-baseline-validation.md
git -c core.autocrlf=false commit -m "docs(#807): implementation plan for scaling-playbook baseline pass

Detailed task-by-task plan derived from the approved spec at
docs/superpowers/specs/2026-07-03-807-scaling-baseline-validation-design.md.

Refs #807"
```

---

### Task 9: Open draft PR + post-merge re-dispatch

**Files:**
- No files edited. GitHub PR operation + one more workflow dispatch.

**Interfaces:**
- Consumes: three commits on `worktree-807-scaling-baseline` (spec 79c2d8c2 + gitignore + threshold + validation-log + plan).
- Produces: A draft PR ready for review. After merge, a re-dispatch of `baseline` against the tightened thresholds confirms green — recorded as a PR comment.

- [ ] **Step 1: Verify branch state before push**

```bash
git branch --show-current
git log --oneline main..HEAD
```

Expected: branch is `worktree-807-scaling-baseline`. Log shows commits (order may vary):
1. `docs(#807): scaling-playbook baseline validation spec` (from brainstorming)
2. `chore(#807): gitignore .load-artifacts/ scratch dir`
3. `chore(#807): tighten k6 THRESHOLDS to 1.5x observed baseline p95`
4. `docs(#807): scaling-playbook validation log for 2026-07-04 baseline pass`
5. `docs(#807): implementation plan for scaling-playbook baseline pass`

If commits are missing: STOP and reconstruct.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin worktree-807-scaling-baseline
```

- [ ] **Step 3: Open the draft PR**

```bash
gh pr create --draft \
  --title "chore(#807): scaling-playbook baseline validation + tightened k6 thresholds" \
  --body "Closes #807.

## What changed

Executes the baseline validation pass PR #965 (issue #804) left open: dispatched k6 against DEV, correlated p95 with /admin/metrics/live cache + pool metrics, tightened test/load/config.js THRESHOLDS to max(1.5 × observed_p95, 100 ms) rounded to nearest 50 ms (never loosened), appended a Validation log section to docs/developers/architecture/scaling-playbook.md.

### Files

- \`test/load/config.js\` — tightened THRESHOLDS (per-endpoint deltas listed in the log).
- \`docs/developers/architecture/scaling-playbook.md\` — new \`## Validation log\` section; Row #1 marked validated; Row #5 / #7 have observed-at-N=1 datapoints.
- \`.gitignore\` — adds \`.load-artifacts/\` scratch dir.
- \`docs/superpowers/specs/2026-07-03-807-scaling-baseline-validation-design.md\` — approved spec.
- \`docs/superpowers/plans/2026-07-03-807-scaling-baseline-validation.md\` — implementation plan.

### Zero product-source changes

Nothing under \`srv/\`, \`hugo/\`, \`hugo-apps/\`, \`app/\`, \`db/\`, \`scripts/\`, or \`approuter/\` changed. The k6 config is inert until dispatched.

## Verification

- \`npm run docs:build\` — passes (sidebar guard green).
- \`npm test\` — passes (no unit surface affected).
- Live dispatches on DEV — see the Validation log for run URLs.

## Post-merge

After merge, one more \`gh workflow run load-test.yml -f scenario=baseline\` on \`main\` confirms the tightened thresholds stay green. Result linked as a PR comment. If the re-dispatch flags any tightened threshold, that specific threshold is backed off by 50 ms in a follow-up PR — do NOT loosen wholesale.

## Rollback

Single-file revert on \`test/load/config.js\`. k6 config is inert.
" \
  --base main --head worktree-807-scaling-baseline --repo sap-tutorials/tutorials-ims
```

Note the PR URL.

- [ ] **Step 4: Request review**

Per session guidance ("PR over direct merge — Default to `gh pr create` from a feature branch; subagent code review is not a substitute for PR review"): DO NOT self-merge. Wait for human review.

- [ ] **Step 5: After merge, re-dispatch baseline on `main`**

Once the PR is squashed to `main`:

```bash
gh workflow run load-test.yml --ref main -f scenario=baseline --repo sap-tutorials/tutorials-ims
sleep 5
gh run list --workflow=load-test.yml --limit 1 --repo sap-tutorials/tutorials-ims
export RUN_ID=<new-run-id>
gh run watch "$RUN_ID" --repo sap-tutorials/tutorials-ims
```

- [ ] **Step 6: Comment on the merged PR**

```bash
gh pr comment <PR-number> --repo sap-tutorials/tutorials-ims \
  --body "Post-merge re-dispatch: <run URL> — <status>. Weekly cron unchanged (Monday 03:00 UTC)."
```

- [ ] **Step 7: If green, close #807**

```bash
gh issue close 807 --repo sap-tutorials/tutorials-ims \
  --comment "Baseline validation completed 2026-07-04. Thresholds tightened, playbook log appended. See PR <URL>."
```

If red on a tightened threshold: back that specific threshold off by 50 ms in a small follow-up PR. Do not re-open #807; it stays closed. The follow-up PR references #807 in its body.

---

## Self-review

- **Spec coverage:**
  - Spec §2 (Scope) → Tasks 3, 4, 5 cover the six scenarios; Task 4 explicitly documents the LOAD_MODE workaround; Task 5 covers the two-baseline-runs rule; Tasks 6, 7 cover the threshold + log deliverables.
  - Spec §3 (Success criteria) → Task 9 gates on all four.
  - Spec §4 (Method) → Tasks 1 (prereqs), 2 (auth), 3–5 (dispatch), 6 (threshold math), 7 (log).
  - Spec §5 (Risks) → Task 1 Step 5 (rebuild-content), Task 5 Step 1 (skip-guard handling), Task 8 (rotation), Task 6 Step 6 (Option A/B for verifying tightened thresholds).
  - Spec §6 (Testing) → Task 7 Step 7 runs docs:build; Task 9 Step 5 covers post-merge re-dispatch.
  - Spec §7 (Rollback) → Task 8 rotation + Task 9's "single-file revert" language in PR body.
  - Spec §8 (Follow-ups) → Task 5 ws-fail handling, Task 9 threshold-flap handling.
- **Placeholders:** All `<...>` markers in Task 7's log block are marked "fill with real numbers"; Task 7 Step 6 gates on `grep -nE '<[a-zA-Z][^>]*>'` returning zero. No `TBD` / `TODO` in the plan itself.
- **Type consistency:** File paths in Interfaces blocks match Files blocks. `ADMIN_BASIC_AUTH` env var name consistent across Tasks 2–5, 8. `SRV_URL` derivation matches `test/load/config.js:22–28`.
- **Fresh-eyes fix applied:** Task 6 Step 6 was originally "push branch and re-run workflow against branch." Rewritten to give the executor an explicit Option A / Option B call, defaulting to A, because the workflow's `checkout` currently pins to `main` unless `--ref` is passed.
