# Follow-up: turn the generated-content fast path ON by default

Follows Workstream C of `slug-targeted-delta-rebuild`. The fast path (on a
slug-targeted rebuild, reuse the cached generated tree and regenerate ONLY the
changed slug) is built and **PROD-proven** (2026-08-25): warm fetch dropped
**~56s → ~11s**, all 1404 non-target tutorials `[reused]`, one regenerated.
It is currently **opt-in** — `content-cache` workflow input, `default: false`.
This change makes it the default so every hotfix gets it without the flag.

## What this needs

### 1. Byte-identical diff guard  (tracker task 3.6 — the safety gate; do FIRST)
- Harness: for a sample changed slug, run a FULL regen and a FAST-PATH regen,
  then diff the resulting `hugo/public` (the changed tutorial page + a sample of
  reused pages) **byte-for-byte**; assert identical (enumerate any benign diffs).
- Wire into CI so future parser/nav changes can't silently break equivalence.
- This is the gate that must be green before the default is flipped.

### 2. Workflow wiring — default ON, scoped, and covering BOTH triggers
- `rebuild-content.yml`: flip the `content-cache` input `default: false → true`
  (keep `-f content-cache=false` as an explicit per-run opt-out).
- **FIX the repository_dispatch path (load-bearing):** at ~:419,
  `CONTENT_CACHE_FAST_PATH: ${{ inputs.content-cache == true }}` reads ONLY
  workflow_dispatch inputs, so **repository_dispatch runs — the real author
  hotfix trigger — always resolve to `false`** and never get the fast path.
  Compute the flag in the "Determine effective rebuild mode" step instead:
  `fast_path = (effective_mode == 'slug-targeted') && (content-cache != 'false')`,
  emit it as a step output, and reference that output for BOTH the env var (:419)
  and the `actions/cache` SAVE `if:` (~:378) so dispatch runs restore AND save.
- Ensure FULL rebuilds also WRITE the sidecar (prime the cache) so subsequent
  slug hotfixes stay warm. Safe because `decideFastPath` restricts *use* to
  slug-targeted runs regardless of who primed.

### 3. Mirror to `rebuild-content-qa.yml`  (tracker task 3.8)
- Add the same input + restore/save cache steps + `CONTENT_CACHE_FAST_PATH` env
  so QA-channel hotfixes get the same fetch collapse.

## Verification before merge
- Diff guard (item 1) green in CI.
- DEV A/B on a **repository_dispatch** slug hotfix shows `fast path ENABLED`
  (proves item 2's trigger fix, not just workflow_dispatch).
- Negative test: a parser or feed change forces a full regen (feed-fingerprint
  in `content-cache.ts` + the actions/cache key both invalidate).

## Rollback
- Per-run: `-f content-cache=false`. Global: revert the default flip.

## Why it is already safe to fire (fail-open by construction)
`decideFastPath` (scripts/lib/content-cache.ts) yields the fast path ONLY when
flag on AND slug-targeted AND a valid sidecar restored AND the feed fingerprint
(catalog + co-completions + tag-labels) matches. Any miss → normal full regen.
Full and catalog-only runs never use it. So the risk surface is limited to
"does a reused page render byte-identically to a full regen" — which item 1 proves.
