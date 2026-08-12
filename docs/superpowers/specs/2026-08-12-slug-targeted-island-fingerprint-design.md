# Slug-targeted rebuilds must bake fingerprinted island paths

**Date:** 2026-08-12
**Status:** Design — awaiting review
**Owner:** Tom
**Scope:** `.github/workflows/rebuild-content.yml`, `scripts/check-approuter-assets.cjs`

## Problem

A brand-new tutorial (`trial-get-productive-with-joule-work`) shipped to PROD with its
step-6 validation question — and every other interactive island on the page — not
rendering. Root cause is a workflow-gating defect, not authoring or data:

- `rebuild-content.yml` skips four steps when `effective_mode == 'slug-targeted'`:
  the `hugo-apps` install (inside the "Install dependencies" step, lines 291–295),
  **Build Vue apps** (line 450), **Build island manifest** (line 469), and the
  homepage fingerprint guard (line 574).
- The Hugo build itself (line 542) is **not** gated, so content is rendered and
  published regardless.
- With "Build island manifest" skipped, `hugo/data/island_manifest.json` is absent.
  `hugo/layouts/partials/island-src.html` then falls back to the bare
  `/js/<name>.js` for **every** island it emits:
  `{{- index (site.Data.island_manifest | default dict) $name | default (printf "/js/%s.js" $name) -}}`.
- The tutorial HTML (stored as a HANA BLOB) is published with those bare paths.
  The approuter only serves the content-hashed bundles from the last full MTA deploy
  (`/js/validation-K8FRraal.js` → 200; `/js/validation.js` → **404**). The island
  module never loads, so `<div class="step-validation-mount" data-step="6">` stays
  empty and the question never renders.

### Evidence (PROD, 2026-08-12)

- Served HTML contains the correct `tutorial-data` for step 6
  (`{"number":6,…,"validation":[{"id":"validate-6",…}]}`) — data is fine.
- Served HTML references `<script type=module src=/js/validation.js defer>` (bare).
- `/js/validation.js` → 404; `/js/validation-K8FRraal.js` → 200 on the PROD approuter.
- Tutorials published via a full build reference the hashed bundle and render.
- The 10:34 UTC `repository_dispatch` run that published this tutorial resolved to
  `slug-targeted` and skipped the island build.
- A tutorial page emits many hashed islands (`validation`, `code-check`,
  `related-graph`, `tutorial-rating`, `tutorial-pip`, `embed`, `joule`, …); on this
  slug-published page **all** were baked bare — validation is simply the one whose
  breakage is most visible.

## Goal

Slug-targeted rebuilds must produce the same fingerprinted island `<script src>`
paths as a full build, so a single-tutorial hotfix publishes correctly-wired HTML —
without doing whole-site work unrelated to the tutorial.

## Non-goals

- Rebuilding whole-site assets in slug mode (vendor WASM, `/explore` bundle,
  joule-vendor copy, homepage/verb/shelf data fetches). These produce stable-path or
  page-specific assets already deployed; tutorial pages reference them at
  unhashed/stable paths that resolve against the deployed approuter static, and the
  island Vite build does not depend on them. They stay slug-gated.
- Changing how islands are hashed, or the `island-src.html` fallback contract.
- The homepage `/` flip or any content-page work.

## Approach (chosen: build islands in slug mode)

Island bundle hashes are **content-deterministic** from `hugo-apps/` source, and the
island build is cheap: measured from a run that executes it, `hugo-apps` install
(~3–12s warm-cache) + `npm --prefix hugo-apps run build` (~7.5s) + Build island
manifest (~0.1s) ≈ **10–15s** added to a ~2-minute slug run. Under slug-targeted's
standing assumption — island/CSS bundles are already deployed on the approuter — a
fresh island build yields the **same** content hashes as the deployed bundles, so
the baked refs match what the approuter serves.

### Why the whole island set, not a per-tutorial subset

`npm --prefix hugo-apps run build` is a single atomic Vite pass that emits all island
bundles together; there is no cheap "just the tutorial-view islands" build without a
separately maintained entry subset that would rot. More importantly,
`island_manifest.json` must map **every** island name — a partial manifest re-introduces
the bare-path fallback for any island a page emits that isn't in the subset. So "build
whatever the tutorial needs" is satisfied by running the one island build (it covers
the tutorial-view islands and keeps the manifest complete), while still skipping the
whole-site steps above.

## Changes

### 1. `rebuild-content.yml` — un-gate the island build (all four steps)

These become prerequisites of the already-unconditional Hugo build, so **every**
content-producing mode (full, catalog-only, slug-targeted) bakes fingerprinted
island paths.

| Step | Line | Current gate | Change |
|------|------|--------------|--------|
| `hugo-apps` install (in "Install dependencies") | 291–295 | shell `if [ "$MODE" != "slug-targeted" ]` | Always run `npm --prefix hugo-apps install` |
| Build Vue apps | 450 | `if: effective_mode != 'slug-targeted'` | Run in all modes (drop the exclusion) |
| Build island manifest | 469 | `if: effective_mode != 'slug-targeted'` | Run in all modes (drop the exclusion) |
| Guard - homepage islands fingerprinted | 574 | `if: effective_mode != 'slug-targeted'` | Run in all modes (drop the exclusion) |

Update the stale "no Vue/SPA builds run" / "skipped in slug-targeted" comments to
reflect that the island build now runs in slug mode.

The vendor-WASM, `/explore`, joule-vendor, and homepage/verb/shelf-fetch steps keep
their `!= 'slug-targeted'` gates unchanged.

### 2. `check-approuter-assets.cjs` — probe hashed island JS in local-hugo mode

The existing #1622 guard (line 601, runs in slug-targeted mode, `--hugo-dir hugo/public`,
before the HANA publish) probes only `/css` today. Its own comment states this is
"CSS-only on purpose: JS island bundles … not rebuilt in slug mode." Our change #1
removes that reason: the manifest is now rebuilt, so locally-rendered HTML carries
hashed island refs and can be probed without false positives.

- Extend local-hugo mode to also extract same-origin hashed island refs
  (`/js/<name>-<hash>.js`, matching the existing `HASHED_ISLAND_RE`) from the
  rendered page(s) and HEAD/GET-probe each against the target approuter, failing the
  run (before publish) on any non-200 — the same fail-loud contract used for CSS.
- Continue to **exclude** the bare `/js/<name>.js` fallback from probing. After
  change #1 a bare island ref should not occur; if one does, the homepage
  fingerprint guard (change #1, step 574) and Build-island-manifest's non-empty
  exit code already fail the run.
- Gate the JS probe behind an explicit flag (e.g. `--check-islands`) passed from the
  slug-targeted guard step, so the served-content mode (`--served-base`, #1678) is
  untouched.
- Update the module and step comments (the "CSS-only on purpose" rationale).

This closes the incident class directly, including the residual "`hugo-apps` source
drifted vs. the last deploy" case the manifest fix alone doesn't cover: if a slug
rebuild bakes a hash the approuter doesn't serve, the run fails before poisoning HANA
with instructions to run a full deploy first.

## Testing

- **Unit:** a fixture rendered tutorial page carrying a hashed `validation` island →
  assert the extended `check-approuter-assets.cjs` collects the island ref and fails
  on a simulated 404 (and passes on 200). Keep/point an existing island-fingerprint
  unit at a tutorial-page fixture (not just homepage) so the tutorial-page break this
  incident hit is directly covered.
- **Guard-chain sanity:** confirm `check-hugo-island-fingerprint.cjs` still passes on
  a slug-mode build (manifest now present) and does not false-fail on the
  legitimately-bare islands (`nav-dropdown`, `concepts-filter`).
- **Manual (post-merge, DEV first):** trigger a slug-targeted rebuild for
  `trial-get-productive-with-joule-work`; confirm the served step-6 HTML references
  `/js/validation-<hash>.js` (200) and the question renders; then a `mode=full`-free
  slug rebuild on PROD to remediate the live tutorial.

## Rollout & remediation

1. Merge via PR (per repo convention; no direct-to-main).
2. The live tutorial is remediated by any post-fix slug-targeted rebuild (or a
   `mode=full` rebuild before the fix lands, as the immediate stopgap).
3. No schema, HANA, or approuter-static change; this is CI-workflow + guard-script only.

## Risks

- **Source drift:** if `hugo-apps` changed since the last full deploy but wasn't
  redeployed, a slug rebuild bakes a new hash the approuter lacks. Change #2 turns
  this from a silent 404 into a loud pre-publish failure — the correct behavior
  (operator runs a full deploy first).
- **Added ~10–15s** per slug-targeted run — acceptable against a ~2-min baseline.
- **Guard reach:** the homepage fingerprint guard only inspects `index.html`; the
  tutorial-page protection is change #2. Both ship together.
