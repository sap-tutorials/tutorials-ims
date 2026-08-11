# Asset-Hash Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain prior content-hashed JS/CSS island bundles across deploys for ≥ the HTML edge-cache TTL, so edge-cached HTML never 404s on a bundle hash that a later deploy deleted.

**Architecture:** A build-time step, run **after** the Hugo build (which both copies Vite's hashed JS into `hugo/public/js` and emits Hugo-fingerprinted CSS into `hugo/public/css`), unions the current build's hashed JS+CSS with recent prior bundles. Prior bundles are discovered from a small `_retained-assets.json` manifest that the currently-deployed approuter serves, downloaded from that same approuter into `hugo/public`, and re-emitted (pruned by age) so the set rolls forward deploy-over-deploy. `hugo/public` is copied verbatim into the approuter droplet, so retained bundles ship. Content-hashed filenames are immutable, so unioning is always safe.

**Tech Stack:** Node.js CJS build scripts (native `fetch`), Vitest unit tests, npm scripts, mbt `before-all` (root `mta.yaml`).

**Workstream:** A of the [2026-08-11 spec](../specs/2026-08-11-approuter-content-serving-and-asset-retention-design.md). Standalone and ship-first; Workstream B (HANA/CAP page serving) is a separate plan.

## Global Constraints

- Node.js: use native `fetch` (no axios/node-fetch). CJS (`.cjs`) build scripts, matching `scripts/*.cjs`.
- Prefer `fetch` with an `AbortController` timeout; never let a network failure fail the build — retention is **fail-open** (warn, proceed with whatever was gathered).
- Retention window: **48 hours** (≥ the ~24h `s-maxage` on HTML, doubled for overlapping deploys/skew). Configurable via `RETENTION_WINDOW_HOURS` env, default `48`.
- Hashed-bundle filename shapes — detect **both**: Vite islands `<name>-<hash>.<js|css>` (dash separator, `<hash>` base62 ≥ 8 chars, effectively always containing an uppercase letter or digit) **and** Hugo-fingerprinted CSS `<name>.<hash>.css` (dot separator, `<hash>` a long lowercase-hex SHA, ≥ 8 chars). Committed unhashed files (`consent-trustarc.js`, `consent.js`, `featured-rail.js`, bare `ui5-bootstrap.js`) must NOT match.
- Injection point: retention runs **after** `build:hugo` / the Hugo build, operating on `hugo/public/js` and `hugo/public/css`, writing the manifest to `hugo/public/_retained-assets.json`. This is the only stage where both Vite-hashed JS and Hugo-fingerprinted CSS coexist, and `hugo/public` is what the approuter builder copies to the droplet.
- Dual build paths must both be wired: local `build:all` (→ `.deploy/mta.yaml`) and CI root `mta.yaml` before-all (→ deploy.yml).
- Windows dev host: scripts run under Git Bash / Node; use `path` join, never hard-coded `/`.

---

### Task 1: Pure retention merge/prune function

**Files:**
- Create: `scripts/lib/asset-retention.cjs`
- Test: `test/unit/asset-retention.test.js`

**Interfaces:**
- Produces: `mergeRetention({ currentFiles, retainedManifest, nowMs, windowMs }) => { toDownload, manifest }`
  - `currentFiles`: `string[]` — hashed filenames present in this build (e.g. `["embed-Coqc9fp6.js","sap-fundamental-abc12345.css"]`).
  - `retainedManifest`: `Array<{ file: string, firstSeenMs: number }>` — from the live approuter (may be `[]`).
  - `nowMs`: `number`, `windowMs`: `number`.
  - Returns `toDownload: string[]` (carried files not in the current build) and `manifest: Array<{ file, firstSeenMs }>` (current ∪ in-window-carried; expired dropped).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/asset-retention.test.js
import { describe, it, expect } from 'vitest';
import { mergeRetention } from '../../scripts/lib/asset-retention.cjs';

const HOUR = 3600_000;
const now = 1_000_000_000_000;
const windowMs = 48 * HOUR;

describe('mergeRetention', () => {
  it('empty retained: manifest = current stamped now, nothing to download', () => {
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: [], nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]);
    expect(r.manifest).toEqual([{ file: 'a-11111111.js', firstSeenMs: now }]);
  });

  it('carries an in-window prior bundle not in the current build', () => {
    const retained = [{ file: 'old-22222222.js', firstSeenMs: now - 10 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual(['old-22222222.js']);
    expect(r.manifest).toContainEqual({ file: 'old-22222222.js', firstSeenMs: now - 10 * HOUR });
    expect(r.manifest).toContainEqual({ file: 'a-11111111.js', firstSeenMs: now });
  });

  it('prunes an expired prior bundle', () => {
    const retained = [{ file: 'stale-33333333.js', firstSeenMs: now - 60 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]);
    expect(r.manifest.find(e => e.file === 'stale-33333333.js')).toBeUndefined();
  });

  it('preserves firstSeenMs for a file still in the current build (no reset, no download)', () => {
    const retained = [{ file: 'a-11111111.js', firstSeenMs: now - 5 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]);
    expect(r.manifest).toEqual([{ file: 'a-11111111.js', firstSeenMs: now - 5 * HOUR }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/asset-retention.test.js`
Expected: FAIL — `mergeRetention is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/asset-retention.cjs
'use strict';

/**
 * Compute the retained bundle set for a build.
 * Immutable content-hashed filenames → unioning is always safe.
 * @param {{currentFiles:string[], retainedManifest:{file:string,firstSeenMs:number}[], nowMs:number, windowMs:number}} args
 * @returns {{toDownload:string[], manifest:{file:string,firstSeenMs:number}[]}}
 */
function mergeRetention({ currentFiles, retainedManifest, nowMs, windowMs }) {
  const current = new Set(currentFiles);
  const priorByFile = new Map((retainedManifest || []).map(e => [e.file, e.firstSeenMs]));

  // Current files keep their original firstSeenMs if we've seen them before.
  const manifest = currentFiles.map(file => ({
    file,
    firstSeenMs: priorByFile.has(file) ? priorByFile.get(file) : nowMs,
  }));

  const toDownload = [];
  for (const { file, firstSeenMs } of retainedManifest || []) {
    if (current.has(file)) continue;                 // already in this build
    if (nowMs - firstSeenMs > windowMs) continue;    // expired → prune
    manifest.push({ file, firstSeenMs });
    toDownload.push(file);
  }
  return { toDownload, manifest };
}

module.exports = { mergeRetention };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/asset-retention.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/asset-retention.cjs test/unit/asset-retention.test.js
git commit -m "feat(retention): pure merge/prune for content-hashed bundle retention"
```

---

### Task 2: CLI wrapper — glob, fetch prior manifest, download carried bundles, write manifest

**Files:**
- Create: `scripts/retain-asset-bundles.cjs`
- Test: `test/unit/retain-asset-bundles.test.js`

**Interfaces:**
- Consumes: `mergeRetention` from `scripts/lib/asset-retention.cjs` (Task 1).
- Produces: an executable script `node scripts/retain-asset-bundles.cjs` that reads `--js-dir` (default `hugo/static/js`), `--css-dir` (default `hugo/static/css`), `--manifest-out` (default `hugo/static/_retained-assets.json`), env `APPROUTER_URL` (optional) and `RETENTION_WINDOW_HOURS` (default `48`). Exports `collectHashedFiles(dir)` and `main(opts)` for testing.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/retain-asset-bundles.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHashedFiles } from '../../scripts/retain-asset-bundles.cjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ret-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('collectHashedFiles', () => {
  it('returns only hashed bundle filenames, ignoring unhashed and non-js/css', () => {
    writeFileSync(join(dir, 'embed-Coqc9fp6.js'), '');
    writeFileSync(join(dir, 'consent-trustarc.js'), '');   // unhashed → ignored
    writeFileSync(join(dir, 'notes.txt'), '');             // non-bundle → ignored
    const got = collectHashedFiles(dir).sort();
    expect(got).toEqual(['embed-Coqc9fp6.js']);
  });

  it('returns [] for a missing directory', () => {
    expect(collectHashedFiles(join(dir, 'nope'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/retain-asset-bundles.test.js`
Expected: FAIL — `collectHashedFiles is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/retain-asset-bundles.cjs
'use strict';

const { readdirSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { mergeRetention } = require('./lib/asset-retention.cjs');

// <name>-<hash>.<js|css>, hash >= 8 chars of [A-Za-z0-9_-]. Mirrors deploy-mta.cjs Step 2.5.
const HASHED_RE = /-[A-Za-z0-9_-]{8,}\.(js|css)$/;

function collectHashedFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => HASHED_RE.test(f));
}

function parseArgs(argv) {
  const out = { jsDir: 'hugo/static/js', cssDir: 'hugo/static/css', manifestOut: 'hugo/static/_retained-assets.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--js-dir') out.jsDir = argv[++i];
    else if (a === '--css-dir') out.cssDir = argv[++i];
    else if (a === '--manifest-out') out.manifestOut = argv[++i];
  }
  return out;
}

async function fetchJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function downloadTo(url, dest, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    return true;
  } catch { return false; } finally { clearTimeout(t); }
}

async function main(opts = {}) {
  const args = { ...parseArgs(process.argv.slice(2)), ...opts };
  const approuter = opts.approuterUrl ?? process.env.APPROUTER_URL ?? '';
  const windowMs = (Number(process.env.RETENTION_WINDOW_HOURS) || 48) * 3600_000;
  const nowMs = opts.nowMs ?? Date.now();

  const jsFiles = collectHashedFiles(args.jsDir).map(f => ({ file: f, dir: args.jsDir, kind: 'js' }));
  const cssFiles = collectHashedFiles(args.cssDir).map(f => ({ file: f, dir: args.cssDir, kind: 'css' }));
  const all = [...jsFiles, ...cssFiles];
  const currentFiles = all.map(x => x.file);

  let retainedManifest = [];
  if (approuter) {
    const prior = await fetchJson(`${approuter.replace(/\/$/, '')}/_retained-assets.json`);
    if (Array.isArray(prior)) retainedManifest = prior;
    else console.warn('[retain-assets] no usable prior manifest — starting fresh (fail-open).');
  } else {
    console.warn('[retain-assets] APPROUTER_URL unset — no carry-forward this build.');
  }

  const { toDownload, manifest } = mergeRetention({ currentFiles, retainedManifest, nowMs, windowMs });

  // Carry forward: download each in-window prior bundle into its dir (kind inferred by extension).
  let ok = 0, miss = 0;
  for (const file of toDownload) {
    const kind = file.endsWith('.css') ? 'css' : 'js';
    const dir = kind === 'css' ? args.cssDir : args.jsDir;
    const got = await downloadTo(`${approuter.replace(/\/$/, '')}/${kind}/${file}`, join(dir, file));
    if (got) ok++; else { miss++; console.warn(`[retain-assets] could not fetch carried ${file} — skipping (fail-open).`); }
  }

  writeFileSync(args.manifestOut, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[retain-assets] current=${currentFiles.length} carried=${ok} missed=${miss} manifest=${manifest.length} → ${args.manifestOut}`);
}

module.exports = { collectHashedFiles, parseArgs, main };

if (require.main === module) {
  main().catch(e => { console.warn('[retain-assets] fail-open:', e.message); process.exit(0); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/retain-asset-bundles.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Manual fail-open smoke (no network)**

Run: `node scripts/retain-asset-bundles.cjs --js-dir /tmp/nojs --css-dir /tmp/nocss --manifest-out /tmp/ret.json`
Expected: exits 0, warns `APPROUTER_URL unset`, writes `/tmp/ret.json` = `[]`.

- [ ] **Step 6: Commit**

```bash
git add scripts/retain-asset-bundles.cjs test/unit/retain-asset-bundles.test.js
git commit -m "feat(retention): CLI to carry forward prior hashed bundles + emit served manifest"
```

---

### Task 3: Wire retention into the local build (`build:all`)

**Files:**
- Modify: `package.json` (scripts: add `retain:assets`; insert into `build:all` between `build:island-manifest` and `build:hugo`)

**Interfaces:**
- Consumes: `scripts/retain-asset-bundles.cjs` (Task 2).

- [ ] **Step 1: Add the `retain:assets` script**

In `package.json` `scripts`, add:
```json
"retain:assets": "node scripts/retain-asset-bundles.cjs --js-dir hugo/public/js --css-dir hugo/public/css --manifest-out hugo/public/_retained-assets.json"
```

- [ ] **Step 2: Insert into `build:all` immediately AFTER `build:hugo`**

In the `build:all` chain, insert `npm run retain:assets` immediately **after** `npm run build:hugo` (retention operates on the Hugo output in `hugo/public`, so it must run once Hugo has produced both the copied JS and the fingerprinted CSS):
```
... && npm run build:hugo && npm run retain:assets && ...
```

- [ ] **Step 3: Verify build:all still parses and orders correctly**

Run: `node -e "const b=require('./package.json').scripts['build:all']; const r=b.indexOf('retain:assets'), h=b.indexOf('build:hugo'); if(!(h<r && r>=0)) throw new Error('retain:assets must come AFTER build:hugo'); console.log('order OK');"`
Expected: `order OK`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build(retention): run retain:assets in build:all before build:hugo (local deploy path)"
```

---

### Task 4: Wire retention into the CI build (root `mta.yaml` before-all)

**Files:**
- Modify: `mta.yaml` (root; before-all, between the hugo-apps build and the Hugo build)

**Interfaces:**
- Consumes: `scripts/retain-asset-bundles.cjs` (Task 2). `APPROUTER_URL` is available to the CI build the same way `rebuild-content.yml` resolves it (per-env secret); the before-all inherits the deploy job env. If unset in this context, the script fails open (no carry-forward) — acceptable, and Task 5 adds the env.

- [ ] **Step 1: Insert the retention command after the hugo-apps build, before Hugo**

In root `mta.yaml` `before-all` `commands`, the Hugo build is the `/tmp/hugo --source hugo --minify` line (it also runs the QA build in parallel). Insert the retention command **immediately after** the command that completes the Hugo build (so `hugo/public/js` + `hugo/public/css` exist), and before the approuter module copies `hugo/public` into the droplet:
```yaml
        - bash -c "cd .. && npm run retain:assets"
```

- [ ] **Step 2: Validate YAML**

Run: `yq -e '.build-parameters.before-all' mta.yaml >/dev/null && echo "YAML OK"`
Expected: `YAML OK`.

- [ ] **Step 3: Confirm ordering in the before-all**

Run: `yq -r '.build-parameters."before-all"[].commands[]' mta.yaml 2>/dev/null | grep -nE "source hugo|retain:assets"`
Expected: the `retain:assets` line number is greater than the `--source hugo` line.

- [ ] **Step 4: Commit**

```bash
git add mta.yaml
git commit -m "build(retention): run retain:assets in CI before-all between islands build and Hugo"
```

---

### Task 5: Provide `APPROUTER_URL` to the CI before-all

**Files:**
- Modify: `.github/workflows/deploy.yml` (export `APPROUTER_URL` for the target env into the `Build MTA archive` step env, mirroring `rebuild-content.yml`'s per-env `APPROUTER_URL_*` secrets)

**Interfaces:**
- Consumes: the same `APPROUTER_URL_DEV|QA|PROD` secrets `rebuild-content.yml` uses.

- [ ] **Step 1: Add env to the `Build MTA archive` step**

In `deploy.yml`, on the `Build MTA archive` step (`run: mbt build ...`), add:
```yaml
        env:
          APPROUTER_URL: ${{ steps.env.outputs.target == 'prod' && secrets.APPROUTER_URL_PROD || (steps.env.outputs.target == 'qa' && secrets.APPROUTER_URL_QA || secrets.APPROUTER_URL_DEV) }}
```
(Match the exact step-id used for the environment output — the surrounding steps reference `steps.env.outputs.target`. If the id differs, use the id already used elsewhere in this job for the target.)

- [ ] **Step 2: Validate YAML**

Run: `yq -e '.jobs' .github/workflows/deploy.yml >/dev/null && echo "YAML OK"`
Expected: `YAML OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "build(retention): expose per-env APPROUTER_URL to the mbt build for carry-forward"
```

---

### Task 6: Post-deploy smoke — prior deploy's referenced bundles still resolve

**Files:**
- Modify: `test/smoke/` — add a smoke assertion (follow the existing smoke harness pattern in that dir; e.g. `test/smoke/asset-retention.smoke.test.js` or a case in the existing island/asset smoke file)

**Interfaces:**
- Consumes: `SMOKE_BASE_URL` (existing smoke env). Reads the live `/_retained-assets.json` and asserts every listed bundle serves 200.

- [ ] **Step 1: Write the smoke test**

```js
// test/smoke/asset-retention.smoke.test.js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const d = BASE ? describe : describe.skip;   // self-skip when unset, like other smoke specs

d('asset retention', () => {
  it('every bundle in _retained-assets.json serves 200', async () => {
    const res = await fetch(`${BASE}/_retained-assets.json`);
    expect(res.ok).toBe(true);
    const manifest = await res.json();
    expect(Array.isArray(manifest)).toBe(true);
    for (const { file } of manifest) {
      const kind = file.endsWith('.css') ? 'css' : 'js';
      const r = await fetch(`${BASE}/${kind}/${file}`, { method: 'HEAD' });
      expect(r.status, `${file} should serve 200`).toBe(200);
    }
  });
});
```

- [ ] **Step 2: Run against a deployed env (or confirm self-skip locally)**

Run (local, no env): `npx vitest run test/smoke/asset-retention.smoke.test.js`
Expected: skipped (no `SMOKE_BASE_URL`).
Run (post-deploy): `SMOKE_BASE_URL=https://<env-approuter> npx vitest run test/smoke/asset-retention.smoke.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/asset-retention.smoke.test.js
git commit -m "test(retention): smoke that retained bundles all serve 200"
```

---

### Task 7: Full unit run + docs note

**Files:**
- Modify: `docs/developers/architecture/build.md` (short subsection: asset-hash retention — what `_retained-assets.json` is, the 48h window, fail-open, that content-hashed files are immutable so union is safe)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS (includes the two new unit files).

- [ ] **Step 2: Add the docs subsection**

Add to `build.md` a short "Asset-hash retention (#1604 follow-up)" subsection describing the mechanism and the served `_retained-assets.json`.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/build.md
git commit -m "docs(retention): document asset-hash retention + _retained-assets.json"
```

---

## Notes / out of scope

- **Pre-#1604 bare `/js/validation.js` references** (from HTML cached before 2026-08-10) are NOT fixable by retention — those files were never hashed and don't exist. They self-heal as that pre-#1604 edge cache expires (≤24h from the #1604 deploy) and are effectively gone by 2026-08-11. Retention fixes the *recurring* case: every future bundle-hash change.
- **Local-disk bloat:** `approuter/static/js` accumulates across *local* union-cp builds; the deployed droplet (built with the carry-forward set) is bounded by the 48h window. Pruning local `approuter/static` is not needed for prod correctness — leave it out of this workstream.
- **Workstream B** (serve pages from HANA/CAP, retire `/admin/rebuild` + `deploy-self-heal`) is a separate plan, written after A ships.

## Self-review

- **Spec coverage:** Workstream A requirements — retain prior hashed bundles ≥ HTML TTL (Tasks 1–5), served manifest (Task 2), 48h window (Global Constraints + Task 2), fail-open (Task 2), both build paths (Tasks 3–5), verification (Task 6). Covered.
- **Placeholder scan:** none — all steps have concrete code/commands.
- **Type consistency:** `mergeRetention({currentFiles, retainedManifest, nowMs, windowMs}) → {toDownload, manifest}` defined in Task 1 and consumed identically in Task 2; `collectHashedFiles(dir)` defined and tested consistently; manifest entry shape `{file, firstSeenMs}` consistent across tasks and the smoke test.
