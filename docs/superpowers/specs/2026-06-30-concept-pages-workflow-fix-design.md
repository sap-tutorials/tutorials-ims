# Wire `fetch-concepts` into rebuild-content workflow — Design Spec

- **Status:** Draft for review
- **Date:** 2026-06-30
- **Author:** Tom Jung (with Claude)
- **Predecessor specs:**
  - [`2026-06-27-446-knowledge-graph-phase3-design.md`](./2026-06-27-446-knowledge-graph-phase3-design.md) (Phase 3-A overall design)
- **Related:**
  - [#685](https://github.com/sap-tutorials/tutorials-ims/issues/685) (Phase 3-A-2 — fetch-concepts + Hugo layout + kg.after hook + classifier)
  - [#787](https://github.com/sap-tutorials/tutorials-ims/issues/787) (TutorialConceptLinks cascade fix that unblocked concept publishing)
  - [#751](https://github.com/sap-tutorials/tutorials-ims/issues/751) (KG overview page — consumer of `/build/kg-stats`'s concept counter)

## Summary

Add one step to `.github/workflows/rebuild-content.yml` so the workflow generates `/concepts/<slug>/` Hugo pages from CAP's published-concepts payload on `full` and `catalog-only` rebuilds. Closes the last gap in the Phase 3-A pipeline: classifier wiring (`Concepts` in `CATALOG_ONLY_ENTITIES`), `kg.after` hooks for `publishConcept`/`unpublishConcept`, Hugo layout (`hugo/layouts/concepts/single.html`), and publish-content concept support (`scripts/publish-content.ts:92-130`) all shipped in #685 — but the workflow YAML was never updated to invoke `npm run fetch-concepts`. Without that one step, admin Publish clicks fire the rebuild trigger correctly but the workflow generates zero `.md` files for Hugo to render.

After merge, one manual `gh workflow run rebuild-content.yml -f mode=catalog-only` invocation generates concept pages for today's 10 smoke-published concepts and validates the workflow change. Future admin Publish actions auto-trigger the same workflow via the existing `rebuild-trigger.js` wiring — no operator action needed.

## Goals

1. **Get today's 10 concept pages live at `/concepts/<slug>/`.** They're published in HANA (via yesterday's smoke-publish marker `smoke-787-2026-06-30`) but the Hugo build that emitted the page set ran BEFORE the publish, so the static + HANA-served pages never got generated.
2. **Close the workflow gap so admin-driven publishes auto-rebuild.** Future Publish/Unpublish clicks in `/admin-ui/#concepts-display` already fire the `kg.after` hook → debounced `rebuild-trigger.js` dispatch → `rebuild-content.yml`. With this PR the workflow actually generates concept pages on that fire.
3. **Keep the PR tight.** One file change. Everything else (classifier, hook, layout, publisher) is already wired in production.

## Non-Goals

- **A new `concepts-only` rebuild mode.** Rejected during brainstorming as over-engineering. `catalog-only` already gives us the right semantic ("admin made a non-tutorial-content change that requires a site rebuild"); `Concepts` is already in `CATALOG_ONLY_ENTITIES` per #685.
- **Classifier changes.** Already wired in #685; verified at [srv/lib/_classify-rebuild-mode.js:56](../../../srv/lib/_classify-rebuild-mode.js#L56).
- **`kg.after` hook for `publishConcept`/`unpublishConcept`.** Already wired in [srv/server.js:764-777](../../../srv/server.js#L764-L777).
- **Sidebar concept-link flip from `<span>` to `<a>` when a concept is published.** Phase 3-A-3 scope per the original spec; out of scope here.
- **`SearchService` indexing of published concepts.** Phase 3-A-3 scope; data hooks exist but indexer wiring is separate.
- **Smoke / hybrid tests for concept pages.** Phase 3-A's broader test track; not parasitically added to this workflow fix.
- **A backfill of more concept pages.** Today's 10 published concepts are the smoke set; subsequent batches happen organically as admins click Publish on more in the admin UI.

## Approach

### Workflow YAML change (one new step)

Insert one new step in [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml) between the existing `fetch-advocates` step (~line 255) and the `validate-tutorials` step (~line 287):

```yaml
      # [Phase 3-A] Fetch published-concept payload from CAP and write
      # one hugo/content/concepts/<slug>.md per published concept. Runs on
      # `full` and `catalog-only`; skipped on `slug-targeted` (a single-tutorial
      # rebuild does not need concept landing-page regeneration). The Hugo
      # build picks up the new .md files in the subsequent step.
      - name: Fetch published concepts → hugo/content/concepts/
        if: ${{ steps.mode.outputs.effective_mode != 'slug-targeted' }}
        env:
          CAP_BASE_URL: ${{ secrets.CAP_BASE_URL }}
        run: npm run fetch-concepts
```

**Position rationale:** Group with `fetch-advocates` — both fetch Hugo content from the deployed CAP backend (`/api/advocates` and `/build/concepts` respectively). Both run on `full` + `catalog-only`, both skipped on `slug-targeted`.

**`if:` rationale:** `slug-targeted` rebuilds are for one-tutorial hotfixes; they bypass catalog-rebuild paths entirely for wall-clock optimization. Concept landing pages are catalog-scale content, not slug-targeted content. Skipping on slug-targeted matches the pattern fetch-advocates already uses.

**Env rationale:** `fetch-concepts.ts` reads `CAP_BASE_URL` (defaults to `http://localhost:4004`). The workflow already has `CAP_BASE_URL` available as a repo secret (used by other steps like `validate-tutorials`). Step-level `env:` propagates it correctly.

### Why no other code changes

Everything else is pre-existing:

| Concern | Status |
|---|---|
| Classifier knows about `Concepts` entity CRUD | ✅ already wired ([_classify-rebuild-mode.js:56](../../../srv/lib/_classify-rebuild-mode.js#L56), #685) |
| Classifier knows about `publishConcept`/`unpublishConcept` actions | ✅ already wired (same file, #685) |
| Server-side `kg.after` hook fires on KG action writes | ✅ already wired ([srv/server.js:764-777](../../../srv/server.js#L764-L777), #685) |
| `publish-content.ts` walks `hugo/public/concepts/<slug>/` and publishes with `concept-<slug>` keys | ✅ already wired ([scripts/publish-content.ts:92-130, 735-738](../../../scripts/publish-content.ts#L92), #685) |
| Hugo layout for concept landing pages | ✅ already shipped (`hugo/layouts/concepts/{single,list}.html`, 519+120 lines, #685) |
| `fetch-concepts.ts` itself | ✅ already shipped (`scripts/fetch-concepts.ts`, 316 lines, #685) |
| AppRouter `/concepts/(.*)$` → CAP route | ✅ already wired (`approuter/xs-app.json`) |
| CAP handler `/content/concepts/:slug` → `serveHandler` with `concept-<slug>` prefix | ✅ already wired ([srv/server.js:303](../../../srv/server.js#L303)) |
| Workflow runs `fetch-concepts` step | ❌ **the gap this PR closes** |

### Why today's 10 concepts didn't auto-trigger a rebuild

The session's smoke-publish (#787 Task 9) wrote via `cds bind --exec` SQL UPDATE, bypassing the CAP service layer. That path doesn't fire CAP service-layer hooks — the `kg.after` hook only runs on OData writes through `KnowledgeGraphService.publishConcept`. For future admin-UI Publish clicks, the hook fires correctly. The bulk-SQL path was the anomaly.

Operational consequence for today: one manual `gh workflow run rebuild-content.yml -f mode=catalog-only` after merge picks up the 10 publishes from DB and renders the pages. This is also the validation run for the workflow change.

## Testing strategy

### Unit tests

None new. The classifier and hook are pre-existing; their tests live in `test/unit/_classify-rebuild-mode.test.js` and pass today.

### Workflow YAML validation (pre-merge)

Local syntax check:

```bash
gh workflow view .github/workflows/rebuild-content.yml --yaml > /dev/null && echo "valid"
```

### Manual workflow run (post-merge)

The real validation. Triggered after merge:

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main -f mode=catalog-only
gh run watch
```

Expected:
- New step `Fetch published concepts → hugo/content/concepts/` succeeds with output `[fetch-concepts] 10 published concept(s) — writing pages`.
- Hugo build picks up the 10 `.md` files; build emits `hugo/public/concepts/<slug>/index.html` × 10.
- `publish-content` step uploads with `concept-<slug>` keys; HANA `ContentFiles` table has 10 new rows.

### Smoke verification (post-workflow-run)

Not committed — one-shot operator commands:

```bash
# Confirm a representative page is reachable + content-typed
curl -s -o /dev/null -w '%{http_code}\n' \
  https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/concepts/sap-btp-cockpit/
# Expected: 200

# Confirm the HTML contains the expected concept name
curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/concepts/sap-btp-cockpit/ \
  | grep -c "SAP BTP Cockpit"
# Expected: ≥1
```

Spot-check 2-3 of the 10 slugs (from `SELECT slug FROM com_sap_developers_ims_Concepts WHERE publishedBy = 'smoke-787-2026-06-30'`) via the browser to confirm visual rendering looks right.

## Risks & rollback

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `CAP_BASE_URL` secret not actually available to this step | Med | Med | Repo secret is already used by other workflow steps (`validate-tutorials`, etc.). Step-level `env:` makes the dependency explicit. If somehow missing, `fetch-concepts.ts` falls back to `localhost:4004` and fails noisily with a 404 — easy to diagnose in one log line. |
| Hugo build fails on the new `concepts/<slug>.md` files (e.g., layout regression) | Low | Med | The layout `hugo/layouts/concepts/single.html` is shipped + tested by #685's hybrid tests. The per-concept template path is exercised at every Hugo build that finds matching content. If it fails, the workflow aborts cleanly and we iterate. |
| 10 concepts produce 10 `concept-<slug>` ContentFiles rows that collide with an existing slug | Low | Low | The `concept-` prefix is namespaced specifically to avoid tutorial-slug collisions (per [publish-content.ts:92-98](../../../scripts/publish-content.ts#L92) comments). No collision risk. |
| Workflow run conflicts with concurrent CI publish | Low | Low | `rebuild-content.yml` uses job-level concurrency control. Concurrent runs queue, don't conflict. |
| The `gh secret` named `CAP_BASE_URL` doesn't exist in the repo | Low | Med | Verified during plan-time exploration (other steps reference it). If absent, swap to a literal value in the workflow env block — DEV URL is non-sensitive. |

### Rollback

The workflow change is strictly additive — no existing logic modified. If the new step fails:

- The whole workflow run aborts. No partial state, no concept pages published. Tutorial publishes are unaffected because `catalog-only` mode skips `fetch-tutorials` entirely.
- `git revert` on `main` + redeploy — straightforward. Classifier + `kg.after` hook (already in production) continue working, just won't generate concept pages until the workflow is fixed.

No data state to roll back (concept publish/unpublish state in HANA is independent of the workflow's read behavior).

## Build sequence

**One PR.**

### PR: `feat(kg): wire fetch-concepts into rebuild-content workflow`

**Files changed (1):**

| File | Change |
|---|---|
| [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml) | +9 lines (one new step with `if:` guard and `env:` block) |

### Operational steps after merge

1. `gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main -f mode=catalog-only` — manual trigger, picks up today's 10 published concepts.
2. `gh run watch` — observe ~1-2 min wall-clock completion.
3. Smoke verify per §Testing strategy.

### Effort estimate

- Workflow edit + commit: 5 min.
- PR review + merge: ~10 min.
- Manual workflow run + smoke verification: ~3 min.

**Total active engineering time: ~20 min.** Plus wall-clock.

## Decisions made during brainstorming

For future reference, the three conceptual decisions:

1. **Approach: option A** — fix the workflow + verify auto-trigger works. (Q1 chose A; investigation revealed auto-trigger is already wired, so only the workflow change is needed.)
2. **Rebuild mode for concept publishes: `catalog-only`** — already in place via `CATALOG_ONLY_ENTITIES` (#685). `fetch-concepts` runs on `full` + `catalog-only`, skipped on `slug-targeted`.
3. **Today's 10 concepts: single PR + manual workflow run after merge** — same shape as the workflow fix; no extra deploys; ~3 min wall-clock from merge to live pages.
