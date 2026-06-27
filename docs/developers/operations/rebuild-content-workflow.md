# Rebuild Content Workflow

> **⚠️ Always use this workflow — never `npm run publish-content` from a workstation.** Until #672 shipped, a stale local `.tutorial-cache/` silently regressed CI-published content. With the staleness guard in place the worst case is caught server-side, but a workstation publish still skips fetch, Hugo build, and validation. Use `gh workflow run rebuild-content.yml -f mode=full` (or `-f slug=…` for one-tutorial fixes).

GitHub Actions workflow that fetches tutorial markdown, builds Hugo, and publishes HTML to HANA. Three rebuild scopes (modes), each tuned for a different write pattern. Auto-classified by admin writes; manual dispatches auto-infer when a slug is set.

Workflow file: [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml)
Dispatcher (admin path): [srv/lib/rebuild-trigger.js](../../../srv/lib/rebuild-trigger.js) → [srv/lib/_classify-rebuild-mode.js](../../../srv/lib/_classify-rebuild-mode.js)
Related issues: #429 (3-mode classifier), #433 (multi-slug filter), #609 (auto-infer), #613 (Phase 2 prefetch scoping).

## TL;DR

| You want to | Run | Wall-clock |
|---|---|---|
| Republish one tutorial (parser fix, content typo) | `gh workflow run rebuild-content.yml --ref main -f slug=$SLUG` | ~2 min |
| Rebuild after admin Mission / Group / etc. save | Nothing — admin auto-triggers `mode=catalog-only` after a 60s debounce | ~1 min |
| Full rebuild (dependency bump, Vue island change) | `gh workflow run rebuild-content.yml --ref main -f mode=full` | ~10 min |

Manual `gh workflow run ... -f slug=X` calls auto-infer `mode=slug-targeted` since #610 — you do NOT need to also pass `-f mode=slug-targeted`. The `::notice::` annotation at the top of the run UI reads `slug-targeted (auto-inferred (slug/slugs set, mode left at default))` when this fires.

## The three modes

### `catalog-only`

For admin saves of catalog data (Missions, Groups, CompletionPaths, FeaturedTasks, etc.) — these mutate `/build/catalog` outputs which feed `hugo/data/browse.json` and the mission/group landing pages. Tutorial-page content does not change.

**Steps that run:** Install deps → Restore cache → Build Hugo → Publish to HANA.

**Steps that skip:** Fetch (no GitHub round-trip), Lint, Validate, Build Vue apps, Joule vendor, Build display, Build admin SPAs, Assemble static content, AppRouter push.

**When to dispatch manually:** rare. Admin writes auto-classify to this mode via the entity sets in [`srv/lib/_classify-rebuild-mode.js`](../../../srv/lib/_classify-rebuild-mode.js): `Missions`, `Groups`, `CompletionPaths`, `CompletionPathItems`, `GroupPathItems`, `FeaturedTasks`, plus the bound actions `classifyCategories` and `setFeaturedOrder`.

### `slug-targeted`

For one or a few tutorial fixes (parser fix, content typo, single-author edit). Uses `slug` / `slugs` inputs to narrow Phase 2 metadata prefetch + Phase 3 markdown processing to only the listed slug(s).

**Steps that run:** everything `catalog-only` runs, plus Fetch (filtered), Lint (full — fast), Validate (full — fast), AI VCAP if AI authoring is on.

**Steps that skip:** Build Vue apps, Joule vendor, Build display, Build admin SPAs, Assemble, tarball, AppRouter push.

**Auto-classified by admin writes for:** `Tutorials` and `Steps` CRUD (single slug), `Tags` CRUD (reverse-lookup of all tutorials carrying the tag, capped at 50 — beyond that, falls back to `full` + `force-cap-refetch=true`).

**Manual dispatch:**

```bash
# Single slug
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f slug=tutorial-platform-feature-cookbook

# Multiple slugs (comma-separated)
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f slugs="foo,bar,baz"

# Union of both inputs
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f slug=foo -f slugs="bar,baz"
```

The slug filter validates upfront against discovery — if you typo a slug, the run fail-fasts with the list of all unknown slugs in one rerun (per #433 spec).

### `full`

For dependency bumps, Vue island changes, AppRouter static-asset changes, or the scheduled nightly. Re-fetches every tutorial markdown, rebuilds every Vue island, every admin SPA, the display app, and pushes a fresh approuter tarball.

**Steps that run:** everything.

**Manual dispatch:**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full
```

You can also force the catalog snapshot to refetch (24h TTL cache otherwise) when the data driving `/build/catalog` has changed and you want the rebuild to pick it up immediately:

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full -f force-cap-refetch=true
```

## Measured wall-clock (verified 2026-06-24)

These numbers come from real runs against `main` ([PR #615](https://github.com/sap-tutorials/tutorials-ims/pull/615) measurement section). Times include GH Actions runner startup overhead (~30-40s for setup + checkout + Hugo install + npm ci) which is the floor for any mode.

| Mode | End-to-end | Fetch step | Publish step |
|---|---|---|---|
| `catalog-only` | **1m 04s** | skipped | ~3s |
| `slug-targeted` (post #613) | **2m 22s** | ~55s | ~3-21s |
| `full` | **~10 min** | ~5-6 min | varies |

Pre-#613, `slug-targeted` was clocking 7m 14s because Phase 2 (GitHub metadata prefetch) ignored the slug filter. The fix scoped Phase 2 to only fetch metadata for in-filter slugs. Time dropped from 4m 40s to 932ms inside Phase 2.

## Admin auto-trigger flow

When an admin saves through `AdminService`, [`srv/lib/rebuild-trigger.js`](../../../srv/lib/rebuild-trigger.js)'s `scheduleRebuild()` is called with the classifier's recommended mode, slug (if any), and `forceCapRefetch` flag. The dispatch is debounced for **60 seconds** — multiple admin writes within the window coalesce into one rebuild via mode-priority merging:

1. `full` > `slug-targeted` > `catalog-only` (higher RANK wins)
2. Slugs accumulate up to 50; beyond that, the trigger upgrades to `full` and clears the slug set (configurable cap is YAGNI — bulk admin operations >50 in a 60s window should set `x-migration-mode` to skip the trigger entirely).

Token sourcing is credstore-first with env fallback ([srv/lib/secret-resolver.js](../../../srv/lib/secret-resolver.js), 5-min TTL cache). The `GITHUB_DISPATCH_TOKEN` secret is bootstrapped via the admin Secrets UI; see [secrets-tracking.md § Bootstrap GITHUB_DISPATCH_TOKEN](secrets-tracking.md#bootstrap-github_dispatch_token).

The dispatcher's mode-classification matrix lives in [`srv/lib/_classify-rebuild-mode.js`](../../../srv/lib/_classify-rebuild-mode.js):

| Entity / Action | Mode | Notes |
|---|---|---|
| `Missions` CRUD | `catalog-only` | |
| `Groups` CRUD | `catalog-only` | |
| `CompletionPaths` / `CompletionPathItems` CRUD | `catalog-only` | |
| `GroupPathItems` CRUD | `catalog-only` | |
| `FeaturedTasks` CRUD | `catalog-only` | |
| `Tutorials` CRUD | `slug-targeted` | slug resolved from row |
| `Steps` CRUD | `slug-targeted` | slug resolved via `Step.tutorial_ID` → `Tutorials.slug` |
| `Tags` CRUD | `slug-targeted` | reverse-lookup via `TutorialTags` junction; falls back to `full` + `force-cap-refetch` if 0 or >50 slugs |
| `classifyCategories` action | `catalog-only` | |
| `setFeaturedOrder` action | `catalog-only` | |
| `commitTagImport` action | `full` + `force-cap-refetch=true` | bulk Tag creation |
| `cleanupUnusedTags` action | `full` + `force-cap-refetch=true` | bulk Tag deletion |
| Anything else | `full` (defensive default) | |

If an admin save fires a rebuild, you'll see it on the workflow's run list within ~60s with `trigger-source: admin-write:the reason`. The notice at the top of the run UI confirms the resolved mode.

## Drift attribution

Every publish now records its initiator on `ContentManifest.initiator` and `PipelineLog.initiator`. Format:

- Workstation: `<user>@<hostname>` (auto-computed from `os.userInfo()` + `os.hostname()`)
- CI: `ci/<github_run_id>` (passed explicitly from `rebuild-content.yml` / `rebuild-content-qa.yml`)

To see who did the most recent N publishes:

```sql
SELECT VERSION, STATUS, TRIGGER, INITIATOR, MODIFIEDAT
  FROM COM_SAP_DEVELOPERS_IMS_CONTENTMANIFEST
 ORDER BY VERSION DESC
 LIMIT 20;
```

Or via the admin Pipeline Log tile (`/admin-ui/#pipelinelog-display`) — the `Initiator` column shows the same value joined by `PipelineLog.ID = ContentManifest.sessionId`.

If a daily content-drift check reports drifted slugs, the first forensic step is:

1. Find the publish that introduced the regression: `SELECT VERSION, INITIATOR FROM COM_SAP_DEVELOPERS_IMS_CONTENTMANIFEST ORDER BY VERSION DESC LIMIT 10`.
2. If `INITIATOR` is `ci/<run_id>`, the regression came from CI — pull the workflow log.
3. If `INITIATOR` is `<user>@<hostname>`, talk to that person. The most likely cause is a workstation publish from a stale `.tutorial-cache/`.

Historical rows (pre-#672) have `INITIATOR = NULL` and are not attributable — that's intentional, not a bug.

## Manual dispatch — UX gotchas

### Auto-infer (since #610 / PR #610)

When invoking via `workflow_dispatch` with `inputs.mode` at its `full` default AND `inputs.slug` or `inputs.slugs` set, the workflow's `Determine effective rebuild mode` step auto-infers `mode=slug-targeted`. The repository_dispatch path (admin auto-trigger) is NEVER overridden — the admin classifier is authoritative.

Resolution surfaced two ways:
1. `::notice::` annotation at the top of the run UI: `Rebuild mode: the resolved mode (the reason)`
2. Summary panel at the bottom of the run: `**Effective mode:** \`the mode\` — the reason`

### What if `force-cap-refetch` is set?

`force-cap-refetch=true` bypasses the `.tutorial-cache/` CAP catalog snapshot (24h TTL) and re-fetches `/build/catalog` fresh. Use after fixing data the catalog reads from (publish flag, slugs, etc.) so the rebuild reflects the change in the same run instead of waiting for the cache to expire.

Compatible with any mode. Admin classifier sets it automatically when classifying `Tags` CRUD that resolves to `full` (couldn't reverse-look up slugs) or for the `commitTagImport` / `cleanupUnusedTags` bulk actions.

### AI quiz authoring

`ai-author-enabled=true` (the default) wakes up the AI generator on tutorials carrying `[AUTOAUTHOR_*]` directives in their `rules.vr`. Requires `AI_AUTHOR_AICORE_SERVICE_KEY` + `CHAT_DEPLOYMENT_ID` secrets. See [ai-author-ci-setup.md](ai-author-ci-setup.md).

Flip to `false` only to bypass during incident triage. The `mode=catalog-only` path always skips AI authoring regardless of this flag (catalog-only doesn't fetch markdown so there's no `[AUTOAUTHOR_*]` to expand).

### Publish concurrency / batch-size tuning

`publish-concurrency` (default `6`) is the number of `/content/publish/append` batches in flight at once. `publish-batch-size` (default `50`) is slugs per batch. Multiplied gives total in-flight slugs (default 6×50 = 300 — the catalog has ~1400 slugs, so smaller batches just take longer linearly, not exponentially).

Lower if srv hits `HeadersTimeoutError`. Both defaults raised from `4`/`25` to `6`/`50` in #434 PR 2 after 9 stable runs at the prior levels. See #420 for the planned worker_threads change that would unlock higher concurrency.

## Troubleshooting

### "HTTP 409: Another publish in progress"

Two publishes hit the srv at the same time. The srv enforces serial publishes via a session lock — second and third dispatches fail with this 409. Re-dispatch one at a time. (Surfaced during the measurement work for #609 — three parallel runs ran fine through Hugo but only one made it past Publish.)

### Slug filter rejected at discovery

If a slug is in `slug` / `slugs` but not in the discovery snapshot, the run fail-fasts with `ERROR: N unknown slug(s) in filter: the list` so you fix typos in one rerun. Cause is usually a typo or a tutorial that hasn't been merged to its source repo yet.

### "Rebuild mode: full (explicit ...)" when I expected slug-targeted

Auto-infer fires only when `inputs.mode` is left at the default `full`. If you explicitly pass `-f mode=full -f slug=X` from the CLI, you've told the workflow "no really, run a full rebuild" and slug is ignored for mode-selection (the slug input is still honored for Phase 2 / Phase 3 scoping, but every other step also runs).

To get the auto-infer behavior, drop `-f mode=full` entirely.

### Admin auto-trigger didn't fire after my save

Check:
1. Was the entity in `_classify-rebuild-mode.js`'s known set? If not, the classifier falls through to `full` (which still fires).
2. Did `GITHUB_DISPATCH_TOKEN` resolve? `srv/lib/rebuild-trigger.js`'s boot log emits `[rebuild-trigger] active — admin writes will dispatch (...)` on success, or `[rebuild-trigger] GITHUB_DISPATCH_TOKEN unreachable from credstore or env — admin writes will not trigger rebuilds.` on failure. Set via `/admin-ui/#secrets-display`.
3. Was the 60s debounce window already pending? Repeated admin saves within the window merge into one dispatch — check the next workflow run for your edit.
4. Did the admin save use `x-migration-mode: true` header? Migrator REST calls deliberately skip the trigger to avoid burst-dispatching during bulk imports.

## Related runbooks

- [secrets-tracking.md](secrets-tracking.md) — token bootstrap
- [github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md) — PAT rotation procedure
- [github-app-setup.md](github-app-setup.md) — preferred alternative to PAT
- [ai-author-ci-setup.md](ai-author-ci-setup.md) — AI quiz authoring secrets
- [qa-channel-bootstrap.md](qa-channel-bootstrap.md) — the QA sibling workflow (`rebuild-content-qa.yml`)
