# MTA Versioning via `git describe` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `tutorials-ims` MTA a meaningful, traceable version (from `git describe`) surfaced four ways: CF platform query, a `/version` endpoint, semver git tags, and a committed `DEPLOYED.md`.

**Architecture:** The deploy pipeline computes the version from `git describe --tags --match 'v*' --always`, normalizes it to valid semver, and `sed`s it into `mta.yaml` (replacing the old `1.0.<run_number>` counter). It writes build-time facts to `srv/version.json`, which a new unauthenticated `GET /version` route in `srv/server.js` serves — merging in the *runtime* environment from the existing `resolveDeployEnvironment()` helper (more truthful than a baked-in env). On successful deploy the pipeline updates `DEPLOYED.md` on `main`.

**Tech Stack:** GitHub Actions, `mbt`/`cf` MTA tooling, Node.js CAP (`@sap/cds`), Express (ESM), Vitest.

## Global Constraints

- MTA `version:` MUST be valid semver: `MAJOR.MINOR.PATCH` optionally `-prerelease`. Copied verbatim from spec §"Load-bearing constraint".
- `git describe` REQUIRES full history + tags: checkout MUST use `fetch-depth: 0` and `fetch-tags: true`.
- Normalization rule (verbatim): take `git describe --tags --match 'v*' --always`; if it begins with `v` followed by a digit, strip the leading `v`; otherwise emit `0.0.0-g<result>`.
- `/version` is unauthenticated — build metadata only, never secrets. It MUST be registered BEFORE `app.use(basicAuthMiddleware)` (currently `srv/server.js:252`).
- Test runner is Vitest (`npx vitest run --project unit`), ESM, `import { describe, it, expect } from 'vitest'`. Lib tests live in `srv/__tests__/lib/`.
- Do NOT change the deploy trigger model (`workflow_dispatch` + environment choice) or promotion mechanics.
- `mbt`/`cf` steps consume the version via `steps.version.outputs.version` (see `deploy.yml` "Deploy MTA" step — it references `tutorials-ims_${{ steps.version.outputs.version }}.mtar`). The output name `version` MUST be preserved.

---

### Task 1: `/version` endpoint handler (lib + tests)

Build a pure, testable handler factory in its own lib file. It reads build facts from `srv/version.json` and merges the runtime environment from `resolveDeployEnvironment()`. No server wiring yet.

**Files:**
- Create: `srv/lib/version-handler.js`
- Test: `srv/__tests__/lib/version-handler.test.js`

**Interfaces:**
- Consumes: `resolveDeployEnvironment` from `srv/lib/deploy-environment.js` — signature `resolveDeployEnvironment(rawVcap?) => { id, label, space }`. We use `.id` (`'dev'|'prod'|'qa'|'local'|'other'`).
- Produces:
  - `createVersionHandler({ versionFilePath, resolveEnv }) => (req, res) => void` — factory; `versionFilePath` is an absolute path to `version.json`, `resolveEnv` is an injectable env resolver (defaults to `resolveDeployEnvironment`).
  - `versionHandler` — default export instance bound to `srv/version.json` next to the module and the real `resolveDeployEnvironment`.
  - Response shape: `{ version: string, gitSha: string, environment: string, builtAt: string|null }`.
  - Dev fallback (file missing/unparseable): `{ version: 'dev', gitSha: 'local', builtAt: null }` merged with `environment` from the resolver.

- [ ] **Step 1: Write the failing test**

```javascript
// srv/__tests__/lib/version-handler.test.js
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVersionHandler, versionHandler } from '../../lib/version-handler.js';

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    type(t) { this.headers['content-type'] = t; return this; },
  };
}

describe('version-handler', () => {
  it('serves version.json contents merged with runtime environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const file = join(dir, 'version.json');
    writeFileSync(file, JSON.stringify({ version: '1.4.2-5-ga7518452', gitSha: 'a7518452', builtAt: '2026-07-25T09:44:00Z' }));
    const handler = createVersionHandler({ versionFilePath: file, resolveEnv: () => ({ id: 'prod', label: 'PROD', space: 'prod' }) });
    const res = mockRes();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: '1.4.2-5-ga7518452', gitSha: 'a7518452', environment: 'prod', builtAt: '2026-07-25T09:44:00Z' });
  });

  it('falls back to dev defaults when version.json is absent', () => {
    const handler = createVersionHandler({ versionFilePath: join(tmpdir(), 'does-not-exist-xyz.json'), resolveEnv: () => ({ id: 'local', label: 'LOCAL', space: null }) });
    const res = mockRes();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: 'dev', gitSha: 'local', environment: 'local', builtAt: null });
  });

  it('falls back to dev defaults when version.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const file = join(dir, 'version.json');
    writeFileSync(file, '{ not json');
    const handler = createVersionHandler({ versionFilePath: file, resolveEnv: () => ({ id: 'qa', label: 'QA', space: 'qa' }) });
    const res = mockRes();
    handler({}, res);
    expect(res.body).toEqual({ version: 'dev', gitSha: 'local', environment: 'qa', builtAt: null });
  });

  it('exports a default versionHandler bound to the real resolver', () => {
    expect(typeof versionHandler).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit srv/__tests__/lib/version-handler.test.js`
Expected: FAIL — `Cannot find module '../../lib/version-handler.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/version-handler.js
//
// GET /version — unauthenticated build-metadata endpoint (MTA versioning
// design, docs/superpowers/specs/2026-07-25-mta-versioning-design.md).
// Build facts (version, gitSha, builtAt) come from srv/version.json, written
// by the deploy pipeline before `mbt build`. The environment is resolved at
// REQUEST time from the CF space (resolveDeployEnvironment) — more truthful
// than baking an env label into the artifact, and reuses the existing helper.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveDeployEnvironment } from './deploy-environment.js';

const DEV_FALLBACK = { version: 'dev', gitSha: 'local', builtAt: null };
const DEFAULT_VERSION_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'version.json');

function readBuildFacts(versionFilePath) {
  try {
    const parsed = JSON.parse(readFileSync(versionFilePath, 'utf8'));
    return {
      version: typeof parsed.version === 'string' ? parsed.version : DEV_FALLBACK.version,
      gitSha: typeof parsed.gitSha === 'string' ? parsed.gitSha : DEV_FALLBACK.gitSha,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : DEV_FALLBACK.builtAt,
    };
  } catch {
    return { ...DEV_FALLBACK };
  }
}

export function createVersionHandler({ versionFilePath = DEFAULT_VERSION_FILE, resolveEnv = resolveDeployEnvironment } = {}) {
  return function versionRoute(_req, res) {
    const facts = readBuildFacts(versionFilePath);
    const env = resolveEnv();
    res.status(200).json({ ...facts, environment: env.id });
  };
}

export const versionHandler = createVersionHandler();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit srv/__tests__/lib/version-handler.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/version-handler.js srv/__tests__/lib/version-handler.test.js
git commit -m "feat(srv): add /version handler lib with dev fallback"
```

---

### Task 2: Wire `/version` route into the server (unauthenticated)

Register the route in `srv/server.js` immediately after the `/health/db` block and BEFORE `app.use(basicAuthMiddleware)`, so it stays public.

**Files:**
- Modify: `srv/server.js` (import near the other lib imports; route registration after `srv/server.js:242`, before `srv/server.js:252`)

**Interfaces:**
- Consumes: `versionHandler` from Task 1 (`srv/lib/version-handler.js`).
- Produces: live `GET /version` route (no new exported symbols).

- [ ] **Step 1: Add the import**

Add alongside the existing lib imports near the top of `srv/server.js` (e.g. after the `resolveDeployEnvironment` import line):

```javascript
import { versionHandler } from './lib/version-handler.js';
```

- [ ] **Step 2: Register the route before basicAuthMiddleware**

In the `cds.on('bootstrap', (app) => { … })` block, immediately after the `/health/db` handler (ends at `srv/server.js:242`) and before `app.post('/api/ui-event', …)` / `app.use(basicAuthMiddleware)`:

```javascript
  // GET /version — unauthenticated build-metadata endpoint. Registered BEFORE
  // basicAuthMiddleware so monitors/humans can read it without a token. See
  // docs/superpowers/specs/2026-07-25-mta-versioning-design.md.
  app.get('/version', versionHandler);
```

- [ ] **Step 3: Verify the route is public and returns dev fallback locally**

Run (no `version.json` present in a checkout → dev fallback, environment `local`):
```bash
npx cds serve srv --in-memory > /tmp/cds-version-check.log 2>&1 &
CDS_PID=$!
sleep 8
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4004/version
curl -s http://localhost:4004/version
kill $CDS_PID 2>/dev/null
```
Expected: HTTP `200`, body `{"version":"dev","gitSha":"local","environment":"local","builtAt":null}` (no 401 — proves it's ahead of basic auth).

- [ ] **Step 4: Run the existing server/route test suite to confirm no regression**

Run: `npx vitest run --project unit`
Expected: PASS (all existing tests + Task 1's, no failures).

- [ ] **Step 5: Commit**

```bash
git add srv/server.js
git commit -m "feat(srv): serve GET /version before basic auth"
```

---

### Task 3: Compute + normalize the version in the pipeline; write `version.json`

Replace the `Set version` step with `git describe`-based computation, fix checkout to fetch tags, and write `srv/version.json` so it's packaged by `mbt build`.

**Files:**
- Modify: `.github/workflows/deploy.yml` — Checkout step (`~:56-57`), `Set version` step (`:63-68`), and add a `version.json` write step before `Build MTA archive` (`:221`).

**Interfaces:**
- Consumes: git tags (`v*`), `github.sha`, `github.run_number`.
- Produces: `steps.version.outputs.version` (unchanged output NAME — the `Deploy MTA` step at `deploy.yml` depends on it), `steps.version.outputs.gitSha`, and a written `srv/version.json`.

- [ ] **Step 1: Make checkout fetch full history + tags**

Change the Checkout step:
```yaml
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true
```

- [ ] **Step 2: Replace the `Set version` step with git-describe + normalization**

Replace the entire existing `Set version` step:
```yaml
      - name: Set version
        id: version
        run: |
          set -euo pipefail
          RAW=$(git describe --tags --match 'v*' --always)
          # Normalize to valid MTA semver: strip a leading 'v<digit>', else
          # fall back to 0.0.0-g<raw> (no v* tag reachable). See
          # docs/superpowers/specs/2026-07-25-mta-versioning-design.md §1.
          if [[ "$RAW" =~ ^v[0-9] ]]; then
            VERSION="${RAW#v}"
          else
            VERSION="0.0.0-g${RAW}"
          fi
          SHORT_SHA=$(git rev-parse --short HEAD)
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "gitSha=$SHORT_SHA" >> "$GITHUB_OUTPUT"
          echo "Computed MTA version: $VERSION (sha $SHORT_SHA)"
          sed -i "s/^version: .*/version: $VERSION/" mta.yaml
```

- [ ] **Step 3: Write `srv/version.json` before the build**

Add a new step immediately BEFORE the `Build MTA archive` step (`deploy.yml:221`):
```yaml
      - name: Write srv/version.json
        run: |
          set -euo pipefail
          cat > srv/version.json <<EOF
          {
            "version": "${{ steps.version.outputs.version }}",
            "gitSha": "${{ steps.version.outputs.gitSha }}",
            "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          }
          EOF
          echo "Wrote srv/version.json:"
          cat srv/version.json
```

- [ ] **Step 4: Lint the workflow YAML**

Run: `yq '.jobs.deploy.steps[] | select(.name == "Set version") | .run' .github/workflows/deploy.yml`
Expected: prints the new git-describe script (valid YAML, no parse error).

- [ ] **Step 5: Verify normalization logic locally against real repo state**

Run (proves the fallback branch works today — no `v*` tag exists yet):
```bash
RAW=$(git describe --tags --match 'v*' --always)
if [[ "$RAW" =~ ^v[0-9] ]]; then VERSION="${RAW#v}"; else VERSION="0.0.0-g${RAW}"; fi
echo "RAW=$RAW  VERSION=$VERSION"
# Assert it is valid MTA semver (MAJOR.MINOR.PATCH[-prerelease])
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]] && echo "OK: valid semver" || (echo "BAD semver"; exit 1)
```
Expected: `OK: valid semver` (today prints `VERSION=0.0.0-g<sha>`; after Task 5's tag it would print `1.0.0`).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: version MTA from git describe + write srv/version.json"
```

---

### Task 4: Record deployed state in `DEPLOYED.md` on success

Add a step that, only on a successful deploy, updates a per-environment row in `DEPLOYED.md` and commits it to `main`.

**Files:**
- Create: `DEPLOYED.md` (seed file)
- Modify: `.github/workflows/deploy.yml` — add an update+commit step after `Deploy MTA` succeeds.

**Interfaces:**
- Consumes: `steps.version.outputs.version`, `steps.version.outputs.gitSha`, `steps.env.outputs.target`, `github.server_url`, `github.repository`, `github.run_id`.
- Produces: committed `DEPLOYED.md` with one canonical row per environment.

- [ ] **Step 1: Seed `DEPLOYED.md`**

Create at repo root:
```markdown
# Deployed Versions

Current MTA version live in each environment. Updated automatically by the
deploy pipeline on every successful deploy. Release history lives in git tags
(`v*`); this file is the at-a-glance per-environment state.

| Environment | Version | Commit | Deployed (UTC) | Run |
|---|---|---|---|---|
| dev | — | — | — | — |
| qa | — | — | — | — |
| prod | — | — | — | — |
```

- [ ] **Step 2: Add the update-and-commit step after `Deploy MTA`**

Insert immediately after the `Deploy MTA` step (before `Abort blue-green on failure`):
```yaml
      - name: Record deployed version in DEPLOYED.md
        if: success()
        run: |
          set -euo pipefail
          ENV="${{ steps.env.outputs.target }}"
          VER="${{ steps.version.outputs.version }}"
          SHA="${{ steps.version.outputs.gitSha }}"
          TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          RUN="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
          ROW="| $ENV | \`$VER\` | \`$SHA\` | $TS | [run]($RUN) |"
          # Replace the single row whose first cell is this environment.
          # Anchored on '| <env> |' at line start so we touch exactly one row.
          sed -i -E "s|^\| ${ENV} \|.*\$|${ROW}|" DEPLOYED.md
          echo "Updated DEPLOYED.md row for $ENV:"
          grep -E "^\| ${ENV} \|" DEPLOYED.md
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git fetch origin main
          git checkout main
          git stash push -- DEPLOYED.md || true
          git pull --ff-only origin main
          git stash pop || true
          git add DEPLOYED.md
          if git diff --cached --quiet; then
            echo "No DEPLOYED.md change to commit."
          else
            git commit -m "chore(deploy): $ENV now at $VER ($SHA) [skip ci]"
            git push origin main
          fi
```

- [ ] **Step 3: Verify the sed row-replacement logic locally**

Run (proves exactly one row changes and the table stays well-formed):
```bash
cp DEPLOYED.md /tmp/DEPLOYED.test.md
ENV=prod; VER='1.0.0'; SHA='203c4161'; TS='2026-07-25T10:00:00Z'; RUN='https://x/run/1'
ROW="| $ENV | \`$VER\` | \`$SHA\` | $TS | [run]($RUN) |"
sed -i -E "s|^\| ${ENV} \|.*\$|${ROW}|" /tmp/DEPLOYED.test.md
echo "--- result ---"; cat /tmp/DEPLOYED.test.md
grep -cE '^\| (dev|qa|prod) \|' /tmp/DEPLOYED.test.md   # expect 3 rows total
grep -E '^\| prod \|' /tmp/DEPLOYED.test.md             # expect the updated row
```
Expected: 3 env rows preserved; only the `prod` row shows `1.0.0` / `203c4161`.

- [ ] **Step 4: Lint the workflow YAML**

Run: `yq '.jobs.deploy.steps[] | select(.name == "Record deployed version in DEPLOYED.md") | .if' .github/workflows/deploy.yml`
Expected: prints `success()` (step parsed correctly).

- [ ] **Step 5: Commit**

```bash
git add DEPLOYED.md .github/workflows/deploy.yml
git commit -m "ci: record per-env deployed version in DEPLOYED.md"
```

---

### Task 5: Seed the initial `v1.0.0` release tag (one-time, documented)

The first real deploy should compute `1.0.0`, not the fallback. This task documents the exact command; the human runs it against the prod commit (tags aren't created from a worktree branch).

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-mta-versioning-design.md` — append a short "Cutover" note recording the seeded tag command (documentation only).

**Interfaces:**
- Consumes: nothing.
- Produces: an annotated `v1.0.0` tag on the current prod commit (`203c4161`, per design §4) — created out-of-band by a human with push access, NOT in this worktree.

- [ ] **Step 1: Append the cutover note to the spec**

Add to the end of the design doc:
```markdown
## Cutover

One-time seed of the initial release tag (run by a human with push access,
against the commit currently live in prod — `203c4161` at time of writing):

    git tag -a v1.0.0 203c4161 -m "Initial versioned release (tutorials-ims)"
    git push origin v1.0.0

After this, a deploy from that commit computes MTA version `1.0.0`; deploys
from commits ahead of the tag compute `1.0.0-<N>-g<sha>`.
```

- [ ] **Step 2: Commit the doc update**

```bash
git add docs/superpowers/specs/2026-07-25-mta-versioning-design.md
git commit -m "docs: record v1.0.0 cutover tag command"
```

- [ ] **Step 3: Flag the manual action in the PR**

The tag push is the ONE human step this plan cannot perform from a worktree branch. Call it out explicitly in the PR description so it isn't missed:
> ⚠️ Before/with the first deploy on this branch: `git tag -a v1.0.0 <prod-commit> && git push origin v1.0.0`. Without it, the pipeline emits the `0.0.0-g<sha>` fallback (still valid, just not the intended `1.0.0`).

---

## Self-Review

**Spec coverage:**
- §1 version scheme + normalization → Task 3 (compute/normalize) + Task 5 (seed tag). ✓
- §1 checkout fetch-depth/tags → Task 3 Step 1. ✓
- §2 CF query surface → free once Task 3 lands (meaningful `mta.yaml` version); no code needed. ✓
- §2 `/version` endpoint → Tasks 1 + 2. ✓
- §2 release history (tags) → Task 5. ✓
- §2 `DEPLOYED.md` → Task 4. ✓
- §3 endpoint contract + dev fallback + unauthenticated → Task 1 (shape/fallback) + Task 2 (registered before basic auth). ✓
- §3 refinement: `environment` from runtime resolver, `version.json` = {version,gitSha,builtAt} → Task 1 interfaces + Task 3 Step 3. ✓ (documented deviation from spec's baked-in env; more truthful, reuses `resolveDeployEnvironment`.)
- §4 promotion mechanics unchanged → no task touches the trigger/`mbt`/`cf` flow beyond the version value. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step has concrete content. ✓

**Type consistency:** `createVersionHandler`/`versionHandler` names + response shape `{version,gitSha,environment,builtAt}` consistent across Tasks 1–3. `steps.version.outputs.version` name preserved for the existing `Deploy MTA` step. ✓
