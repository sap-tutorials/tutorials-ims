# Friday Todo — 2026-06-12

Your back-from-vacation worklist, ordered by what unblocks the most other work. Built 2026-06-08; refresh before starting if anything has shifted.

Sources: open GitHub issues + #275/#210 unchecked AC bullets + project memory + items the agent surfaced from PR #288 (merged but with deferred runtime tasks).

**Quick legend:** `cf` = needs `cf login` to DEV space first · `$$` = real LLM spend · ⏱ = hands-on time only, not wait time.

---

## P1 — Graduation gates (do these first; they unblock #275 and #210)

These are spike-graduation gates with explicit AC bullets in the live issues. Other work behind them stays blocked until these clear.

### 1. Run the AI-quiz pre-go-live smoke (#278 / #275 AC) `cf` `$$`

**Why first:** Closes the AC bullet I added to #275 in PR #288. Also surfaces any remaining AI-quiz pipeline bugs before you start hand-grading — better to find them now than to grade questions that came from a violated invariant.

```bash
cd D:/projects/tutorials-poc
cf login                             # if not already
git checkout main && git pull        # pick up the merged PR #288

# Cheap validation first (~$0.30, ~5 min)
npm run preflight:ai-quiz-smoke -- --sample 5 --seed 99
jq '{safeToGraduate, totals, failuresByInvariant}' verdicts/preflight-smoke.json

# If clean, run the full AC gate (~$8-14, ~30-60 min)
npm run preflight:ai-quiz-smoke -- --seed 278 2>&1 | tee verdicts/preflight-run.log
jq '{safeToGraduate, totals, failuresByInvariant}' verdicts/preflight-smoke.json
```

If `safeToGraduate: false` → triage failures, fix at source (likely `scripts/parsers/rules.ts`, `scripts/lib/expand-ai-authored.ts`, `srv/lib/ai-quiz-generator.js`), re-run with same seed. Runbook with full triage flow: [docs/developers/architecture/ai-authored-quizzes.md#pre-go-live-smoke-runbook](docs/developers/architecture/ai-authored-quizzes.md). ⏱ ~10 min hands-on.

When the 138-run is clean, post the artifact summary as a comment on #275 and check the smoke-pass bullet.

### 2. Hand-grade the 45 AI-quiz pilot rows (#275 main work)

**Why:** This is the actual quality decision — does the prompt produce shippable questions? Decides graduate/iterate/shelve for the AI-quiz spike.

```bash
# Find the CSV
ls ~/sap-tutorials-208-spike-pilot-artifacts/verdicts/pilot-final.csv
```

For each of the 45 rows, fill `authorWouldShip` with `yes` / `no` / `maybe` (lowercase only — the aggregator is case-sensitive). Optionally add `authorNotes`. Then:

```bash
npx tsx scripts/aggregate-ai-quiz-eval.ts ~/sap-tutorials-208-spike-pilot-artifacts/verdicts/pilot-final.csv
```

Apply the threshold table from #275:
- ≥75% overall AND MCQ ≥80% AND text ≥60% → graduate
- 50–74% → iterate (v2 prompt)
- <50% → shelve

Comment on #275 with the decision + rationale; open follow-up issues or close. ⏱ ~30 min focused review + ~5 min for the rate computation.

### 3. Run the AI code-check Phase 4 evaluation (#210)

**Why:** Sibling spike to #275 — same graduate/iterate/shelve gate, blocking the same kind of follow-up. Doing it after #275 is fine; the harnesses are independent.

Per #210's open AC bullets, this needs:
- Eval harness run against ≥3 pilot tutorial steps
- Author-rated agreement % computed
- Cost + latency telemetry pulled (Analytics Explorer)
- Graduate / iterate / shelve decision recorded with rationale
- Follow-up issues opened OR spike closed

The Phase 4 prep doc you merged in PR #287 should have the runbook. Start there: `docs/superpowers/specs/2026-06-03-codecheck-phase4-decision-template.md` (or wherever the prep doc landed). ⏱ ~1h end-to-end.

---

## P2 — Operational follow-ups for already-merged work

These are completions for features already in production but not fully validated or deployed.

### 4. /browse/ rollout — the GitHub PAT step (#174)

**Status per memory:** all three implementation PRs merged. Code is on main. What's left is operational:

- Deploy main to DEV (so `/browse/` lands on the deployed approuter + tutorials-srv)
- Visual smoke: pill on `/`, shellbar "Browse" item highlights on `/browse/`, filter/sort/search URL state survives reload
- **Generate a fine-grained PAT** (actions:write on sap-tutorials/tutorials-ims only, 90-day expiry) per [docs/developers/operations/github-dispatch-pat-rotation.md](docs/developers/operations/github-dispatch-pat-rotation.md)
- `cf set-env tutorials-srv GITHUB_DISPATCH_TOKEN <pat> && cf restart tutorials-srv`
- Verify: edit a Mission via admin UI → wait ~60s → Actions tab shows a `rebuild-content.yml` run with `trigger-source=admin-write`
- Repopulate DEV catalog if still showing 0 missions (separate from #174 — pre-existing)

⏱ ~45 min including waiting for restart + verify. Confirm deploy scope with yourself first per [[feedback_confirm_deploy_scope]].

### 5. Fix #251 Vite collision blocking #204 A/B metrics

**Per memory** ([project_204_deploy_flag_flipped.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_204_deploy_flag_flipped.md)): `tutorial.js` is emitted by both Vite (hugo-apps) and Hugo's `js.Build`, which silently clobbers Vite's output and breaks the `referred_view` event emission that #204's A/B instrumentation relies on. Without this fix, the 14-day A/B collection window for the /browse/ cutover decision is producing bad data.

Resolution: rename the Vite entry `tutorial` → `tutorial-referred` in `hugo-apps/vite.config.ts`. The `postbuild:apps` collision check (`tsx scripts/check-build-collisions.ts`) should validate. ⏱ ~20 min.

### 6. Review + merge open A/B PRs (#230, #231)

**Per memory** ([project_204_ab_instrumentation.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_204_ab_instrumentation.md)). I couldn't see them in the open-PR list (they may have already merged or been closed; verify before acting). If still open:

```bash
gh pr view 230 --repo sap-tutorials/tutorials-ims
gh pr view 231 --repo sap-tutorials/tutorials-ims
```

After both are merged + #251 is fixed, flip `UI_EVENTS_ENABLED` on DEV and start the 14-day A/B clock. ⏱ ~30 min review.

### 7. Personalized recommendations: hybrid test + visual review

**Per memory** ([project_personalized_recommendations.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_personalized_recommendations.md)): PR #35 merged 2026-05-23 but never had its hybrid HANA test run or visual confirmation on a logged-in session.

```bash
cf login
npm run test:hybrid -- test/hybrid/recommend-hana.test.js
# Then visit DEV /me/ on a logged-in session and look for the "what's next" rail
```

⏱ ~15 min.

### 8. Joule analytics integration (PR #148) — deploy + smoke

**Per memory** ([project_analytics_phase5_joule.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_analytics_phase5_joule.md)): Phase 5 merged but pending DEV deploy + post-deploy smoke + your visual review of the right-rail rendering.

Bundle this with task #4 (also a DEV deploy) to save a build cycle. ⏱ same deploy window; ~10 min extra for smoke.

---

## P3 — In your queue but not blocking anyone

### 9. Source markdown cleanup (#193) — 12 tutorials, 6 repos

The lint surfaces them; the cleanup is author-side PRs against the source repos. Coordination work, not coding work — assign to authors or do them yourself if you want a clean run. ⏱ unknown; multiple PRs.

### 10. Three open design issues without implementation yet

- **#201** Categories facet to /browse/ filter rail — design + implement
- **#173** AI-driven OS-conditional content (Mac vs Windows) — design phase
- **#172** AI-assisted optional/branching paths — design phase

These can wait. None blocks anything else.

### 11. AEM redirect tree access (#aem cutover gap)

**Per memory** ([project_aem_redirect_tree_access_blocked.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_aem_redirect_tree_access_blocked.md)): blocked on AEM admin team — you can't reach `/etc/redirect` via the Sites console. Action is just to ping the admin team for a CRX/DE export. ⏱ 5 min email.

### 12. AEM touchpoints audit ([project_aem_touchpoints_todo.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_aem_touchpoints_todo.md))

Post-cutover audit of all AEM integration points. Deferred until IMS is live. Don't start unless cutover is happening soon. ⏱ half-day when triggered.

### 13. TutorialMeta auto-init Task 7 ([project_tutorial_meta_auto_init.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_tutorial_meta_auto_init.md))

`feature/admin-analytics` ready, Task 7 (hybrid HANA test + DEV smoke) pending your deploy timing. Bundle with #4/#8 if convenient. ⏱ 20 min.

---

## Memory hygiene (do whenever)

The memory file index ([MEMORY.md](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/MEMORY.md)) is over its 24KB soft limit. Most of the bloat is one-line entries for `*_shipped.md` memories that are now historical context. Candidates for deletion (the work landed and the file no longer reflects pending action):

- project_171_ai_code_check_shipped.md
- project_208_ai_authored_quizzes_shipped.md
- project_209_freetext_grader_shipped.md
- project_210_codecheck_phase4_prep_shipped.md
- project_211_anonymize_cascade_shipped.md
- project_212_validation_widget_shipped.md
- project_cf_logs_url_shipped.md
- project_issue_174_browse_shipped.md
- project_issue_174_followup_cleanup_complete.md
- project_joule_step_help_shipped.md
- project_pip_styling_shipped.md
- project_qa_channel_shipped.md
- project_view_transitions_shipped.md

Delete them + remove their lines from `MEMORY.md`. ⏱ 10 min, reclaims ~5KB of session-load context every conversation.

---

## Done by the agent on 2026-06-08 (FYI, no action needed)

- ✅ PR #288 — preflight AI-quiz smoke (#278) implementation, runbook, #275 AC update — **merged** by you
- ✅ Worktree `.worktrees/278-preflight-smoke` removed (post-merge cleanup)

---

## How to use this list

1. Skim P1 first — those three items unblock the most. The smoke-and-grade combo (1+2) is half a day; #210 (3) is another hour.
2. Once the spikes have decisions, the P2 deploy bundle (#4/#7/#8 + maybe #13) is one trip to DEV — collapse them into one deploy window.
3. P3 is "free time" work. Skip if you have implementation in flight.
