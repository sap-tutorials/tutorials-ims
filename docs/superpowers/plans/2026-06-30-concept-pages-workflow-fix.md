# Concept Pages Workflow Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one step to `.github/workflows/rebuild-content.yml` invoking `npm run fetch-concepts` on `full` + `catalog-only` rebuilds, then validate via a manual post-merge workflow run that picks up today's 10 smoke-published concepts and renders them live at `/concepts/<slug>/`.

**Architecture:** One YAML step, one file, ~9 lines. Everything else (classifier, kg.after hook, Hugo layout, publish-content concept support, AppRouter routing, CAP serve handler) was already shipped in #685 — the workflow YAML is the last gap. Position the new step right after `fetch-advocates` since both are catalog-scale fetches from the deployed CAP backend. Validate by triggering the workflow manually post-merge with `mode=catalog-only`; success criterion is `/concepts/sap-btp-cockpit/` returning 200.

**Tech Stack:** GitHub Actions workflow YAML; `gh` CLI for triggering + watching the run; `curl` for smoke verification.

**Spec:** [docs/superpowers/specs/2026-06-30-concept-pages-workflow-fix-design.md](../specs/2026-06-30-concept-pages-workflow-fix-design.md). **Worktree:** `D:\projects\tutorials-poc\.claude\worktrees\concept-pages-workflow-fix` on branch `concept-pages-workflow-fix` (spec already committed in 2 commits).

---

## Prerequisites — read these before starting

1. **Spec document** referenced above. Re-read the "Workflow YAML change" section before writing the diff.
2. **The workflow file:** `.github/workflows/rebuild-content.yml` — large file (~400 lines). Don't restructure; only insert the one new step.
3. **The canonical pattern this mirrors:** the existing `Fetch advocates` step at lines 254-258. Same shape (name + run + env), with one addition: an `if:` guard skipping on `slug-targeted` mode.
4. **Why no test files:** workflow YAML changes don't have unit-testable surfaces. Validation is the manual workflow run post-merge.
5. **Project CLAUDE.md** at `D:/projects/tutorials-poc/CLAUDE.md` — confirms the `gh workflow run rebuild-content.yml` pattern as canonical for manual rebuilds.

---

## File structure (locked at plan time)

**Modify:**
- `.github/workflows/rebuild-content.yml` — insert one new step (~9 lines including comment) between the `Fetch advocates` step (line ~258) and the `Lint tutorial markdown` step (line ~270).

**No other files changed in this PR.**

**Operational temp files (post-merge, NOT committed):**
- None. The manual workflow trigger uses `gh` CLI directly; the smoke-verify uses `curl`. No temp scripts.

---

## Task 1 — Insert the `Fetch published concepts` workflow step

Single-file YAML edit. The change is strictly additive — no existing logic modified.

**Files:**
- Modify: `.github/workflows/rebuild-content.yml` (insert after line 258, the closing of the `Fetch advocates` step's env block)

- [ ] **Step 1: Confirm the insertion point**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/concept-pages-workflow-fix
grep -nE "name: Fetch advocates|name: Lint tutorial markdown" .github/workflows/rebuild-content.yml
```

Expected output:
```
254:      - name: Fetch advocates
264:      - name: Lint tutorial markdown
```

The `Fetch advocates` step runs from line 254 through line 257 (`CAP_BASE_URL: ...`). Line 258 is a blank separator. Lines 259-263 are the comment block for `Lint tutorial markdown`. The new step goes between line 257 (end of `Fetch advocates`'s `env:` block) and line 258 — i.e., the new step's leading blank line REPLACES the existing blank-line separator at 258, and the existing comment block stays at 259+ but shifts down.

- [ ] **Step 2: Read the existing fetch-advocates step shape (to mirror it correctly)**

```bash
sed -n '248,260p' .github/workflows/rebuild-content.yml
```

Expected: see the step structure `- name: Fetch advocates`, then `run:`, then `env: CAP_BASE_URL:`. The new step uses the same shape PLUS an `if:` guard.

- [ ] **Step 3: Apply the insertion**

Locate this block in the file (around lines 248-258):

```yaml
      # [#601] Generate per-advocate profile-page markdown into
      # hugo/content/developer-advocates/ from /api/advocates. Runs on ALL
      # modes (including catalog-only) so admin Advocates/AdvocateTopics/
      # AdvocateLinks saves regenerate the per-advocate pages within the
      # same rebuild cycle. fetch-advocates.ts is idempotent and bounded
      # by the advocate count (catalog scale, not tutorial scale).
      - name: Fetch advocates
        run: npm run fetch-advocates
        env:
          CAP_BASE_URL: ${{ steps.srv.outputs.srv_url }}
```

Immediately AFTER it (between the closing of `env:` for `Fetch advocates` and the next comment block), insert this new step:

```yaml

      # [Phase 3-A] Fetch published-concept payload from CAP and write
      # one hugo/content/concepts/<slug>.md per published concept. Runs on
      # `full` and `catalog-only`; skipped on `slug-targeted` (a single-tutorial
      # rebuild does not need concept landing-page regeneration). The Hugo
      # build picks up the new .md files in the subsequent build step.
      # All other Phase 3-A wiring (classifier, kg.after hook, Hugo layout,
      # publish-content concept support, AppRouter route, CAP serve handler)
      # shipped in #685 — only this workflow invocation was missing.
      - name: Fetch published concepts
        if: ${{ steps.mode.outputs.effective_mode != 'slug-targeted' }}
        run: npm run fetch-concepts
        env:
          CAP_BASE_URL: ${{ steps.srv.outputs.srv_url }}
```

**Implementation notes:**
- The `if:` expression uses the same pattern as line 203 of the workflow (`if: ${{ steps.mode.outputs.effective_mode != 'catalog-only' }}`). Inverted condition for our case.
- The `env: CAP_BASE_URL: ${{ steps.srv.outputs.srv_url }}` expression is verbatim from the fetch-advocates step at line 258, the validate-tutorials step at line 230, and the publish-content step at line 317. Established pattern.
- One blank line BEFORE the new step (separating it from `Fetch advocates`). No blank line between the new step and the next comment block — match the existing density.

- [ ] **Step 4: Verify the YAML parses (LOCAL file, not the remote fetched copy)**

**Important:** `gh workflow view rebuild-content.yml --yaml` fetches the YAML from the GitHub remote, NOT the local edited copy. It cannot catch local indentation errors. Use the local YAML parser instead.

Try Python first (almost always available on Windows + macOS + Linux):

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/rebuild-content.yml'))" && echo "valid"
```

If Python isn't on PATH, fall back to Node + js-yaml (already a transitive dependency):

```bash
node -e "const yaml = require('js-yaml'); const fs = require('fs'); try { yaml.load(fs.readFileSync('.github/workflows/rebuild-content.yml', 'utf8')); console.log('valid'); } catch (e) { console.error('INVALID:', e.message); process.exit(1); }"
```

Either command should output `valid`. If neither does, recheck indentation — YAML is 6-space-indent-sensitive at the step level.

- [ ] **Step 5: Confirm the diff scope**

```bash
git diff --stat .github/workflows/rebuild-content.yml
```

Expected: `1 file changed, 11 insertions(+)` — give or take 1 line (depends on whether the existing trailing newline was preserved). Should NOT show any deletions. If `git diff` shows deletions, you accidentally modified existing lines — revert and try again.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/rebuild-content.yml
git commit -m "feat(kg): wire fetch-concepts into rebuild-content workflow

Closes the last gap in the Phase 3-A concept-pages pipeline. The
classifier (srv/lib/_classify-rebuild-mode.js), kg.after hook
(srv/server.js), Hugo layout (hugo/layouts/concepts/), publish-content
concept support (scripts/publish-content.ts), and AppRouter routing
all shipped in #685 — only the workflow YAML was missing this
single fetch-concepts invocation.

After merge, manual 'gh workflow run rebuild-content.yml
-f mode=catalog-only' picks up the 10 smoke-published concepts and
renders them live at /concepts/<slug>/. Future admin Publish clicks
auto-trigger the same workflow via existing rebuild-trigger.js wiring.

Position rationale: grouped with Fetch advocates (line 254) since both
are catalog-scale fetches from the deployed CAP backend. Skipped on
slug-targeted mode (single-tutorial hotfixes don't need concept
landing-page regeneration); runs on full + catalog-only.

Env rationale: CAP_BASE_URL set via steps.srv.outputs.srv_url, matching
the established pattern at lines 230, 257, 317 of this same workflow."
```

---

## Task 2 — Push branch + open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin concept-pages-workflow-fix 2>&1 | tail -5
```

Expected: branch created on remote, PR creation URL printed.

- [ ] **Step 2: Write the PR body**

Save to `D:/projects/tutorials-poc/.claude/worktrees/concept-pages-workflow-fix/PR_BODY.md`:

```markdown
## What

Adds one step to `.github/workflows/rebuild-content.yml` invoking `npm run fetch-concepts` on `full` + `catalog-only` rebuilds. Strictly additive — 9 lines, one file.

## Why

Phase 3-A's concept-pages pipeline was 95% shipped in [#685](https://github.com/sap-tutorials/tutorials-ims/pull/685):

- Classifier knows about `Concepts` CRUD + `publishConcept`/`unpublishConcept` actions — maps to `catalog-only` rebuild mode.
- `kg.after` hook in [srv/server.js:764-777](srv/server.js#L764-L777) fires the rebuild trigger on those actions.
- Hugo layout at [hugo/layouts/concepts/single.html](hugo/layouts/concepts/single.html) (519 lines) renders the page.
- [scripts/publish-content.ts:92-130](scripts/publish-content.ts#L92) walks `hugo/public/concepts/<slug>/` and publishes with `concept-<slug>` keys.
- AppRouter route `/concepts/(.*)$` → CAP handler at [srv/server.js:303](srv/server.js#L303) → `serveHandler` reads HANA `ContentFiles WHERE slug='concept-<slug>'`.

But the workflow itself never called `npm run fetch-concepts`. So admin Publish clicks correctly fired the rebuild trigger → workflow ran → workflow generated zero `.md` files for concept pages → no concept HTML reached HANA.

## Spec

[docs/superpowers/specs/2026-06-30-concept-pages-workflow-fix-design.md](docs/superpowers/specs/2026-06-30-concept-pages-workflow-fix-design.md). Brainstormed, spec-reviewed, and user-approved in this session.

## Position rationale

The new step sits between `Fetch advocates` (line 254) and `Lint tutorial markdown` (line 266). Both `Fetch advocates` and `Fetch published concepts` are catalog-scale fetches from the deployed CAP backend; grouping them is the canonical pattern.

## Verification (post-merge)

```bash
# 1. Manual workflow trigger
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main -f mode=catalog-only

# 2. Watch the new step succeed
gh run watch
# Expected: '[fetch-concepts] 10 published concept(s) — writing pages'

# 3. Confirm a representative page is live
curl -s -o /dev/null -w '%{http_code}\n' https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/concepts/sap-btp-cockpit/
# Expected: 200
```

## What's NOT in this PR

- Phase 3-A-3 (sidebar concept-link flip from `<span>` to `<a>`, `SearchService` indexing) — separate scope.
- A `concepts-only` workflow mode — rejected in brainstorming as over-engineering. `catalog-only` is the right shape.
- Smoke / hybrid tests for concept pages — Phase 3-A test track, separate PR.

No issue number to close; this is the operational glue between #685 (Phase 3-A code) and the production rebuild pipeline.
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main \
  --title "feat(kg): wire fetch-concepts into rebuild-content workflow" \
  --body-file D:/projects/tutorials-poc/.claude/worktrees/concept-pages-workflow-fix/PR_BODY.md
rm D:/projects/tutorials-poc/.claude/worktrees/concept-pages-workflow-fix/PR_BODY.md
```

Expected: PR URL printed. The PR body file is deleted immediately — same pattern as recent PRs.

- [ ] **Step 4: Wait for review + merge.**

PR review should be fast — single-file workflow change, no logic touched. The CI staging check (`scripts/check-cds-build-staging.ts`) will run since `.github/workflows/` is a path-trigger, but won't find any CDS changes; it should pass.

---

# Operational tasks — post-merge

These run from the primary tree (`D:/projects/tutorials-poc`, on `main`) AFTER the PR merges. NOT part of the PR.

## Task 3 — Manual workflow trigger + watch

The validation that proves the workflow change works.

- [ ] **Step 1: Sync primary tree to latest main**

```bash
cd D:/projects/tutorials-poc
git checkout main
git pull --ff-only
git log -1 --oneline
```

Expected: the latest commit is the merge of this PR. Confirm by reading the commit message — should contain `feat(kg): wire fetch-concepts into rebuild-content workflow`.

- [ ] **Step 2: Trigger the workflow with `catalog-only` mode**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main -f mode=catalog-only
```

Expected: no output (or a single newline). The trigger is fire-and-forget; success means the workflow_dispatch event was accepted.

- [ ] **Step 3: Get the run ID and watch**

```bash
sleep 5  # let GitHub register the run
gh run list --workflow rebuild-content.yml --limit 1
```

Expected: one row showing the workflow status (`queued` or `in_progress`). Copy the run ID from the second column.

```bash
gh run watch <run-id>
```

Expected: live progress output. The workflow completes in ~1-2 minutes for `catalog-only` mode (CLAUDE.md cites ~1 min for catalog-only).

If `gh run watch` is unavailable or hangs:

```bash
# Poll instead
while true; do
  status=$(gh run view <run-id> --json status,conclusion | jq -r '.status + " / " + (.conclusion // "pending")')
  echo "$(date +%T) $status"
  if [[ "$status" == "completed"* ]]; then break; fi
  sleep 15
done
```

- [ ] **Step 4: Confirm the new `Fetch published concepts` step succeeded**

```bash
gh run view <run-id> --log | grep -A 3 "Fetch published concepts"
```

Expected output should include:
```
[fetch-concepts] GET https://...cfapps.eu10-005.hana.ondemand.com/build/concepts
[fetch-concepts] 10 published concept(s) — writing pages
[fetch-concepts] wrote 10 page(s) + _index.md to ...
```

If the count is anything other than 10, STOP and verify:
- `curl /build/concepts | node -e "..."` should return exactly 10 entries
- If `/build/concepts` returns 200 with 10 entries but the workflow saw 0 or a different count, there's an env / network gap — investigate before continuing

- [ ] **Step 5: Confirm publish-content uploaded 10 concept slugs**

```bash
gh run view <run-id> --log | grep -E "publish-content|concept-" | head -20
```

Expected: log lines showing publish-content sessions, with at least 10 entries containing `concept-` prefixed slugs (e.g., `concept-sap-btp-cockpit`).

---

## Task 4 — Smoke verify concept pages are live

- [ ] **Step 1: Confirm a representative concept page is reachable**

```bash
curl -s -o /dev/null -w 'status: %{http_code}\n' \
  https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/concepts/sap-btp-cockpit/
```

Expected: `status: 200`.

If 404, the most likely causes are:
- The slug `sap-btp-cockpit` doesn't match what's in DB. Check with `curl https://.../build/concepts | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).concepts.map(c=>c.slug)))"` and use a real slug from the output.
- The workflow's publish-content step didn't actually upload. Re-check the run logs (Task 3 Step 5).
- AppRouter routing isn't picking up the path. Verify with `curl /content/concepts/sap-btp-cockpit` on the srv directly.

- [ ] **Step 2: Confirm the HTML contains expected content**

```bash
curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/concepts/sap-btp-cockpit/ \
  | grep -c "SAP BTP Cockpit"
```

Expected: `≥1` (the concept name appears in the title and probably the breadcrumb).

- [ ] **Step 3: Visually spot-check 2-3 pages**

Get the list of published slugs:

```bash
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/concepts \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).concepts.map(c=>'/concepts/'+c.slug+'/').join('\n')))"
```

Pick 2-3 from the printed list. Open them in a browser. Confirm:
- The hero shows the concept name and (LLM-generated) description.
- The "Tutorials that teach this" section renders with at least one tutorial link.
- The breadcrumb back-link to `/concepts/` works (even if the index page is sparse).
- No 500 errors in the browser console.

- [ ] **Step 4: Sanity-check `/explore/about/` hero counter still reads `concepts: 10`**

```bash
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d); console.log('concepts:', o.concepts);})"
```

Expected: `concepts: 10`. Unchanged by this PR — but worth confirming the workflow didn't accidentally unpublish anything.

---

## Task 5 — Final confirmation + post-deploy notes

- [ ] **Step 1: No issue to auto-close**

This PR doesn't reference an issue number — it's operational glue for #685. The PR merge alone is the completion signal.

- [ ] **Step 2: Document any deviation from this plan**

If anything in this plan didn't match reality (e.g., a step output name differs, or a workflow line number drifted because another PR landed in between), commit a follow-up to update the spec and plan so future readers see what actually shipped.

- [ ] **Step 3: Done**

Future admin Publish/Unpublish clicks in `/admin-ui/#concepts-display` will now auto-trigger this workflow path. Concept pages land within ~1-2 minutes of the admin action (workflow run time). Larger publish batches (admins publishing 20, 50 concepts) all flow through the same pipeline with no manual workflow trigger needed.

---

# Cross-cutting notes

## Commit hygiene

- Verify branch before commit: `git branch --show-current` should print `concept-pages-workflow-fix`.
- `.claude/settings.local.json` drift is session noise — `git restore` it before commit if it shows.
- No CRLF concerns: workflow YAML doesn't have line-ending sensitivity that matters for runtime, but keep it LF for consistency. (`file .github/workflows/rebuild-content.yml` should report `ASCII text` with no `CRLF`.)

## Workflow guardrails

- The `if:` expression is `${{ steps.mode.outputs.effective_mode != 'slug-targeted' }}`. **Don't** invert this — `slug-targeted` skips, `full` and `catalog-only` run.
- The new step intentionally does NOT use `continue-on-error` or any error-suppression. If `/build/concepts` returns 500 (which it should NOT post-#787, but defense-in-depth) the workflow should fail-fast, not silently produce 0 pages.
- The CI staging check for CDS builds (`scripts/check-cds-build-staging.ts`) runs on PRs that touch `db/**/*.cds` or `srv/**/*.cds`. This PR doesn't touch those, but it DOES touch `.github/workflows/` — which IS in the staging check's path filter (per the `paths:` in `.github/workflows/cds-build-staging-check.yml` line 16-17). The check itself runs and passes-no-op (no cds source changed = no diff in db/last-dev/ or db/src/).

## Why no test files

- Workflow YAML changes don't have a unit-testable surface. The validation is "the workflow runs and the new step succeeds." That's a post-merge concern.
- Adding a smoke test (`test/smoke/concept-pages.smoke.test.js`) would be valuable but requires either hard-coding a published-concept slug (brittle) or making the test introspect `/build/concepts` to pick a slug at runtime. That's Phase 3-A's broader test track, not this PR's scope.
- The `gh workflow view ... --yaml` syntax check in Task 1 Step 4 is the closest thing to a pre-merge test.

---

# Out of scope — these are NOT this plan's job

- **Phase 3-A-3 features** (sidebar concept-link flip, SearchService indexing, telemetry events). Separate scope per the original Phase 3 spec.
- **Smoke/hybrid tests for concept pages.** Phase 3-A test track.
- **A backfill of more concept pages.** Today's 10 smoke-published concepts are the validation set. Admins can publish more via the UI organically.
- **Documentation updates to CLAUDE.md.** The CLAUDE.md doesn't currently mention concept pages; adding a section would be a separate doc-PR.
- **A more granular rebuild mode (`concepts-only`).** Rejected in brainstorming as over-engineering. `catalog-only` is the right shape.

---

# Acceptance checklist (before merging the PR)

- [ ] `python -c "import yaml; yaml.safe_load(open('.github/workflows/rebuild-content.yml'))" && echo "valid"` returns `valid` (validates the LOCAL file; `gh workflow view --yaml` does not)
- [ ] `git diff --stat .github/workflows/rebuild-content.yml` shows insertions only, no deletions
- [ ] Commit message includes `feat(kg):` prefix and references #685
- [ ] No `.claude/settings.local.json` drift in the commit list
- [ ] No CRLF in modified files

# Acceptance checklist (after manual workflow trigger)

- [ ] Workflow run completes with conclusion = `success`
- [ ] Run logs include `[fetch-concepts] 10 published concept(s) — writing pages`
- [ ] Run logs include 10 `concept-<slug>` entries in publish-content output
- [ ] `curl /concepts/sap-btp-cockpit/` returns 200 + HTML
- [ ] Browser spot-check on 2-3 pages renders correctly
- [ ] `/build/kg-stats` still reports `concepts: 10`
