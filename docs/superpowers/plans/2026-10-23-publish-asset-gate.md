# Publish Asset-Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block any content publish that references a CSS/JS fingerprint the target approuter doesn't serve — on the QA workflow and the emergency CLI — before any HANA BLOB is written, and make the post-deploy QA publish a mandatory runbook step.

**Architecture:** Reuse the existing, battle-tested `scripts/check-approuter-assets.cjs` gate verbatim as a subprocess. `rebuild-content.yml` (PROD) already wires it; add the same step to `rebuild-content-qa.yml` and invoke it from `publish-content.ts` `main()` before the publish session. No new asset-probing logic.

**Tech Stack:** Node.js 22, TypeScript (tsx), GitHub Actions YAML, Vitest.

**Spec:** `d:\projects\cloud-cap-hana-swapi\docs\superpowers\specs\2026-10-23-publish-asset-gate-design.md`

## Global Constraints

- Targets **DEV** — feature PR → DEV; `main` is protected; no main-hotfix path.
- **Reuse `check-approuter-assets.cjs` as a subprocess** — do NOT reimplement extraction/probe/inconclusive logic. One implementation only.
- QA approuter URL = `secrets.APPROUTER_URL_QA` (already used at `rebuild-content.yml:373`). No new secret.
- CLI approuter URL = `process.env.APPROUTER_URL` (established convention: `seed-*-from-deployed.ts`, `retain-asset-bundles.cjs`).
- Static assets are public → no API key to probe. All-404 (no 200s) = inconclusive → pass (never a false block).
- CLI gate must **skip (loud) when `APPROUTER_URL` is unset** — local `cds watch` has no approuter; failing there breaks every local publish.
- QA build renders to `hugo/public-qa`; the CLI already sets `opts.hugoDir` per channel (`main()` ~line 864), so one call shape works for both.
- CLI tests import **pure functions** from `publish-content.js` (see `scripts/__tests__/publish-content-cli.test.ts`) — the gate's testable surface must be a pure arg-builder + a thin runner, not `main()`.

## Review Focus

- **force-publish QA run** publishes the whole catalog — the guard must NOT pin to one slug (would gate 1, ship ~1400). Pinned by Task 1 test `force-publish probes whole catalog (no slug pin)`.
- **author source-error QA dispatch** (slug failed to fetch → no rendered page) currently skips publish and goes green — the guard must share the `if: bad_slug == ''` skip or it hard-fails a benign typo. Pinned by Task 1 (YAML `if:` + inspection assertion).
- **multi-slug CLI publish** (`--slugs a,b`) must probe exactly those N — not just the single `--slug` fallback. Pinned by Task 2 test `builds --slugs arg for multi-slug publish`.
- **APPROUTER_URL unset** (local dev) must skip, not fail. Pinned by Task 2 test `skips gate when APPROUTER_URL unset`.
- **non-zero subprocess exit** must abort before any BLOB write and propagate the code. Pinned by Task 3 test `propagates non-zero gate exit`.

---

### Task 1: QA workflow guard

**Files:**
- Modify: `.github/workflows/rebuild-content-qa.yml` (insert a step after "Highlight CDS code blocks (Shiki)" ~line 398, before "Publish QA content to HANA" ~line 400)

**Interfaces:**
- Consumes: `scripts/check-approuter-assets.cjs` (unchanged), `secrets.APPROUTER_URL_QA`, `steps.source_errors.outputs.bad_slug`.
- Produces: nothing downstream depends on it (a gate step).

- [ ] **Step 1: Add the guard step**

Insert this step immediately before `- name: Publish QA content to HANA`:

```yaml
      # [#2885] Pre-flight asset gate — same guard rebuild-content.yml already
      # runs, now on the QA path (the surface stranded on 2026-10-22). Probes
      # every /css + hashed island /js the rendered QA HTML references against
      # the deployed QA approuter; FAILS before the HANA publish on any 404, so
      # QA BLOBs are never poisoned with HTML the approuter can't dress.
      - name: Guard - approuter serves referenced CSS + islands (QA)
        # Share the publish step's skip: an author source-error leaves no
        # rendered page, and check-approuter-assets.cjs die()s on a missing page
        # (exit 1) — without this, a benign author typo becomes a red infra run.
        if: ${{ steps.source_errors.outputs.bad_slug == '' }}
        env:
          APPROUTER_URL: ${{ secrets.APPROUTER_URL_QA }}
          # Match the publish step's scope EXACTLY (lines 424/431): a
          # force-publish run ships the whole catalog, so it must NOT pin the
          # guard to one slug.
          PUBLISH_SLUG: ${{ ((! inputs.force-publish) || inputs.allow-revert) && (github.event.client_payload.slug || inputs.slug) || '' }}
          PUBLISH_SLUGS: ${{ (! inputs.force-publish) && github.event.client_payload.slugs || '' }}
        run: |
          SLUGS_ARG=""
          [ -n "$PUBLISH_SLUGS" ] && SLUGS_ARG="--slugs $PUBLISH_SLUGS"
          node scripts/check-approuter-assets.cjs \
            --approuter-url "$APPROUTER_URL" \
            --hugo-dir hugo/public-qa \
            --check-islands $SLUGS_ARG
```

- [ ] **Step 2: Verify YAML parses and the step is correctly placed**

Run: `npx js-yaml .github/workflows/rebuild-content-qa.yml > /dev/null && echo OK` (or `yq '.jobs."rebuild-qa".steps[] | .name' .github/workflows/rebuild-content-qa.yml | grep -n 'Guard - approuter\|Highlight CDS\|Publish QA'`)
Expected: `OK`; the Guard step appears between "Highlight CDS code blocks (Shiki)" and "Publish QA content to HANA".

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rebuild-content-qa.yml
git commit -m "ci(#2885): gate QA publish on approuter-served CSS/JS assets"
```

---

### Task 2: CLI gate — pure arg-builder + unset/skip logic

**Files:**
- Modify: `scripts/publish-content.ts` (add exported `buildApprouterGateArgs`, `approuterGateDecision`)
- Test: `scripts/__tests__/publish-content-cli.test.ts` (extend)

**Interfaces:**
- Consumes: `PublishOptions` (`{ hugoDir, slug, slugs, ... }`), `process.env.APPROUTER_URL`, `process.env.SKIP_APPROUTER_GATE`.
- Produces:
  - `approuterGateDecision(env: { APPROUTER_URL?: string; SKIP_APPROUTER_GATE?: string }): { run: boolean; reason: string }` — `run:false` when `APPROUTER_URL` empty/unset (reason `"no-approuter"`) or `SKIP_APPROUTER_GATE` truthy (reason `"skip-flag"`); else `run:true`.
  - `buildApprouterGateArgs(opts: { hugoDir: string; slugs: string }, approuterUrl: string): string[]` — returns the `.cjs` argv array: `['scripts/check-approuter-assets.cjs', '--approuter-url', approuterUrl, '--hugo-dir', opts.hugoDir, '--check-islands']` plus `['--slugs', opts.slugs]` when `opts.slugs` is non-empty. (`--slug` is threaded via the `PUBLISH_SLUG` env, matching the workflow, not as an arg.)

- [ ] **Step 1: Write the failing tests**

Add to `scripts/__tests__/publish-content-cli.test.ts`:

```typescript
import { approuterGateDecision, buildApprouterGateArgs } from '../publish-content.js';

describe('approuterGateDecision', () => {
  it('skips gate when APPROUTER_URL unset', () => {
    expect(approuterGateDecision({}).run).toBe(false);
    expect(approuterGateDecision({ APPROUTER_URL: '' }).run).toBe(false);
    expect(approuterGateDecision({}).reason).toBe('no-approuter');
  });
  it('skips gate when SKIP_APPROUTER_GATE set', () => {
    const d = approuterGateDecision({ APPROUTER_URL: 'https://x', SKIP_APPROUTER_GATE: '1' });
    expect(d.run).toBe(false);
    expect(d.reason).toBe('skip-flag');
  });
  it('runs gate when APPROUTER_URL set and no skip', () => {
    expect(approuterGateDecision({ APPROUTER_URL: 'https://x' }).run).toBe(true);
  });
});

describe('buildApprouterGateArgs', () => {
  it('base args: no --slugs when slugs empty', () => {
    expect(buildApprouterGateArgs({ hugoDir: 'hugo/public', slugs: '' }, 'https://x'))
      .toEqual(['scripts/check-approuter-assets.cjs', '--approuter-url', 'https://x', '--hugo-dir', 'hugo/public', '--check-islands']);
  });
  it('builds --slugs arg for multi-slug publish', () => {
    expect(buildApprouterGateArgs({ hugoDir: 'hugo/public-qa', slugs: 'a,b' }, 'https://x'))
      .toContain('--slugs');
    expect(buildApprouterGateArgs({ hugoDir: 'hugo/public-qa', slugs: 'a,b' }, 'https://x').at(-1)).toBe('a,b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/publish-content-cli.test.ts -t 'approuterGate|buildApprouterGateArgs'`
Expected: FAIL — `approuterGateDecision`/`buildApprouterGateArgs` not exported.

- [ ] **Step 3: Implement the two pure functions in `scripts/publish-content.ts`**

Export both near the other exported helpers (e.g. after `parseArgs`). Signatures exactly as in Interfaces. `approuterGateDecision` treats any non-empty `SKIP_APPROUTER_GATE` as truthy; `buildApprouterGateArgs` appends `--slugs <slugs>` only when `opts.slugs.trim()` is non-empty.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/publish-content-cli.test.ts -t 'approuterGate|buildApprouterGateArgs'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-content.ts scripts/__tests__/publish-content-cli.test.ts
git commit -m "feat(#2885): add approuter-gate decision + arg-builder to publish CLI"
```

---

### Task 3: CLI gate — wire into main() before publish

**Files:**
- Modify: `scripts/publish-content.ts` (`main()`, insert gate after the `tutorials.size === 0` check ~line 1309, before `validateProductionBuild` ~line 1313; add `spawnSync` import)
- Test: `scripts/__tests__/publish-content-cli.test.ts` (add `runApprouterGate` test with mocked `spawnSync`)

**Interfaces:**
- Consumes: `approuterGateDecision`, `buildApprouterGateArgs` (Task 2); `spawnSync` from `node:child_process`.
- Produces: `runApprouterGate(opts: { hugoDir: string; slug: string; slugs: string }, env: NodeJS.ProcessEnv, spawn?: typeof spawnSync): number` — returns `0` when the gate is skipped (decision `run:false`) or passes; returns the subprocess's non-zero `status` otherwise. Passes `PUBLISH_SLUG: opts.slug` in the child env so a single-slug publish scopes the probe. The `spawn` param defaults to the real `spawnSync` (injectable for tests).

- [ ] **Step 1: Write the failing test**

```typescript
import { runApprouterGate } from '../publish-content.js';

describe('runApprouterGate', () => {
  it('skips (returns 0) when APPROUTER_URL unset', () => {
    const spy = vi.fn();
    expect(runApprouterGate({ hugoDir: 'hugo/public', slug: '', slugs: '' }, {}, spy as any)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
  it('propagates non-zero gate exit', () => {
    const spawn = vi.fn().mockReturnValue({ status: 1 });
    expect(runApprouterGate({ hugoDir: 'hugo/public', slug: '', slugs: '' }, { APPROUTER_URL: 'https://x' }, spawn as any)).toBe(1);
  });
  it('passes PUBLISH_SLUG in child env for a scoped publish', () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    runApprouterGate({ hugoDir: 'hugo/public', slug: 'foo', slugs: '' }, { APPROUTER_URL: 'https://x' }, spawn as any);
    const callEnv = spawn.mock.calls[0][2].env;
    expect(callEnv.PUBLISH_SLUG).toBe('foo');
  });
});
```

(Add `import { vi } from 'vitest'` to the test file's imports if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/publish-content-cli.test.ts -t 'runApprouterGate'`
Expected: FAIL — `runApprouterGate` not exported.

- [ ] **Step 3: Implement `runApprouterGate` + wire into `main()`**

Implement `runApprouterGate` per the Interfaces signature: call `approuterGateDecision(env)`; if `run:false` log a loud warning naming the reason and return `0`; else `spawn('node', buildApprouterGateArgs(opts, env.APPROUTER_URL), { stdio: 'inherit', env: { ...env, PUBLISH_SLUG: opts.slug } })` and return `result.status ?? 0`.

In `main()`, after the `tutorials.size === 0` check and before `validateProductionBuild`, call it only on the real publish path (NOT verify-only/dry-run/unpublish/purge — those return earlier or are separate branches):

```typescript
const gateCode = runApprouterGate(
  { hugoDir: opts.hugoDir, slug: opts.slug, slugs: opts.slugs },
  process.env,
);
if (gateCode !== 0) {
  console.error('[publish-content] approuter asset gate failed — aborting before any BLOB write.');
  process.exit(gateCode);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/publish-content-cli.test.ts -t 'runApprouterGate'`
Expected: PASS.

- [ ] **Step 5: Run the full CLI test file (no regressions)**

Run: `npx vitest run scripts/__tests__/publish-content-cli.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-content.ts scripts/__tests__/publish-content-cli.test.ts
git commit -m "feat(#2885): run approuter asset gate before CLI publish"
```

---

### Task 4: Deploy runbook — mandatory post-deploy QA publish

**Files:**
- Modify: `docs/developers/operations/mta-deployment.md`

**Interfaces:** docs only.

- [ ] **Step 1: Add a mandatory post-deploy-publish subsection**

Add a subsection stating: whenever a deploy changes a CSS/JS fingerprint, the post-deploy content publish is **mandatory on BOTH surfaces** —
1. PROD/main: `gh workflow run rebuild-content.yml -f mode=full` (env=prod), confirm green.
2. QA: `gh workflow run rebuild-content-qa.yml` (or the `Rebuild Content (QA)` UI), confirm green.

Emphasize: **QA does NOT self-heal** (it refreshes only on its own `tutorial-qa-updated` dispatch), the QA publish is the step most often skipped, and the `check-approuter-assets` gate (now on all three paths) will hard-fail a publish that references an unshipped hash. `Rebuild Content (QA)` is the canonical QA path (QA sources from `-Contribution` repos).

- [ ] **Step 2: Verify the doc references resolve**

Run: `grep -n 'rebuild-content-qa\|does NOT self-heal\|check-approuter-assets' docs/developers/operations/mta-deployment.md`
Expected: matches present.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/operations/mta-deployment.md
git commit -m "docs(#2885): make post-deploy QA content publish mandatory"
```

---

### Task 5: Gotchas regression note

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` ("Top Gotchas — full detail" section, ~line 108)

**Interfaces:** docs only.

- [ ] **Step 1: Add the regression entry**

Add an entry: a fingerprint-changing deploy strands **both** `/tutorials/*` and `/tutorials-qa/*` until each surface is re-published; an MTA deploy does not re-bake HTML BLOBs; the `check-approuter-assets.cjs` gate now blocks a publish referencing an unshipped CSS/JS hash on all three paths (`rebuild-content.yml`, `rebuild-content-qa.yml`, and the `publish-content.ts` CLI — CLI bypass is `SKIP_APPROUTER_GATE=1`, loud); QA does not self-heal. Cross-reference issue #2885.

- [ ] **Step 2: Verify**

Run: `grep -n '2885\|stranded\|self-heal' docs/developers/reference/tutorials-ims-gotchas.md`
Expected: match present.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/reference/tutorials-ims-gotchas.md
git commit -m "docs(#2885): add stranded-asset regression note to gotchas"
```

---

### Task 6: Whole-suite sanity + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the publish-content + approuter-assets test suites**

Run: `npx vitest run scripts/__tests__/publish-content-cli.test.ts test/unit/check-approuter-assets.test.ts`
Expected: PASS (all).

- [ ] **Step 2: Push the branch and open a PR targeting DEV**

```bash
git push -u origin worktree-2885-publish-asset-gate
gh pr create --base DEV --title "fix(#2885): gate content publish on approuter-served CSS/JS assets (QA + CLI)" --body "<summary + Closes #2885>"
```
