# Slug-Targeted Island Fingerprint Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make slug-targeted `rebuild-content.yml` runs bake fingerprinted island `<script src>` paths (not bare `/js/<name>.js`) so single-tutorial hotfixes publish HTML whose interactive islands actually load.

**Architecture:** Un-gate the four island-build steps (`hugo-apps` install, Build Vue apps, Build island manifest, homepage fingerprint guard) so they run in slug-targeted mode too — making them prerequisites of the already-unconditional Hugo build. Then extend the existing `check-approuter-assets.cjs` local-hugo guard (currently CSS-only) to also probe the now-hashed island JS against the target approuter before the HANA publish, turning a silent 404 into a loud pre-publish failure.

**Tech Stack:** GitHub Actions workflow YAML, Node.js (`.cjs` guard script, native `fetch`), Vitest (unit, spawn-based HTTP tests), `yaml` npm package (workflow-gating assertion test).

## Global Constraints

- Slug hashes are content-deterministic from `hugo-apps/` source; a slug-mode island build yields the same hashes as the deployed bundles.
- `island-src.html` fallback contract (`| default (printf "/js/%s.js" $name)`) is UNCHANGED — the fix supplies the manifest so the fallback isn't hit, it does not alter the partial.
- The unhashed fallback path (`/js/<name>.js`) must NEVER be probed by the guard (matches existing `-[A-Za-z0-9_-]{8,}\.js$` hashed-bundle convention, #1604).
- Leave the whole-site steps slug-gated: vendor-WASM (`vendor:mediapipe`), `/explore` bundle, `copy-joule-vendor`, and the homepage/verb/shelf data fetches. Only the four island steps change.
- PR over direct merge (repo convention); MTA version bump NOT required (CI-workflow + guard-script only, no `.deploy/mta.yaml` change).
- Windows/CRLF: the guard is `.cjs` with LF line endings; keep LF.
- Test command: `npm test` = `vitest run --project unit`. Single file: `npx vitest run --project unit <path>` from repo root.

---

### Task 1: Extend `check-approuter-assets.cjs` local-hugo mode to probe hashed island JS

**Files:**
- Modify: `scripts/check-approuter-assets.cjs` (local-hugo `main()` block, lines ~413–505; arg parsing ~94–108; header comment ~28–35)
- Test: `test/unit/check-approuter-assets.test.ts` (add cases to the existing `#1622` describe block)

**Interfaces:**
- Consumes: existing `extractAssetRefs(html, { includeJs })` (line 117) — already collects hashed `/js/*-<hash>.js` when `includeJs:true`; existing `probe(url)` (line 173); existing `parseArgs` (line 94).
- Produces: a new CLI flag `--check-islands` (boolean) that makes local-hugo mode ALSO collect + probe hashed island JS refs. Consumed by Task 3 (the workflow step passes it).

- [ ] **Step 1: Write the failing tests**

Add these cases inside the existing `describe('check-approuter-assets (rebuild-content slug guard, #1622)', …)` block in `test/unit/check-approuter-assets.test.ts`. The existing `tutorialHtml()` helper (line 45) already emits `<script src=/js/tutorial-DBCzDHRV.js>` (hashed) and `<script src=/js/joule.js>` (unhashed fallback), so no helper change is needed.

```typescript
  it('probes hashed island JS when --check-islands is set and fails on a 404 bundle', async () => {
    SERVED.clear();
    SERVED.add('/css/only.css');
    // hashed island bundle tutorialHtml() emits is NOT served → must fail
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial', '--check-islands']);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toContain('/js/tutorial-DBCzDHRV.js');
      // unhashed fallback must never be blamed
      expect(out).not.toMatch(/joule\.js.*(404|MISSING|not served)/i);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('passes with --check-islands when both css and hashed island JS are served', async () => {
    SERVED.clear();
    SERVED.add('/css/only.css');
    SERVED.add('/js/tutorial-DBCzDHRV.js');
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial', '--check-islands']);
      expect(r.status).toBe(0);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('does NOT probe island JS without --check-islands (back-compat, css-only)', async () => {
    SERVED.clear();
    SERVED.add('/css/only.css'); // hashed js NOT served, but flag absent → ignored
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial']);
      expect(r.status).toBe(0);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit test/unit/check-approuter-assets.test.ts -t "check-islands|island JS"`
Expected: the two `--check-islands` cases FAIL (flag is ignored, so status is 0 not 1 / assets not probed). The back-compat case may already pass — that's fine; it guards Step 3.

- [ ] **Step 3: Add the `--check-islands` flag to `parseArgs`**

In `scripts/check-approuter-assets.cjs`, inside `parseArgs` (line 94), add alongside the other flags (e.g. after the `--advisory` line 105):

```javascript
    else if (a === '--check-islands') out.checkIslands = true;
```

- [ ] **Step 4: Collect hashed island refs in local-hugo mode**

In `main()`, find the local-hugo ref-gathering loop (lines ~437–444):

```javascript
  const refToPages = new Map(); // cssPath -> Set(slug)
  for (const { slug, file } of pages) {
    const html = fs.readFileSync(file, 'utf8');
    for (const ref of extractAssetRefs(html)) {
      if (!refToPages.has(ref)) refToPages.set(ref, new Set());
      refToPages.get(ref).add(slug);
    }
  }
```

Change the `extractAssetRefs(html)` call to forward the flag:

```javascript
  const refToPages = new Map(); // assetPath -> Set(slug)  (css + optionally hashed island js)
  for (const { slug, file } of pages) {
    const html = fs.readFileSync(file, 'utf8');
    for (const ref of extractAssetRefs(html, { includeJs: !!args.checkIslands })) {
      if (!refToPages.has(ref)) refToPages.set(ref, new Set());
      refToPages.get(ref).add(slug);
    }
  }
```

- [ ] **Step 5: Fix the "no refs" guard and log line to not say "css" when islands are in scope**

The `!refs.length` die-message (line 448) and the probing log (line 454) hardcode `/css`. Update them so they stay accurate when islands are probed.

Replace the `if (!refs.length)` block (lines 447–452):

```javascript
  if (!refs.length) {
    const kind = args.checkIslands ? '/css or hashed island /js' : '/css';
    die(
      `the rendered tutorial page(s) reference no ${kind} assets — the head partial changed unexpectedly.\n` +
        `             Scanned: ${pages.map((p) => p.slug).join(', ')}`,
    );
  }
```

Replace the probing `console.log` (lines 454–459):

```javascript
  console.log(
    C.dim(
      `[check-approuter-assets] probing ${refs.length} ${args.checkIslands ? 'css+island-js' : '/css'} asset(s) against ${approuterUrl} ` +
        `(pages: ${pages.length === 1 ? pages[0].slug : pages.length + ' tutorials'})`,
    ),
  );
```

- [ ] **Step 6: Update the header SCOPE comment**

The `LOCAL-HUGO MODE — CSS only, on purpose:` block (lines 28–35) is now stale. Replace it with:

```javascript
// LOCAL-HUGO MODE — CSS always; hashed island JS with --check-islands:
//   Hugo computes CSS content-hashes deterministically from committed source on
//   EVERY build, so the /css hrefs match what a full build ships. Island JS is
//   content-hashed via the Vite build + hugo/data/island_manifest.json. As of the
//   slug-targeted island-build fix (2026-08), that manifest IS rebuilt in every
//   content-producing mode, so locally-rendered HTML carries hashed island refs
//   too — pass --check-islands to probe them (the rebuild-content slug guard does).
//   The unhashed fallback (/js/name.js) is never probed (it can't fingerprint-drift).
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project unit test/unit/check-approuter-assets.test.ts`
Expected: PASS (all existing #1622 + #1678 cases plus the 3 new island cases). Confirms back-compat (css-only without the flag) is intact.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-approuter-assets.cjs test/unit/check-approuter-assets.test.ts
git commit -m "feat(guard): probe hashed island JS in check-approuter-assets local-hugo mode (--check-islands)"
```

---

### Task 2: Un-gate the four island-build steps in `rebuild-content.yml`

**Files:**
- Modify: `.github/workflows/rebuild-content.yml`
  - "Install dependencies" step, shell gate (lines ~291–295)
  - "Build Vue apps" step condition (line ~450)
  - "Build island manifest" step condition (line ~469)
  - "Guard - homepage islands fingerprinted" step condition (line ~574)
- Test: `test/unit/rebuild-content-island-gating.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1 (independent workflow change).
- Produces: a workflow where these four steps run for `slug-targeted` mode. Task 3 relies on "Build island manifest" running before the guard.

- [ ] **Step 1: Write the failing test**

Create `test/unit/rebuild-content-island-gating.test.ts`. It parses the workflow YAML and asserts the four steps are NOT gated against slug-targeted, while a whole-site step (Build vendor WASM) still is. This locks the fix and prevents a future re-gating regression.

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WF = join(__dirname, '..', '..', '.github', 'workflows', 'rebuild-content.yml');

// The `on:` key parses to JS boolean true, but we only read jobs.*.steps here.
const wf = parse(readFileSync(WF, 'utf8')) as {
  jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string }> }>;
};

function findStep(name: string) {
  for (const job of Object.values(wf.jobs)) {
    const s = job.steps.find((st) => st.name === name);
    if (s) return s;
  }
  return undefined;
}

describe('rebuild-content.yml — island build runs in slug-targeted mode', () => {
  // These four steps produce the island bundles + manifest that island-src.html
  // needs to bake hashed /js paths. If any is gated against slug-targeted, a
  // single-tutorial rebuild bakes bare /js/<name>.js that 404s on the approuter.
  it.each([
    'Build Vue apps',
    'Build island manifest',
    'Guard - homepage islands fingerprinted',
  ])('step "%s" is not skipped for slug-targeted', (name) => {
    const step = findStep(name);
    expect(step, `step "${name}" not found`).toBeDefined();
    // No condition, or a condition that does NOT exclude slug-targeted.
    if (step!.if) {
      expect(step!.if).not.toMatch(/!=\s*'slug-targeted'/);
      expect(step!.if).not.toMatch(/effective_mode\s*!=\s*'slug-targeted'/);
    }
  });

  it('hugo-apps deps are installed unconditionally (no slug-targeted skip branch)', () => {
    const step = findStep('Install dependencies');
    expect(step, 'Install dependencies step not found').toBeDefined();
    expect(step!.run).toContain('npm --prefix hugo-apps install');
    // the old skip branch keyed on MODE != slug-targeted must be gone
    expect(step!.run).not.toMatch(/!=\s*"slug-targeted"/);
  });

  it('whole-site vendor WASM step is STILL gated against slug-targeted (scope guard)', () => {
    const step = findStep('Build vendor WASM bundles');
    expect(step, 'Build vendor WASM bundles step not found').toBeDefined();
    expect(step!.if).toMatch(/!=\s*'slug-targeted'/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit test/unit/rebuild-content-island-gating.test.ts`
Expected: FAIL — the three island steps currently carry `if: … != 'slug-targeted'`, and Install dependencies still has the `!= "slug-targeted"` skip branch.

- [ ] **Step 3: Un-gate the `hugo-apps` install**

In `.github/workflows/rebuild-content.yml`, the "Install dependencies" step (lines ~278–295) currently reads:

```yaml
          npm ci --prefer-offline --no-audit --no-fund
          # hugo-apps deps are ONLY consumed by the Build Vue apps / explore /
          # display / admin-SPA steps, all of which are skipped in slug-targeted
          # mode — so don't install them there (#1278). Catalog-only also skips
          # those builds, but it's a fast admin path already; keep it simple and
          # only special-case slug-targeted.
          if [ "$MODE" != "slug-targeted" ]; then
            npm --prefix hugo-apps install
          else
            echo "::notice::slug-targeted — skipping hugo-apps install (no Vue/SPA builds run)"
          fi
```

Replace the comment + `if` block with an unconditional install:

```yaml
          npm ci --prefer-offline --no-audit --no-fund
          # hugo-apps deps are needed by the island Vite build, which now runs in
          # EVERY content-producing mode (including slug-targeted) so island-src.html
          # can bake hashed /js paths instead of bare /js/<name>.js that 404 on the
          # approuter. (Was slug-skipped pre-2026-08 / #1278; that caused the
          # step-6 validation-island outage on trial-get-productive-with-joule-work.)
          npm --prefix hugo-apps install
```

The `MODE:` env on this step (line 280) is now unused by the run block; leave it (harmless) or remove it — removing keeps the step clean:

Remove these two lines from the step's `env:` (lines ~279–280) IF present and unused elsewhere in the step:

```yaml
        env:
          MODE: ${{ steps.mode.outputs.effective_mode }}
```

(Keep `NODE_AUTH_TOKEN`. If removing `MODE` leaves `env:` with only `NODE_AUTH_TOKEN`, keep `env:` and that one entry.)

- [ ] **Step 4: Un-gate "Build Vue apps"**

Find (line ~450):

```yaml
      - name: Build Vue apps
        if: ${{ steps.mode.outputs.effective_mode != 'slug-targeted' }}
        run: npm --prefix hugo-apps run build
```

Remove the `if:` line so it runs in all modes:

```yaml
      - name: Build Vue apps
        # Runs in EVERY content-producing mode: the emitted Vite manifest
        # (hugo/static/js/.vite/manifest.json) is what build:island-manifest turns
        # into hugo/data/island_manifest.json → hashed island <script src>. Skipping
        # it in slug-targeted baked bare /js/<name>.js that 404s on the approuter.
        run: npm --prefix hugo-apps run build
```

- [ ] **Step 5: Un-gate "Build island manifest"**

Find (line ~469):

```yaml
      - name: Build island manifest
        if: ${{ steps.mode.outputs.effective_mode != 'slug-targeted' }}
        run: npm run build:island-manifest
```

Remove the `if:` line:

```yaml
      - name: Build island manifest
        # Runs in EVERY content-producing mode (see "Build Vue apps"). Writes
        # hugo/data/island_manifest.json, read by island-src.html at render time.
        run: npm run build:island-manifest
```

- [ ] **Step 6: Un-gate the homepage fingerprint guard**

Find (line ~574):

```yaml
      - name: Guard - homepage islands fingerprinted
        if: ${{ steps.mode.outputs.effective_mode != 'slug-targeted' }}
        run: node scripts/check-hugo-island-fingerprint.cjs --hugo-dir hugo/public
```

Remove the `if:` line:

```yaml
      - name: Guard - homepage islands fingerprinted
        # Now that the island manifest is built in slug-targeted too, this guard is
        # meaningful in every mode: fail loud if index.html bakes only bare island
        # paths while a Vite manifest exists.
        run: node scripts/check-hugo-island-fingerprint.cjs --hugo-dir hugo/public
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/rebuild-content-island-gating.test.ts`
Expected: PASS (all cases).

- [ ] **Step 8: Sanity-check the YAML parses and the diff is minimal**

Run: `node -e "const {parse}=require('yaml');parse(require('fs').readFileSync('.github/workflows/rebuild-content.yml','utf8'));console.log('yaml ok')"`
Then: `git --no-ext-diff diff -- .github/workflows/rebuild-content.yml`
Expected: `yaml ok`, and the diff shows only the four steps changed (three `if:` removals + install de-branching + comment updates), nothing in the whole-site steps.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/rebuild-content.yml test/unit/rebuild-content-island-gating.test.ts
git commit -m "fix(ci): build island manifest in slug-targeted rebuilds so islands bake hashed /js paths"
```

---

### Task 3: Wire `--check-islands` into the slug-targeted approuter guard step

**Files:**
- Modify: `.github/workflows/rebuild-content.yml` — "Guard - approuter serves referenced CSS (slug-targeted)" step (lines ~588–612)
- Test: extend `test/unit/rebuild-content-island-gating.test.ts` from Task 2

**Interfaces:**
- Consumes: `--check-islands` flag from Task 1; the island manifest built by Task 2 (so the rendered HTML carries hashed refs to probe).
- Produces: the slug guard now probes island JS against the approuter before publish.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/rebuild-content-island-gating.test.ts` (reuses the `wf`/`findStep` already defined at module scope):

```typescript
describe('rebuild-content.yml — approuter guard probes islands in slug mode', () => {
  it('the slug-targeted approuter asset guard passes --check-islands', () => {
    const step = findStep('Guard - approuter serves referenced CSS (slug-targeted)');
    expect(step, 'slug approuter guard step not found').toBeDefined();
    expect(step!.run).toContain('check-approuter-assets.cjs');
    expect(step!.run).toContain('--check-islands');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit test/unit/rebuild-content-island-gating.test.ts -t "check-islands"`
Expected: FAIL — the guard step's `run` does not yet contain `--check-islands`.

- [ ] **Step 3: Add the flag to the guard invocation**

Find the step (lines ~601–612):

```yaml
      - name: Guard - approuter serves referenced CSS (slug-targeted)
        if: ${{ steps.mode.outputs.effective_mode == 'slug-targeted' }}
        env:
          APPROUTER_URL: ${{ steps.url.outputs.approuter_url }}
          PUBLISH_SLUG: ${{ inputs.slug || steps.mode.outputs.dispatch_slug }}
        run: |
          node scripts/check-approuter-assets.cjs \
            --approuter-url "$APPROUTER_URL" \
            --hugo-dir hugo/public
```

Rename it (it's no longer CSS-only) and add `--check-islands`:

```yaml
      - name: Guard - approuter serves referenced CSS + islands (slug-targeted)
        if: ${{ steps.mode.outputs.effective_mode == 'slug-targeted' }}
        env:
          APPROUTER_URL: ${{ steps.url.outputs.approuter_url }}
          PUBLISH_SLUG: ${{ inputs.slug || steps.mode.outputs.dispatch_slug }}
        run: |
          node scripts/check-approuter-assets.cjs \
            --approuter-url "$APPROUTER_URL" \
            --hugo-dir hugo/public \
            --check-islands
```

Also update the block comment above the step (lines ~595–597, the "CSS-only on purpose … JS island bundles … not rebuilt in slug mode" rationale) to state islands are now rebuilt in slug mode and are probed here:

```yaml
      # islands (hashed /js/<name>-<hash>.js) too: the island manifest is now built
      # in slug-targeted mode (see "Build island manifest"), so the rendered HTML
      # carries hashed island refs. --check-islands probes them against the
      # approuter alongside /css; a bare /js/<name>.js fallback is never probed.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/rebuild-content-island-gating.test.ts`
Expected: PASS (all Task 2 + Task 3 cases).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/rebuild-content.yml test/unit/rebuild-content-island-gating.test.ts
git commit -m "fix(ci): slug-targeted approuter guard probes hashed island JS (--check-islands)"
```

---

### Task 4: Full unit-suite green + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the touched unit tests together**

Run: `npx vitest run --project unit test/unit/check-approuter-assets.test.ts test/unit/rebuild-content-island-gating.test.ts`
Expected: PASS, no skips.

- [ ] **Step 2: Confirm no regression in the fingerprint guard's own suite (if present)**

Run: `npx vitest run --project unit test/unit/check-hugo-island-fingerprint*.test.* 2>/dev/null || echo "no dedicated suite — skip"`
Expected: PASS or the skip notice.

- [ ] **Step 3: Push the branch and open a draft PR**

```bash
git push -u origin worktree-slug-targeted-island-fingerprint
gh pr create --draft --title "Slug-targeted rebuilds bake fingerprinted island paths" \
  --body "Fixes step-6 validation island (and all islands) not rendering on tutorials first published via a slug-targeted rebuild. Un-gates the island Vite build + manifest + fingerprint guard for slug-targeted mode, and extends check-approuter-assets.cjs to probe hashed island JS before publish. Spec: docs/superpowers/specs/2026-08-12-slug-targeted-island-fingerprint-design.md"
```

- [ ] **Step 4: Post-merge manual verification (DEV, then remediate live tutorial)**

After merge to `main`, trigger a slug-targeted rebuild for the affected tutorial and confirm the served HTML references the hashed bundle and the asset resolves:

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f slug=trial-get-productive-with-joule-work
# after it completes (~2 min):
curl -s "https://tutorial-system-prod-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/content/tutorials/trial-get-productive-with-joule-work" \
  | grep -oE 'src=/js/validation-[A-Za-z0-9_-]+\.js|src=/js/validation\.js'
```
Expected: a hashed `src=/js/validation-<hash>.js` ref (NOT bare `/js/validation.js`), and the step-6 question renders in a browser.

---

## Self-Review

**Spec coverage:**
- "Un-gate the four steps" → Task 2 (all four) ✓
- "Build whole island set, not subset; whole-site steps stay gated" → Task 2 Step 8 diff check + the vendor-WASM scope-guard test ✓
- "Extend check-approuter-assets.cjs to probe hashed island JS in local-hugo mode, behind a flag, excluding bare fallback" → Task 1 (flag `--check-islands`, reuses `includeJs`, hashed-only regex) ✓
- "Fail loud on 404 (not warn-only)" → Task 1 reuses existing `missing.length → process.exit(1)` local-hugo path; test asserts `status === 1` ✓
- "Testing: fixture tutorial page with validation island; guard-chain sanity; manual DEV+PROD" → Task 1 island tests, Task 4 Steps 2 & 4 ✓
- "PR over direct merge; no MTA bump" → Task 4 Step 3 (draft PR); no `.deploy/mta.yaml` touched ✓

**Placeholder scan:** No TBD/TODO; every code step has literal content. ✓

**Type consistency:** Flag name `--check-islands` → `args.checkIslands` used identically in Tasks 1 and 3. `extractAssetRefs(html, { includeJs })` matches the existing signature (line 117). `findStep`/`wf` defined once at module scope in Task 2, reused in Task 3. ✓

**Note for the implementer:** `check-hugo-island-fingerprint.cjs` gates on the Vite manifest existing; with Task 2, the manifest now exists in slug-mode builds, so the guard becomes active there — this is intended and covered by Task 2 Step 6.
