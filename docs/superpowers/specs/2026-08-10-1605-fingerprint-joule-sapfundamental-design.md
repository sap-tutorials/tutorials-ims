# Fingerprint `joule.css` + `sap-fundamental.css` (dual-emit) — Design

**Issue:** [#1605](https://github.com/sap-tutorials/tutorials-ims/issues/1605)
**Date:** 2026-08-10
**Follow-up to:** #1601 / #1603 (CSS fingerprinting), #1584 + 2026-08-10 giant-logo incident (root cause)

## Problem

Two stylesheets are still referenced by **hardcoded bare path** and so are NOT
covered by the CSS fingerprinting landed in #1601 / #1603. They remain exposed to
the same CDN stale-edge bug as the 2026-08-10 giant-logo incident: fresh HTML can
pair with an edge-cached stale stylesheet under a stable `/css/<name>.css` URL.

1. **`joule.css`** — `hugo/layouts/_default/baseof.html:15`
   (`<link ... href="/css/joule.css">`, guarded by `{{ if not site.Params.qa }}`).
   Lives in `hugo/static/css/` (copied verbatim → not reachable by `resources.Get`).
2. **`sap-fundamental.css`** — `hugo/layouts/partials/head.html:35` and
   `hugo/layouts/scanner-vue/list.html:20`.

## Two corrections to the issue's premises (found during recon)

The issue's suggested fixes are partly based on assumptions that don't hold in
this repo. Both were confirmed against the working tree:

### A. The `assets/` copy of `sap-fundamental.css` is NOT a usable equivalent

- `hugo/assets/css/sap-fundamental.css` (76 KB) is the **uncompiled `@import`
  source** (`@import 'fundamental-styles/dist/button.css'` …).
- `hugo/static/css/sap-fundamental.css` (807 KB) is the **compiled** output
  produced by `npm run build:css` (`postcss` + `postcss-import`, config at
  `hugo/postcss.config.cjs`).

Doing `resources.Get "css/sap-fundamental.css" | fingerprint` **today** would
fingerprint and ship the broken `@import`-based source — its relative
`fundamental-styles/dist/...` paths do not resolve in a browser. We must
fingerprint the **compiled bytes**, not the `@import` source as-is.

### B. Normal CAP pages already inherit the Hugo `<head>` — only the degraded fallback is bare

CAP catalog / mission / group / concept pages get their `<head>` from Hugo's
published `__shell__` BLOB. The `_shell` layout (`hugo/layouts/_shell/single.html`)
defines only an empty `main` block, so it renders through the **default
`baseof.html` → `head.html`** chrome. `scripts/publish-content.ts` ships that
rendered chrome as ContentFiles slug `__shell__`; `srv/lib/chrome-shell.js`
splices bodies into it.

**Consequence:** fingerprinting `head.html` **automatically** flows the hashed
`sap-fundamental` URL into every CAP-served catalog page. The hardcoded
`/css/sap-fundamental.css` in `srv/lib/content-store.js:958` and
`srv/lib/concept-list-page.js:241` is only the **degraded fallback** used when the
shell BLOB is missing/malformed (a broken publish). That path is rare, not
edge-cacheable in the normal sense, and just needs to keep resolving — so a bare
copy must still be emitted, but we do **not** need to thread a hash through the
CAP renderers.

Note also: `sap-fundamental.css` has **no** admin-shell consumer. Only
`joule.css` is referenced by the static admin-shell page.

## Bare-path consumers that must keep resolving

| File | Path | Type | Why it can't take a Hugo hash |
|---|---|---|---|
| `app/admin-shell/webapp/index.html:10` | `/css/joule.css` | static UI5 file | Not Hugo-processed; can't compute a `fingerprint` hash |
| `test/smoke/joule-aurora.test.js:9` | `/css/joule.css` | smoke test | Fetches the stable URL |
| `test/smoke/joule-step-fab.test.js:37` | `/css/joule.css` | smoke test | Fetches the stable URL |
| `srv/lib/content-store.js:958` | `/css/sap-fundamental.css` | CAP degraded fallback | Runtime can't know the build-time hash |
| `srv/lib/concept-list-page.js:241` | `/css/sap-fundamental.css` | CAP degraded fallback | Same |

Because these consumers exist, the fix is **dual-emit**: from a single source,
Hugo emits BOTH the fingerprinted URL (linked by the anonymous Hugo pages + the
`__shell__`) AND the bare `/css/<name>.css` (for the consumers above). The
degraded/admin/scanner surfaces are not edge-cached the way anonymous content is,
so their residual stale risk is low and acceptable.

## Approaches considered

1. **Retarget `build:css` → `assets/`, dual-emit via `.Publish` (chosen).**
   Rename the `@import` source, compile into `assets/`, fingerprint the compiled
   bytes, and publish a bare copy as a side effect. Matches the #1601/#1603
   pattern (fingerprint an `assets/` file) with no new Hugo pipeline.
2. **Compile inside Hugo via `css.PostCSS`.** `resources.Get "…src.css" |
   css.PostCSS | fingerprint`. `postcss-cli` + `postcss-import` are present and
   Hugo is extended. Rejected: adds Hugo build-time PostCSS resolution risk
   against `node_modules` and diverges from the existing `npm run build:css` flow.
3. **Leave `sap-fundamental` bare, fingerprint only `joule`.** Rejected: leaves
   the 807 KB stylesheet exposed to the exact bug the issue is about.

## Design

### Mechanism: single-source dual-emit

Hugo's `Resource.Publish` writes a resource to `public/` at its `RelPermalink` as
a side effect, without needing a `<link>`. So from one `assets/` source we:

- `{{ $r := resources.Get "css/<name>.css" }}` → `.RelPermalink` is bare
  `/css/<name>.css`.
- `{{ $r.Publish }}` → emits the bare file to `public/css/<name>.css` (keeps every
  bare consumer resolving).
- `<link ... href="{{ ($r | fingerprint).RelPermalink }}">` → emits + links
  `/css/<name>.<hash>.css` (the edge-safe URL for the referenced page).

This removes the drift risk of committing two copies: there is one source file;
the bare and hashed outputs are both generated at build time.

### Part 1 — `joule.css`

1. Move `hugo/static/css/joule.css` → `hugo/assets/css/joule.css` (`git mv`).
2. In `baseof.html:15`, inside the existing `{{ if not site.Params.qa }}` guard:
   ```gotemplate
   {{ if not site.Params.qa }}{{ $joule := resources.Get "css/joule.css" }}{{ $joule.Publish }}<link rel="stylesheet" href="{{ ($joule | fingerprint).RelPermalink }}">{{ end }}
   ```
   - The fingerprinted URL styles every anonymous Hugo page + the `__shell__`.
   - `.Publish` keeps `/css/joule.css` live for admin-shell + smoke tests.
3. No change to `app/admin-shell/webapp/index.html` (keeps bare `/css/joule.css`)
   or the two smoke tests.

`build:css` is unaffected (it only compiles `sap-fundamental`). `dev` still works:
`joule.css` becomes an `assets/` resource resolved by `resources.Get`.

### Part 2 — `sap-fundamental.css`

1. `git mv hugo/assets/css/sap-fundamental.css hugo/assets/css/sap-fundamental.src.css`
   (the `@import` source gets a `.src.css` suffix; still tracked, still the
   editable source).
2. Change `build:css` in `package.json` to compile the source into `assets/`
   (committed compiled bytes — matching how `dev` relies on committed compiled CSS
   today):
   ```
   "build:css": "postcss hugo/assets/css/sap-fundamental.src.css --config hugo/ --no-map -o hugo/assets/css/sap-fundamental.css"
   ```
3. Delete `hugo/static/css/sap-fundamental.css` (the old verbatim-copied compiled
   file; its role is replaced by `.Publish`).
4. Commit the freshly compiled `hugo/assets/css/sap-fundamental.css` (compiled
   bytes, so `dev` and the source-string test keep working without a build step).
5. `head.html` (replace line 35):
   ```gotemplate
   {{ $fundamental := resources.Get "css/sap-fundamental.css" }}
   {{ $fundamental.Publish }}
   <link rel="stylesheet" href="{{ ($fundamental | fingerprint).RelPermalink }}">
   ```
6. `scanner-vue/list.html` (replace line 20): same pattern. (`.Publish` here is
   idempotent — publishing the same resource twice across layouts is safe.)
7. **No change** to the CAP renderers (`content-store.js`,
   `concept-list-page.js`): the degraded fallback keeps its bare
   `/css/sap-fundamental.css`, which `.Publish` guarantees still exists.

### Test impact

- `test/hugo-step-badges.test.js:23` reads
  `hugo/assets/css/sap-fundamental.css` for `.step-badge` rules. After the retarget
  this path holds the **compiled** bytes (which contain the same `.step-badge`
  rules — verified: 8 occurrences in both source and compiled). Test still passes
  **only if the compiled file is committed** (step 4). No test edit needed.
- Smoke tests fetching `/css/joule.css` still pass (`.Publish` emits it).
- New guard test (see Testing) asserts baseof/head emit fingerprinted links AND
  publish bare copies.

### `.gitignore`

The compiled `hugo/assets/css/sap-fundamental.css` stays **committed** (not
ignored) — `npm run dev` runs `hugo server` without `build:css`, so it depends on
the committed compiled bytes, exactly as it does today for the `static/` copy.

## Files changed

| File | Change |
|---|---|
| `hugo/static/css/joule.css` → `hugo/assets/css/joule.css` | `git mv` |
| `hugo/assets/css/sap-fundamental.css` → `…/sap-fundamental.src.css` | `git mv` (source) |
| `hugo/assets/css/sap-fundamental.css` | regenerated compiled bytes (committed) |
| `hugo/static/css/sap-fundamental.css` | deleted |
| `package.json` (`build:css`) | retarget output to `assets/`, input to `.src.css` |
| `hugo/layouts/_default/baseof.html` | dual-emit joule |
| `hugo/layouts/partials/head.html` | dual-emit sap-fundamental |
| `hugo/layouts/scanner-vue/list.html` | dual-emit sap-fundamental |
| `docs/developers/architecture/cdn-caching.md` | note joule + sap-fundamental now fingerprinted (dual-emit) |

**Untouched (deliberately):** `srv/lib/content-store.js`,
`srv/lib/concept-list-page.js` (degraded fallback keeps bare path),
`app/admin-shell/webapp/index.html`, both joule smoke tests, `.deploy/mta.yaml`
(`cp -r hugo/static` + `cp -r hugo/assets` both already present; the moved files
ride along).

## Testing

1. **Local Hugo build** (`npm run build:css && hugo --source hugo --minify`) and
   assert on `hugo/public`:
   - `public/css/joule.<hash>.css` exists AND `public/css/joule.css` exists.
   - `public/css/sap-fundamental.<hash>.css` exists AND
     `public/css/sap-fundamental.css` exists.
   - A rendered page (e.g. `public/index.html`) links the **hashed** joule +
     sap-fundamental URLs and has **zero** bare `/css/joule.css` /
     `/css/sap-fundamental.css` `<link>`s.
   - The published bare `sap-fundamental.css` is the **compiled** form (no raw
     `@import 'fundamental-styles` lines).
2. **Guard unit test** (source-string, mirroring #1601/#1603 style): assert
   `baseof.html` fingerprints joule + `.Publish`es it; `head.html` +
   `scanner-vue/list.html` fingerprint sap-fundamental + `.Publish` it.
3. `npm test` green (esp. `hugo-step-badges.test.js` against the compiled
   `assets/` file).
4. Smoke (post-deploy, informational): `/css/joule.css` and
   `/css/sap-fundamental.css` still 200.

## Risks

- **Committed compiled artifact drift:** if someone edits `.src.css` but forgets
  `npm run build:css`, `assets/sap-fundamental.css` goes stale. This risk exists
  **today** (edit source → forget to rebuild `static/`); the move doesn't worsen
  it. `build:all` runs `build:css` before `build:hugo`, so any real deploy
  recompiles. Mitigation: the guard test + a one-line note in the source file
  header.
- **`.Publish` availability:** confirmed on Hugo `Resource` (docs current); this
  repo runs Hugo v0.147.7+extended. If `.Publish` misbehaved, the bare file simply
  wouldn't emit and the local build test (step 1) would catch it before deploy.
