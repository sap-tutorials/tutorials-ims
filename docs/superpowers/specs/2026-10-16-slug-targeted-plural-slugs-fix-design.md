# Design — slug-targeted rebuild honours the plural `slugs` input (#2805)

**Date:** 2026-10-16
**Issue:** sap-tutorials/tutorials-ims#2805 (follow-up to #2802, related #2801)
**Repo:** sap-tutorials/tutorials-ims (local folder `tutorials-poc`)

## Intent / the why

Issue #2805 reports the `Refresh tutorial images (slug-targeted)` step took **361s** on
run 38816499609 — co-equal with publish, contradicting the "always 0–2s" assumption. The
spike (#2802, Finding 3) flagged it as an outlier but did not root-cause it.

### Root cause (confirmed from the run log)

Run 38816499609 was a **`workflow_dispatch`** with:

- `mode = slug-targeted`
- `slug` (singular) = **empty**
- `slugs` (plural) = `devtoberfest2026-fun-week4-validation` (one slug)

The mode step (`Determine effective rebuild mode`) correctly resolved `slug-targeted`
because its inference at `rebuild-content.yml:247-252` honours **either** `INPUT_SLUG`
**or** `INPUT_SLUGS`. But the two downstream fast-path steps resolve the slug from only
the **singular** input + the repository_dispatch slug:

- Image step env (`:997`): `REFRESH_SLUG: ${{ inputs.slug || steps.mode.outputs.dispatch_slug }}`
- Publish step env (`:914`): `PUBLISH_SLUG: ${{ … (inputs.slug || steps.mode.outputs.dispatch_slug) … }}`

Neither reads `inputs.slugs`. So `REFRESH_SLUG` resolved to **empty**, and
`backfill-images.ts --slug ""` → `parseSlug` returns `undefined` → `collectImageUrls`
enumerated the **whole catalog (21,712 images)** = 361s. The log is unambiguous:

```
REFRESH_SLUG:
Enumerating image URLs under …/tutorials ...      ← no "(slug: …)" scope
Found 21712 unique image URL(s).
```

The same latent bug sat in the **publish** step: on this run publish ran 365s
(whole-catalog delta) for the same reason. The `slugs`-plural operator path silently
defeated *both* fast paths.

This is a **silent correctness/performance fallback**, not a slow slug. The fix makes the
plural input actually scope the work, and removes the silent whole-catalog surprise.

### Already-fixed on origin/DEV (publish half)

Investigation on `origin/DEV` (ahead of `main`) shows the **publish** half is already done:
`publish-content.ts` has `opts.slugs` (env `PUBLISH_SLUGS` / `--slugs`), `filterToSlugs`,
and combines `slug + slugs` at the call site; the workflow mode step emits a
`dispatch_slugs` output and the publish step passes `PUBLISH_SLUGS: inputs.slugs ||
dispatch_slugs`. **The only remaining gap for #2805 is the image-refresh path**, which was
never updated and still reads singular-only (`REFRESH_SLUG: inputs.slug ||
dispatch_slug`, `backfill-images.ts --slug` single). This plan mirrors the existing publish
pattern onto the image path.

## Goals

1. A `workflow_dispatch` with `mode=slug-targeted` and the **plural** `slugs` input scopes
   both the publish and the image-refresh steps to exactly those slug(s) — no whole-catalog
   fallback.
2. Support **multiple** slugs (comma-separated), since `slugs` is explicitly a multi-slug
   input (`#2801` multi-slug dispatch).
3. One source of truth for the resolved slug filter, consumed by both steps.

## Non-goals

- Do **not** change the mode-inference logic (`:247-269`) — it already honours plural.
- Do **not** change `repository_dispatch` behaviour — `dispatch_slug` stays single-slug
  (payload is one changed tutorial); it just folds into the central filter.
- Do **not** touch the `--allow-revert` path: it stays **single-slug-only** (its guard
  `resolveAllowRevertSlugs` at `publish-content.ts:574` intentionally requires exactly
  one `--slug`). Multi-slug + allow-revert is refused, unchanged.
- No change to `catalog-only`/`full` modes.

## Anti-goals (would make this a failure even if green)

- A fix that makes an **unknown/typo'd** slug silently warm/publish nothing or everything.
  `filterToSlug` must still fail loudly on a slug that isn't in the Hugo output.
- Introducing a second slug-resolution expression that can drift from the first (the exact
  class of bug we're fixing).

## Constraints

- CLAUDE.md: PR over direct merge; feature PR targets **DEV**, not main. Branch from fresh
  `origin/DEV`.
- `continue-on-error: true` on the image step stays (best-effort warm must never fail the
  rebuild).
- Scripts are invoked via `npx tsx` in CI; keep them importable-without-run (the
  `isMainModule` guard) so unit tests keep working.
- Slug charset already validated upstream for dispatch payloads; `slugs` is a
  `workflow_dispatch` string input (operator-supplied, trusted) but we still split/trim
  defensively.

## The how — decided

### 1. Central resolved slug filter (workflow)

In `Determine effective rebuild mode` (`rebuild-content.yml`), after `effective_mode` is
computed, emit a new output `slug_filter`:

- Start from `INPUT_SLUG` (singular).
- Append `INPUT_SLUGS` (plural) if set (comma-join, matching the existing step-summary
  logic at `:1064-1070`).
- For `repository_dispatch`, `slug_filter` = the validated `PAYLOAD_SLUG` (same value that
  sets `dispatch_slug` today).
- Deduplicate + strip blanks + trim; emit as a single comma-separated `slug_filter=…` line.
- Only meaningful when `effective_mode == 'slug-targeted'`; empty otherwise.

Both consumer steps change to read it:

- Image (`:997`): `REFRESH_SLUG: ${{ steps.mode.outputs.slug_filter }}`
- Publish (`:914`): `PUBLISH_SLUG: ${{ steps.mode.outputs.effective_mode == 'slug-targeted' && steps.mode.outputs.slug_filter || '' }}`

`dispatch_slug` output is retained (other steps/summary may reference it) — `slug_filter`
supersedes it only at these two consumers.

### 2. Multi-slug in the scripts (comma list via existing `--slug`)

**backfill-images.ts**
- `parseSlug` → `parseSlugs(argv): string[]` returning the comma-split, trimmed, non-empty
  list from `--slug` (keep a single-value call compatible: `"a"` → `["a"]`, `""`/absent →
  `[]`).
- `collectImageUrls(publicDir, slugs?: string[])` — change the `slug ? [slug] : readdir`
  line (`:72`) to `slugs?.length ? slugs : readdirSync(...)`. The rest already loops a slug
  array.
- Log line shows the joined slug list.

**publish-content.ts**
- `opts.slug` (single) → keep the field, but add `opts.slugs: string[]` derived the same
  comma-split way from `--slug` / `PUBLISH_SLUG`.
- Replace the single `filterToSlug(tutorials, opts.slug)` call (`:1254-1257`) with a
  `filterToSlugs(tutorials, opts.slugs)` that:
  - no-op (returns false) when the list is empty,
  - throws loudly (same message shape) if **any** listed slug is absent from the Hugo
    output,
  - otherwise reduces `tutorials` to exactly the listed slugs.
- `--allow-revert`: keep `resolveAllowRevertSlugs` reading a **single** slug. If
  `opts.slugs.length !== 1` while `allowRevert` is set, it throws (tighten the existing
  "requires --slug" guard to "requires exactly one --slug"). Single-slug behaviour
  unchanged.

### 3. Tests (TDD — failing first)

- **Unit (`test/unit/…`)** for `parseSlugs` + `filterToSlugs`:
  - `"a,b,c"` → 3 slugs; `" a , b "` → `["a","b"]`; `""`/absent → `[]`.
  - `filterToSlugs` reduces the Map to listed slugs; throws on an unknown slug; no-op on
    empty.
  - `collectImageUrls(dir, ["slug-a","slug-b"])` reads only those two index.html files
    (fixture-backed), not the whole dir.
- **allow-revert guard** test: `allowRevert` + 2 slugs → throws; + 1 slug → ok.
- Reuse the existing `test/unit/publish-image-warm.test.js` harness/fixtures where
  possible.

### 4. Doc / gotcha

Add a one-line note to the image-step comment block (`:973-988`) that `REFRESH_SLUG` now
derives from the central `slug_filter` (slug + slugs + dispatch_slug), so the plural input
scopes the warm. Update `publish-performance-spike-2802.md` Finding 3's image bullet to
point at this fix (it currently just says "worth its own look").

## What's left to the builder

- Exact shell for the comma-join/dedupe in the mode step (sketch above; mirror `:1064-1070`).
- Whether `filterToSlugs` lives beside `filterToSlug` or replaces it (keep both if any
  other caller uses the single form; grep shows only the one call site + tests).
- Test file placement under `test/unit/` consistent with siblings.

## Verification (before "done")

- `npm test` green (new unit tests + no regressions).
- Dry-run proof: `backfill-images.ts --slug "a,b" --dry-run` enumerates only a+b's images;
  `--slug ""` still enumerates all (default) — i.e. the fallback is intact and *intended*
  only when no filter is given.
- Re-dispatch (or `act`/manual trace) that a `slugs=`-only slug-targeted run now logs
  `(slug: …)` scope and a small image count, not 21,712. (CI proof noted in PR.)
```
Line numbers are against `main` @ 31e34a08f (current checkout) / to be rebased on origin/DEV.
```
