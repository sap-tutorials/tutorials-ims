# Slug-targeted image refresh honours plural `slugs` (#2805) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `slug-targeted` content rebuild dispatched with the plural `slugs` input scopes the image-refresh step to exactly those slug(s) instead of silently warming the whole 21,712-image catalog.

**Architecture:** Mirror the already-shipped publish-side multi-slug pattern onto the image path. `backfill-images.ts` gains a comma-list `--slug`/`--slugs` + `REFRESH_SLUGS` env fallback and `collectImageUrls` takes a slug array; the workflow image step passes a plural `REFRESH_SLUGS` built from `inputs.slugs || dispatch_slugs`, exactly as the publish step already passes `PUBLISH_SLUGS`.

**Tech Stack:** TypeScript (tsx), Vitest unit tests, GitHub Actions YAML.

**Spec:** `docs/superpowers/specs/2026-10-16-slug-targeted-plural-slugs-fix-design.md`

## Global Constraints

- Branch base: `origin/DEV` (PR targets DEV; `main` is protected, no main-hotfix path).
- Image warm step keeps `continue-on-error: true` — a warm failure must never fail the rebuild.
- Scripts stay importable-without-run (the `isMainModule` guard in `backfill-images.ts`) so unit tests import pure functions without executing `main()`.
- Backward compatible: a single-value `--slug "a"` and an empty/absent slug (whole-catalog default) must behave exactly as today.
- Mirror the publish precedent verbatim where it exists: `filterToSlugs` (`scripts/publish-content.ts:800`), `slugs: get('--slugs', process.env.PUBLISH_SLUGS ?? '')` (`:752`), workflow `PUBLISH_SLUGS` env (`.github/workflows/rebuild-content.yml:955`).

## Review Focus

- **Empty `REFRESH_SLUGS` + empty `REFRESH_SLUG`** (no filter at all) must still enumerate the whole catalog — the default/`full`-mode behaviour is intentional and must not become a no-op. → Task 1 test.
- **A typo'd / unknown slug** in the list must NOT silently warm nothing or everything; `collectImageUrls` yields an empty map for an unknown slug (no index.html), so the warm reports 0 images rather than falling back to the catalog — assert the count, not a throw (image warm is best-effort, unlike publish which throws). → Task 1 test.
- **Whitespace / duplicate entries** in the comma list (`" a , a , "`) must be trimmed, de-duped, and blanks dropped. → Task 1 test.
- **Single-slug `--slug "a"`** (existing CI call shape) must keep working unchanged. → Task 1 test.
- **`--slug` and `--slugs` both present** (singular + plural combined) must union, not override. → Task 1 test.

---

### Task 1: `backfill-images.ts` accepts multiple slugs

**Files:**
- Modify: `scripts/backfill-images.ts` (`parseSlug`/`parseArgs` ~`:31-56`, `collectImageUrls` ~`:66-83`, `main` enumerate/log ~`:117-134`)
- Test: `test/unit/backfill-images-slug-filter.test.js` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function parseSlugs(argv: string[]): string[]` — union of comma-split `--slug` and `--slugs` values, trimmed, blanks dropped, de-duplicated, order-preserving. `[]` when neither present.
  - `export function collectImageUrls(publicDir: string, slugs?: string[]): Map<string, string>` — when `slugs` is a non-empty array, scan only those `tutorials/<slug>/index.html`; when `undefined`/empty, scan the whole `tutorials/` dir (unchanged default). An unknown slug contributes nothing (its index.html is absent) — no throw.
  - `Args.slugs: string[]` replaces `Args.slug?: string` on the parsed-args object.

- [ ] **Step 1: Write the failing test** `test/unit/backfill-images-slug-filter.test.js`

```js
import { describe, it, expect } from 'vitest';
import { parseSlugs } from '../../scripts/backfill-images.ts';

describe('parseSlugs (#2805)', () => {
  it('splits a comma list from --slug', () => {
    expect(parseSlugs(['--slug', 'a,b,c'])).toEqual(['a', 'b', 'c']);
  });
  it('reads --slugs the same way', () => {
    expect(parseSlugs(['--slugs', 'a,b'])).toEqual(['a', 'b']);
  });
  it('unions --slug and --slugs, de-duping and preserving order', () => {
    expect(parseSlugs(['--slug', 'a', '--slugs', 'b,a,c'])).toEqual(['a', 'b', 'c']);
  });
  it('trims whitespace and drops blanks', () => {
    expect(parseSlugs(['--slug', ' a , , b '])).toEqual(['a', 'b']);
  });
  it('returns [] when neither flag is present', () => {
    expect(parseSlugs([])).toEqual([]);
  });
  it('returns [] for an empty value (whole-catalog default)', () => {
    expect(parseSlugs(['--slug', ''])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/backfill-images-slug-filter.test.js`
Expected: FAIL — `parseSlugs` is not exported.

- [ ] **Step 3: Implement `parseSlugs` and thread it through**

In `scripts/backfill-images.ts`:
- Add `export function parseSlugs(argv: string[]): string[]` that reads BOTH `--slug` and `--slugs` values (each may be comma-separated), concatenates, `.split(',')`, `.map(trim)`, `.filter(Boolean)`, de-dupes via `new Set` while preserving first-seen order.
- Keep `parseSlug` exported too (unused by main after this, but a thin wrapper or leave as-is — do not break any importer; grep shows none besides tests).
- Change `Args.slug?: string` → `Args.slugs: string[]`; set `slugs: parseSlugs(argv)` in `parseArgs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/backfill-images-slug-filter.test.js`
Expected: PASS (parseSlugs block).

- [ ] **Step 5: Write the failing `collectImageUrls` multi-slug test**

Append to the same test file. Build a temp fixture dir (use `node:fs` `mkdtempSync` + write two `tutorials/<slug>/index.html` files each containing one distinct `/img-cdn?u=…` URL and a third slug dir NOT requested):

```js
import { collectImageUrls } from '../../scripts/backfill-images.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bf-'));
  const mk = (slug, u) => {
    mkdirSync(join(root, 'tutorials', slug), { recursive: true });
    writeFileSync(join(root, 'tutorials', slug, 'index.html'),
      `<img src="/img-cdn?u=${encodeURIComponent(u)}">`);
  };
  mk('slug-a', 'https://raw.githubusercontent.com/x/a.png');
  mk('slug-b', 'https://raw.githubusercontent.com/x/b.png');
  mk('slug-c', 'https://raw.githubusercontent.com/x/c.png');
  return root;
}

describe('collectImageUrls multi-slug (#2805)', () => {
  it('scans only the requested slugs when given an array', () => {
    const m = collectImageUrls(fixture(), ['slug-a', 'slug-b']);
    expect([...m.values()].sort()).toEqual(['slug-a', 'slug-b']);
  });
  it('scans the whole dir when slugs is empty/undefined', () => {
    expect(collectImageUrls(fixture(), []).size).toBe(3);
    expect(collectImageUrls(fixture()).size).toBe(3);
  });
  it('yields nothing (no throw) for an unknown slug — best-effort warm', () => {
    const m = collectImageUrls(fixture(), ['does-not-exist']);
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run --project unit test/unit/backfill-images-slug-filter.test.js`
Expected: FAIL — `collectImageUrls` still takes a single `slug?: string`.

- [ ] **Step 7: Implement `collectImageUrls(publicDir, slugs?: string[])`**

Change the signature and the one branch (`:72`): `const list = slugs?.length ? slugs : readdirSync(tutorialsDir);`. Rest of the loop is unchanged (it already iterates a list). Update `main` (`:129-130`): `const slugList = args.slugs; let urlToSlug = collectImageUrls(publicDir, slugList.length ? slugList : undefined);` and the enumerate log to show `(slugs: a,b)` when scoped.

- [ ] **Step 8: Run the file + the full unit project**

Run: `npx vitest run --project unit test/unit/backfill-images-slug-filter.test.js`
Expected: PASS (all).
Run: `npx vitest run --project unit`
Expected: PASS, no regressions (especially `publish-content-slug-filter.test.js`, `publish-image-warm.test.js`).

- [ ] **Step 9: Dry-run proof against built HTML (manual, if `hugo/public/tutorials` exists)**

Run: `CAP_BASE_URL=http://x npx tsx scripts/backfill-images.ts --slug "a,b" --dry-run`
Expected: log reads `(slugs: a,b)` and a small `Found N unique image URL(s)`, NOT 21,712. (Skip if no local Hugo build; note in PR that CI proves it.)

- [ ] **Step 10: Commit**

```bash
git add scripts/backfill-images.ts test/unit/backfill-images-slug-filter.test.js
git commit -m "fix(#2805): backfill-images.ts accepts comma-list --slug/--slugs"
```

---

### Task 2: Workflow image step passes the plural slug list

**Files:**
- Modify: `.github/workflows/rebuild-content.yml` — image step `env` + `run` (~`:1031-1039`); comment block (~`:1013-1029`).

**Interfaces:**
- Consumes: `steps.mode.outputs.dispatch_slugs` (already emitted, `:290`), `inputs.slugs`, `inputs.slug`, `steps.mode.outputs.dispatch_slug`. Task 1's `backfill-images.ts` `--slug`/`--slugs` CLI.
- Produces: nothing downstream depends on this step.

- [ ] **Step 1: Add `REFRESH_SLUGS` env and pass it to the script**

In the `Refresh tutorial images (slug-targeted)` step, add alongside the existing `REFRESH_SLUG`:

```yaml
          REFRESH_SLUG:    ${{ inputs.slug || steps.mode.outputs.dispatch_slug }}
          REFRESH_SLUGS:   ${{ inputs.slugs || steps.mode.outputs.dispatch_slugs }}
        run: npx tsx scripts/backfill-images.ts --slug "$REFRESH_SLUG" --slugs "$REFRESH_SLUGS"
```

(Mirrors the publish step's `PUBLISH_SLUG` + `PUBLISH_SLUGS` pairing at `:948`/`:955`. `backfill-images.ts` unions both and ignores blanks, so passing both empty = whole-catalog, exactly as before; passing either populates the scope.)

- [ ] **Step 2: Update the comment block**

In the `#2288 / #2346` comment block above the step, add one line noting `REFRESH_SLUG`+`REFRESH_SLUGS` now derive from `inputs.slug`+`inputs.slugs` (and the `dispatch_slug`/`dispatch_slugs` equivalents), so a plural-`slugs` dispatch scopes the warm instead of falling back to the full catalog (the #2805 361s regression).

- [ ] **Step 3: Validate the workflow YAML parses**

Run: `npx yaml-lint .github/workflows/rebuild-content.yml 2>/dev/null || python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/rebuild-content.yml')); print('YAML OK')"`
Expected: `YAML OK` (or yaml-lint clean). If neither tool is available, confirm with `yq '.jobs.rebuild.steps[] | select(.name == "Refresh tutorial images (slug-targeted)")' .github/workflows/rebuild-content.yml` prints the step with both env keys.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/rebuild-content.yml
git commit -m "fix(#2805): image-refresh step honours plural slugs input (no whole-catalog fallback)"
```

---

### Task 3: Doc touch-ups

**Files:**
- Modify: `docs/developers/reference/publish-performance-spike-2802.md` (Finding 3 image bullet).
- Modify: `CLAUDE.md` Top Gotchas (optional one-liner) — SKIP unless a reviewer asks; keep the diff tight.

**Interfaces:** none.

- [ ] **Step 1: Update the spike doc's image bullet**

Change the Finding 3 "Image-refresh is NOT innocent" bullet to note the root cause (plural `slugs` input not threaded to `REFRESH_SLUG`) and that #2805 fixed it by passing `REFRESH_SLUGS`. One or two sentences; don't rewrite the finding.

- [ ] **Step 2: Commit**

```bash
git add docs/developers/reference/publish-performance-spike-2802.md
git commit -m "docs(#2805): record image-refresh root cause + fix in spike Finding 3"
```

---

## Notes for the whole-branch review

- The publish half of the design doc's scope was found already shipped on `origin/DEV`; this plan implements only the remaining image half plus docs. The design doc records that.
- CI proof: after merge to DEV, dispatch `rebuild-content.yml -f mode=slug-targeted -f slugs=<one-slug>` and confirm the image step logs `(slugs: …)` + a small count, step wall-clock ≈ seconds (not 361s). Attach to the PR.
