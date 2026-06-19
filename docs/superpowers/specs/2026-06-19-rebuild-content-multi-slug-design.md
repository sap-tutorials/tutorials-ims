# Multi-slug rebuild input — design

**Issue:** [#433](https://github.com/sap-tutorials/tutorials-ims/issues/433) — `rebuild-content` workflow: support batched per-slug refresh (`slugs[]` input)

**Date:** 2026-06-19

## Problem

Today `rebuild-content.yml` accepts a single `slug` input for per-tutorial refresh. That works for one-tutorial fixes but is wrong for the case "I changed N adjacent tutorials in the same PR and want to refresh exactly those." Current author options:

1. Fire N separate workflow runs (~5–8 min each, 4× pipeline overhead).
2. Fire one full rebuild over all 1380 tutorials (~10–13 min).

Neither fits the small-multi-tutorial case. Surfaced 2026-06-19 by a 4-tutorial chore PR (`chore/remove-placeholder-images` to `sap-tutorials/meta-tutorials`).

## Goal

Allow `rebuild-content.yml` to refresh exactly N specified slugs in one run, where N ≥ 1, with semantics identical to the current single-slug path: bust those slugs' markdown caches, fetch them fresh, regenerate the rest from existing cache, skip the HANA `RepoCatalog` upload (partial runs never touch the catalog), and let `publish-content.ts`'s delta protocol handle the upload side naturally (only the changed slugs end up in `hugo/public/`, so only those publish).

## Approach

Extend the workflow + `fetch-tutorials.ts` with a small, surgical change:

1. **New workflow input `slugs`** (comma-separated string), passed as env var `TUTORIAL_SLUGS`.
2. **Existing `slug` input stays.** `slug=foo` keeps working unchanged. If both `slug` and `slugs` are provided, the union of both is used (defensive — prevents "I forgot one was set" silent partial runs).
3. **`fetch-tutorials.ts` parses `TUTORIAL_SLUG` + `TUTORIAL_SLUGS` into a `Set<string>` filter.** Replace every `t.slug === tutorialSlugFilter` with `tutorialSlugFilter.has(t.slug)`. Loop over the set for cache busting and validation. Comments and log lines update from "slug-filter" to "slug-filter (1 slug)" / "slug-filter (3 slugs)".
4. **Comma OR comma+space separator.** Trim each token, drop empties: `"foo, bar , baz"` → `Set(['foo','bar','baz'])`.
5. **Fail-fast on any unknown slug.** If ANY slug in the union isn't in the discovered tutorial set, exit non-zero with a clear message that lists ALL the unknown slugs at once (so the author fixes all typos in one rerun).

### Changes

| File | Action |
|---|---|
| `.github/workflows/rebuild-content.yml` | Add `slugs` input. Pipe `TUTORIAL_SLUGS: ${{ inputs.slugs }}` to fetch step. Update Summary to print the slug list when present. |
| `scripts/fetch-tutorials.ts` | Replace `tutorialSlugFilter: string \| null` with `tutorialSlugFilter: Set<string> \| null`. New exported pure function `parseSlugFilter(slug?: string, slugs?: string): Set<string> \| null` for unit-testability. Update validation, cache-busting, regenerate-skip, and log lines. |
| `scripts/__tests__/fetch-tutorials-qa.test.ts` (or new `fetch-tutorials-slug-filter.test.ts`) | Add unit tests for `parseSlugFilter()` covering: both empty → null; single `slug` → 1-element set; comma-list `slugs` → multi-element set; comma+space normalized; both inputs union; empty tokens dropped. |
| `CLAUDE.md` | Update the "rebuild-content.yml" mention in the CI/CD section: "Authors can force-refresh a single tutorial OR a comma-separated list via the `slug` / `slugs` inputs". |

### What does NOT change

- **Publish path:** `publish-content.ts`'s delta-publish protocol (compares `/content/hashes` to local SHA-256, uploads only changed) handles N-slug uploads naturally — no changes needed.
- **Mission/group SSR cache invalidation:** the existing `srv/server.js:352` flow handles a slug change invalidating its containers. Multi-slug doesn't change this pattern.
- **AI-quiz cache:** `[AUTOAUTHOR_*]` per-slug cache invalidates only the affected slug; unaffected slugs' caches stay warm.
- **`/build/catalog`:** data-driven, not republished as a slug.
- **`repository_dispatch` flow:** the admin-write debounced trigger fires `repository_dispatch` events with no `inputs.slug` set (workflow_dispatch-only), so the env var `TUTORIAL_SLUG` ends up empty. Multi-slug is workflow-dispatch-only for now; the dispatch path is unaffected by either the new `slugs` input or the `Set`-based filter.

## Why this approach

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **Add `slugs` input + Set-based filter** (this design) | Backward-compatible (`slug=foo` still works, no external runner breaks). Surgical: one new pure function + a type change. Naturally union-able. | Two inputs to remember. | **Chosen** |
| Repurpose `slug` to accept comma-list | One input, simpler UI. | Breaks any external runner that expected a single slug. Single-quote slugs containing commas (rare but possible) become impossible to express. | Rejected |
| Newline-separated `slugs` | Slightly nicer for >5 slugs in a textarea. | workflow_dispatch UI is a single-line text input — newlines in strings work but aren't visible in the UI. No real ergonomic win. | Rejected |
| Fan out N separate workflow runs from a controller | Reuses existing single-slug path. | N× pipeline overhead defeats the whole purpose of the issue. | Rejected |

## Failure modes

| Mode | Symptom | Action |
|---|---|---|
| Empty `slug` AND empty `slugs` | Full rebuild as today. | None — same baseline behavior. |
| `slugs="foo,, bar"` | Filter resolves to `Set(['foo','bar'])` | Empty tokens silently dropped during parse — convenience. |
| `slugs="foo,unknown-typo,bar"` | `unknown-typo` not in discovered set → workflow fails fast with `ERROR: TUTORIAL_SLUGS contained 1 unknown slug(s): unknown-typo`. | Author fixes the typo in the rerun. |
| Both `slug=foo` and `slugs=bar,baz` | Union → `Set(['foo','bar','baz'])`. Logged as `[slug-filter] 3 slugs (1 from slug, 2 from slugs)`. | None — defensive union by design. |
| One slug in the list, one of N markdown caches doesn't exist | Existing single-slug behavior: log `[slug-filter] no cache to bust for X — fresh fetch will run`. Same for each slug in the loop. | None. |
| Run takes longer with more slugs | Each additional slug = one more GitHub markdown fetch + one more parse. Linear, not exponential. 5 slugs ≈ 5–10s extra over the single-slug baseline. | Expected. The point of the issue. |

## Out of scope

- Adding multi-slug support to `repository_dispatch` (admin-write trigger). Single-slug is sufficient for that path; multi-slug bulk refreshes are an authoring workflow, not a runtime one.
- Mission/group/category-level batch refresh (covered by separate issue [#429](https://github.com/sap-tutorials/tutorials-ims/issues/429); broader scope, deferred).
- Allowing the `slugs` input to specify a regex / glob.
- Parallelizing the per-slug fetch beyond what `runWithConcurrency()` already does (it already concurrency-limits to 3 in Phase 2).

## Verification

1. **Workflow run with `slug=foo` only** (existing path): `[slug-filter] 1 slug (foo)` in logs; only `foo` re-fetched; partial run (no HANA RepoCatalog upload).
2. **Workflow run with `slugs=foo,bar,baz`**: `[slug-filter] 3 slugs (foo, bar, baz)` in logs; cache busted for all three; only those three re-fetched; rest regenerated from cache; partial run.
3. **Workflow run with `slugs=foo, bar , unknown-typo`**: workflow exits non-zero with error message naming `unknown-typo`; no Hugo build runs.
4. **Workflow run with both `slug=alpha` and `slugs=beta,gamma`**: log line `[slug-filter] 3 slugs (1 from slug, 2 from slugs)`; all three refresh.
5. **Workflow run with empty `slug` AND empty `slugs`**: full rebuild as today; HANA RepoCatalog uploads.
6. **Unit tests** for `parseSlugFilter()` cover all shapes above.

## References

- Issue: [#433](https://github.com/sap-tutorials/tutorials-ims/issues/433)
- Related (broader scope, deferred): [#429](https://github.com/sap-tutorials/tutorials-ims/issues/429)
- Workflow: [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml)
- Single-slug pivot: [scripts/fetch-tutorials.ts:467, 573–588, 641](../../../scripts/fetch-tutorials.ts#L467)
- Existing tests pattern: [scripts/__tests__/fetch-tutorials-qa.test.ts](../../../scripts/__tests__/fetch-tutorials-qa.test.ts)
- CLAUDE.md "rebuild-content.yml" entry (slug input docs).
