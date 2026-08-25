# Tutorial CI — PR Checks Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a central, org-maintained GitHub Actions pipeline that runs notify-only PR content checks (markdownlint, link check, gitleaks secret scan) on every `sap-tutorials` content repo, surfaced as inline annotations + a sticky comment, replacing the CircleCI orb.

**Architecture:** One central repo `sap-tutorials/tutorial-ci` holds a reusable `workflow_call` workflow (runs the linters over changed markdown, emits annotations, uploads a normalized findings artifact, always exits 0), a trusted `workflow_run` workflow (mints the existing GitHub App token, posts a sticky comment), shared tool configs, a findings normalizer script, and a fan-out rollout workflow. Each content repo carries a ~10-line caller pinned to `@v1`. The SAP-specific content checker is added later by Plan 2.

**Tech Stack:** GitHub Actions (reusable + `workflow_run` workflows), `markdownlint-cli2`, `lychee`, `gitleaks`, `actions/create-github-app-token@v1`, `marocchino/sticky-pull-request-comment`, Node.js (findings normalizer + its Vitest tests), `gh` CLI (rollout).

**Spec:** `docs/superpowers/specs/2026-08-25-org-tutorial-pr-checks-design.md`

**Target repos:** Implementation creates and populates `sap-tutorials/tutorial-ci` on `github.tools.sap`. It does NOT add code to `tutorials-ims` (this repo) beyond the spec/plan docs. Executors need `gh` authenticated to `github.tools.sap` (already configured) with repo-create rights in the org.

## Global Constraints

- **Notify, never block.** Every workflow exits 0; findings are `warning`/`notice` annotations only; no branch-protection required check is added; gitleaks and all linters run in report mode.
- **No stored PATs.** Write access for cross-repo commenting uses the existing App via `actions/create-github-app-token@v1` with secrets `TUTORIALS_APP_ID` / `TUTORIALS_APP_PRIVATE_KEY`. Everything else uses the job `GITHUB_TOKEN`.
- **Caller pinned to `@v1`.** A moving major tag; per-repo callers reference `sap-tutorials/tutorial-ci/.github/workflows/tutorial-pr-checks.yml@v1`. Central non-breaking changes propagate with no repo edits.
- **Single `pull_request` trigger for all repos** — types `[opened, synchronize, reopened]`. No source-vs-Contribution split.
- **Fork-safe.** The reusable workflow runs on the untrusted `pull_request` context with read-only token and never executes PR-supplied scripts (only our pinned tools). Commenting happens only in the trusted `workflow_run` workflow.
- **Findings JSON schema** (the contract between the two workflows): array of `{category, file, line, severity, rule, message}` where `category ∈ {markdown, links, secrets, content}`, `severity ∈ {warning, notice}`.
- **Host repo:** `sap-tutorials/tutorial-ci`. **Repo enumeration:** auto-detect by orb reference in `.circleci/config.yml`.

---

### Task 1: Create the `tutorial-ci` repo and skeleton

**Files:**
- Create: `sap-tutorials/tutorial-ci` repo (internal visibility) with `README.md`, `.gitignore` (Node), `LICENSE`
- Create: directory skeleton `.github/workflows/`, `config/`, `scripts/`, `caller-template/`, `test/fixtures/`

**Interfaces:**
- Produces: the repo and its layout that every later task writes into.

- [ ] **Step 1: Create the repo**

```bash
gh repo create sap-tutorials/tutorial-ci --internal \
  --description "Central org-maintained PR content checks for SAP tutorial repos" \
  --add-readme
gh repo clone sap-tutorials/tutorial-ci
cd tutorial-ci
```

- [ ] **Step 2: Scaffold directories and a Node project**

```bash
mkdir -p .github/workflows config scripts caller-template test/fixtures
npm init -y
npm pkg set type=module
npm pkg set scripts.test="vitest run"
npm i -D vitest
printf "node_modules/\n*.log\n" > .gitignore
```

- [ ] **Step 3: Write the README overview**

Write `README.md` describing: purpose, the `@v1` caller snippet, that checks are notify-only, and a "how to update centrally" note. (Copy the caller snippet from Task 6 Step 1.)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold tutorial-ci central checks repo"
git push
```

---

### Task 2: Shared tool configs + config-validation fixtures

**Files:**
- Create: `config/markdownlint.yaml`, `config/gitleaks.toml`, `config/lychee.toml`
- Create: `test/fixtures/clean.md`, `test/fixtures/bad-markdown.md`, `test/fixtures/planted-secret.md`
- Create: `test/config-smoke.test.js`

**Interfaces:**
- Produces: config file paths consumed by the reusable workflow (Task 5) and the fixtures reused by the pilot (Task 6).

- [ ] **Step 1: Write `config/markdownlint.yaml`**

Tuned for tutorials: disable line-length (`MD013: false`), disable inline-HTML rule (`MD033: false`, tutorials embed HTML), require ATX headings, disallow bare URLs off (`MD034: false` — link check handles URLs). Example:

```yaml
default: true
MD013: false   # line length — tutorials have long lines
MD033: false   # inline HTML allowed
MD034: false   # bare URLs handled by link check
MD041: false   # first-line-heading — frontmatter precedes headings
```

- [ ] **Step 2: Write `config/gitleaks.toml`**

Extend gitleaks defaults with SAP-flavored rules. Example:

```toml
[extend]
useDefault = true

[[rules]]
id = "sap-btp-service-key"
description = "BTP service key / VCAP credentials blob"
regex = '''(?i)"(clientsecret|client_secret)"\s*:\s*"[^"]{12,}"'''
tags = ["sap", "btp"]

[[rules]]
id = "sap-default-env"
description = "default-env.json committed with credentials"
path = '''(?i)default-env\.json$'''
tags = ["sap", "btp"]

[[rules]]
id = "github-pat"
description = "GitHub PAT"
regex = '''gh[pousr]_[A-Za-z0-9]{36,}'''
tags = ["github"]
```

- [ ] **Step 3: Write `config/lychee.toml`**

Warn-only link check with an allowlist for flaky/auth hosts and retries:

```toml
max_retries = 2
timeout = 20
accept = [200, 206, 429]
exclude = [
  "^https?://localhost",
  "^https?://.*\\.cfapps\\.",
  "^https?://api\\.sap\\.com",
]
```

- [ ] **Step 4: Write fixtures**

`test/fixtures/clean.md` — valid tutorial markdown, no issues. `test/fixtures/bad-markdown.md` — a trailing-space + missing-blank-line-around-heading violation. `test/fixtures/planted-secret.md` — contains `ghp_` + 36 chars of fake base62 and a fake `"clientsecret": "abcdefghijkl123"`.

- [ ] **Step 5: Write `test/config-smoke.test.js`**

Shells out to the installed tools against fixtures, asserting the configs behave. Requires the tools on PATH (documented as a dev prereq in README). Example:

```js
import { execFileSync } from "node:child_process";
import { test, expect } from "vitest";

const run = (cmd, args) => {
  try { return { code: 0, out: execFileSync(cmd, args, { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout}${e.stderr}` }; }
};

test("gitleaks flags the planted secret fixture", () => {
  const r = run("gitleaks", ["detect", "--no-git", "--source", "test/fixtures/planted-secret.md", "-c", "config/gitleaks.toml"]);
  expect(r.code).not.toBe(0); // gitleaks exits non-zero when leaks found
});

test("gitleaks passes the clean fixture", () => {
  const r = run("gitleaks", ["detect", "--no-git", "--source", "test/fixtures/clean.md", "-c", "config/gitleaks.toml"]);
  expect(r.code).toBe(0);
});
```

- [ ] **Step 6: Run the smoke tests, expect PASS**

Run: `npx vitest run test/config-smoke.test.js`
Expected: both tests PASS (install `gitleaks` locally first if absent). If the tools aren't available in the dev env, mark this test `test.skipIf(!hasTool)` and rely on Task 6 pilot verification instead.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: shared markdownlint/gitleaks/lychee configs + fixtures"
git push
```

---

### Task 3: Findings normalizer script (unit-tested core)

**Files:**
- Create: `scripts/normalize-findings.js`
- Create: `test/normalize-findings.test.js`

**Interfaces:**
- Produces: `normalizeFindings({ markdownlint, gitleaks, lychee }) → Finding[]` where `Finding = {category, file, line, severity, rule, message}`. Consumed by the reusable workflow (Task 5) to build `findings.json` and by the comment renderer (Task 5b/Task 5).
- Produces: `renderAnnotations(findings) → string` emitting `::warning file=…,line=…,title=…::message` lines.
- Produces: `renderComment(findings, { sha }) → string` markdown grouped by category with counts.

- [ ] **Step 1: Write failing tests for the normalizer**

```js
import { describe, test, expect } from "vitest";
import { normalizeFindings, renderAnnotations, renderComment } from "../scripts/normalize-findings.js";

describe("normalizeFindings", () => {
  test("maps markdownlint-cli2 jsonl to findings", () => {
    const markdownlint = [{ fileName: "a.md", lineNumber: 3, ruleNames: ["MD009"], ruleDescription: "Trailing spaces" }];
    const out = normalizeFindings({ markdownlint, gitleaks: [], lychee: [] });
    expect(out).toEqual([{ category: "markdown", file: "a.md", line: 3, severity: "warning", rule: "MD009", message: "Trailing spaces" }]);
  });

  test("maps gitleaks report entries to secret findings", () => {
    const gitleaks = [{ File: "b.md", StartLine: 5, RuleID: "github-pat", Description: "GitHub PAT" }];
    const out = normalizeFindings({ markdownlint: [], gitleaks, lychee: [] });
    expect(out[0]).toMatchObject({ category: "secrets", file: "b.md", line: 5, rule: "github-pat", severity: "warning" });
  });

  test("maps lychee failures to notice-level link findings", () => {
    const lychee = { fail_map: { "c.md": [{ url: "https://dead.example", status: "404" }] } };
    const out = normalizeFindings({ markdownlint: [], gitleaks: [], lychee });
    expect(out[0]).toMatchObject({ category: "links", file: "c.md", severity: "notice", message: expect.stringContaining("dead.example") });
  });
});

describe("renderAnnotations", () => {
  test("emits a workflow warning command per finding", () => {
    const s = renderAnnotations([{ category: "markdown", file: "a.md", line: 3, severity: "warning", rule: "MD009", message: "Trailing spaces" }]);
    expect(s).toContain("::warning file=a.md,line=3,title=markdown/MD009::Trailing spaces");
  });
});

describe("renderComment", () => {
  test("groups by category with counts and a clean-state message", () => {
    expect(renderComment([], { sha: "abc123" })).toContain("No issues found");
    const c = renderComment([{ category: "secrets", file: "b.md", line: 5, severity: "warning", rule: "github-pat", message: "GitHub PAT" }], { sha: "abc123" });
    expect(c).toContain("### Secrets (1)");
    expect(c).toContain("b.md:5");
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npx vitest run test/normalize-findings.test.js`
Expected: FAIL — module `scripts/normalize-findings.js` not found.

- [ ] **Step 3: Implement `scripts/normalize-findings.js`**

Implement `normalizeFindings`, `renderAnnotations`, `renderComment` exactly matching the assertions: markdownlint → `markdown`/`warning`; gitleaks → `secrets`/`warning`; lychee `fail_map` → `links`/`notice`. `renderComment` starts with a `<!-- tutorial-ci-findings -->` sticky marker line, then either "✅ No issues found" or category sections `### <Category> (<n>)` with `` `file:line` — message `` bullets, and a footer `_Checked ${sha} • notify-only, does not block merge_`.

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx vitest run test/normalize-findings.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/normalize-findings.js test/normalize-findings.test.js
git commit -m "feat: findings normalizer + annotation/comment renderers"
git push
```

---

### Task 4: Reusable check workflow `tutorial-pr-checks.yml`

**Files:**
- Create: `.github/workflows/tutorial-pr-checks.yml`

**Interfaces:**
- Consumes: `config/*` (Task 2), `scripts/normalize-findings.js` (Task 3).
- Produces: an artifact `tutorial-ci-findings` containing `findings.json` (the schema from Global Constraints) plus `pr-meta.json` (`{ pr_number, head_sha, base_sha, repo }`), consumed by Task 5.

- [ ] **Step 1: Write the workflow**

`on: workflow_call`. `permissions: { contents: read }`. Single job `checks` (always `if: always()` on the aggregation step; job never fails):
1. `actions/checkout` with `fetch-depth: 0` (needs base for diff).
2. Compute changed markdown: `git diff --name-only origin/${{ github.base_ref }}...HEAD -- '*.md' > changed.txt`.
3. `markdownlint-cli2` over changed files with `config/markdownlint.yaml`, output JSON to `ml.json` (`--output` / formatter), `continue-on-error: true`.
4. `gitleaks detect --no-git --report-format json --report-path gl.json -c config/gitleaks.toml` over the changed files/diff, `continue-on-error: true`.
5. `lychee --format json --output ly.json` over changed markdown with `config/lychee.toml`, `continue-on-error: true`.
6. Run `node scripts/normalize-findings.js ml.json gl.json ly.json > findings.json` (add a small CLI shim at the bottom of the script that reads the three files and prints `JSON.stringify(normalizeFindings(...))`).
7. Emit annotations: `node -e "…"` or a step that reads `findings.json` and prints `renderAnnotations(...)` to stdout (GitHub picks up the `::warning::` commands).
8. Write `pr-meta.json` from `github.event.pull_request`.
9. `actions/upload-artifact` name `tutorial-ci-findings` with `findings.json` + `pr-meta.json`.
10. Final `run: exit 0`.

Copy the exact YAML into the file. Vendor the tools via their official actions (`DavidAnson/markdownlint-cli2-action`, `gitleaks/gitleaks-action` or the binary, `lycheeverse/lychee-action`) pinned to a tag.

- [ ] **Step 2: Lint the workflow YAML**

Run: `npx --yes @action-validator/cli .github/workflows/tutorial-pr-checks.yml` (or `actionlint` if available).
Expected: no schema errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/tutorial-pr-checks.yml scripts/normalize-findings.js
git commit -m "feat: reusable PR checks workflow (annotations + findings artifact)"
git push
```

> Live end-to-end verification of this workflow happens in Task 6 (needs a caller + a real PR).

---

### Task 5: Trusted comment workflow `post-results.yml`

**Files:**
- Create: `.github/workflows/post-results.yml`

**Interfaces:**
- Consumes: the `tutorial-ci-findings` artifact (Task 4), `renderComment` (Task 3), App secrets `TUTORIALS_APP_ID` / `TUTORIALS_APP_PRIVATE_KEY`.
- Produces: a sticky PR comment on the source repo's PR.

- [ ] **Step 1: Write the workflow**

`on: workflow_run: { workflows: ["Tutorial PR Checks"], types: [completed] }`. `permissions: { actions: read }` (write to PRs comes from the App token, not `GITHUB_TOKEN`). Job steps:
1. Guard: only proceed if `github.event.workflow_run.event == 'pull_request'`.
2. `actions/download-artifact` using the `workflow_run` run id to fetch `findings.json` + `pr-meta.json`.
3. `actions/create-github-app-token@v1` with `app-id: ${{ secrets.TUTORIALS_APP_ID }}`, `private-key: ${{ secrets.TUTORIALS_APP_PRIVATE_KEY }}`, `owner: sap-tutorials`, `repositories: ${{ <repo from pr-meta> }}`.
4. `node -e` reads `findings.json` + `pr-meta.json`, calls `renderComment(findings, { sha })`, writes `comment.md`.
5. `marocchino/sticky-pull-request-comment@v2` with `token: ${{ steps.app-token.outputs.token }}`, `repo`/`number` from `pr-meta.json`, `header: tutorial-ci`, `path: comment.md`. (Sticky rewrites the single comment each run.)

- [ ] **Step 2: Lint the workflow YAML**

Run: `npx --yes @action-validator/cli .github/workflows/post-results.yml`
Expected: no schema errors.

- [ ] **Step 3: Commit + cut the `v1` tag**

```bash
git add .github/workflows/post-results.yml
git commit -m "feat: trusted workflow_run comment poster using existing GitHub App"
git push
git tag -f v1 && git push -f origin v1
```

---

### Task 6: Caller template + pilot end-to-end verification

**Files:**
- Create: `caller-template/tutorial-pr-checks.yml`
- Modify (pilot): `sap-tutorials/btp-foundation-Contribution/.github/workflows/tutorial-pr-checks.yml`

**Interfaces:**
- Consumes: reusable workflow `@v1` (Tasks 4–5).
- Produces: the proven caller other repos will receive (Task 7).

- [ ] **Step 1: Write `caller-template/tutorial-pr-checks.yml`**

```yaml
name: Tutorial PR Checks
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  checks:
    uses: sap-tutorials/tutorial-ci/.github/workflows/tutorial-pr-checks.yml@v1
    permissions:
      contents: read
    secrets: inherit
```

- [ ] **Step 2: Install the caller on the pilot repo**

```bash
gh api -X PUT repos/sap-tutorials/btp-foundation-Contribution/contents/.github/workflows/tutorial-pr-checks.yml \
  -f message="ci: add central Tutorial PR Checks caller (pilot)" \
  -f content="$(base64 -w0 caller-template/tutorial-pr-checks.yml)" \
  -f branch="ci/pilot-pr-checks"
# open a PR for the caller addition itself, merge to the pilot's default branch
```

Ensure the App is installed on `btp-foundation-Contribution` and org secrets `TUTORIALS_APP_ID`/`TUTORIALS_APP_PRIVATE_KEY` are visible to it (org-level Actions secrets).

- [ ] **Step 3: Fixture PR — clean**

Open a branch PR touching a valid `.md`. Expected: check run succeeds (green, neutral), sticky comment says "✅ No issues found", PR is mergeable with no required check.

- [ ] **Step 4: Fixture PR — planted secret + bad markdown**

Open a branch PR adding content from `test/fixtures/planted-secret.md` and `bad-markdown.md`. Expected: inline annotations on the offending lines; sticky comment shows `### Secrets (1)` and `### Markdown (n)`; workflow still exits 0; PR still mergeable.

- [ ] **Step 5: Fixture PR — from a fork**

Fork the pilot repo, open a PR from the fork with the same bad content. Expected: annotations appear from the `pull_request` run (read-only), and the `post-results.yml` `workflow_run` posts the sticky comment via the App token. Confirm no secret-exposure warnings and the comment appears despite the fork.

- [ ] **Step 6: Record results + commit any config tuning**

If noise/false-positives appear, tune `config/*` and re-cut `v1`. Commit tuning:

```bash
git add config/ && git commit -m "fix: tune check configs from pilot findings" && git push
git tag -f v1 && git push -f origin v1
```

---

### Task 7: Rollout fan-out workflow `rollout.yml`

**Files:**
- Create: `.github/workflows/rollout.yml`
- Create: `scripts/list-target-repos.js`
- Create: `test/list-target-repos.test.js`

**Interfaces:**
- Consumes: the App token (write to content repos), `caller-template/tutorial-pr-checks.yml`.
- Produces: PRs on each target repo adding the caller and removing `.circleci/`.

- [ ] **Step 1: Write failing test for target detection**

```js
import { test, expect } from "vitest";
import { isTargetRepo } from "../scripts/list-target-repos.js";

test("repo referencing the tutorial-checker orb is a target", () => {
  expect(isTargetRepo("orbs:\n  x: saptutorials/tutorial-checker@1.0.0\n")).toBe(true);
});
test("repo with no orb reference is not a target", () => {
  expect(isTargetRepo("version: 2.1\njobs: {}\n")).toBe(false);
});
test("missing circleci config is not a target", () => {
  expect(isTargetRepo(null)).toBe(false);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `npx vitest run test/list-target-repos.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/list-target-repos.js`**

Export `isTargetRepo(circleCiConfigText | null) → boolean` (true iff text includes `saptutorials/tutorial-checker`). Add a CLI mode: enumerate org repos via `gh api`, fetch each `.circleci/config.yml`, print the JSON list of targets. Include a `--dry-run` that only prints.

- [ ] **Step 4: Run test, expect PASS**

Run: `npx vitest run test/list-target-repos.test.js`
Expected: PASS.

- [ ] **Step 5: Write `rollout.yml`**

`on: { workflow_dispatch: { inputs: { dry_run: {type: boolean, default: true}, only: {description: "csv repo allowlist", required: false} } }, schedule: [{cron: "17 6 * * 1"}] }`. Steps: mint App token → `node scripts/list-target-repos.js` → for each target (respecting `only`/`dry_run`): create branch, add caller from `caller-template/`, delete `.circleci/`, open PR titled "ci: adopt central Tutorial PR Checks, remove CircleCI". Idempotent: skip if caller already present and identical. On schedule run, `dry_run` reports drift as a summary without opening PRs.

- [ ] **Step 6: Dry-run verification**

Run the workflow with `dry_run: true`. Expected: summary lists exactly the repos currently referencing the orb; no PRs opened.

- [ ] **Step 7: Commit + re-tag**

```bash
git add .github/workflows/rollout.yml scripts/list-target-repos.js test/list-target-repos.test.js
git commit -m "feat: rollout fan-out (orb-reference auto-detect, caller install, circleci removal)"
git push && git tag -f v1 && git push -f origin v1
```

---

### Task 8: Seed templates for new repos

**Files:**
- Modify: `sap-tutorials/tutorial-repo-template` — add `.github/workflows/tutorial-pr-checks.yml`, remove `.circleci/`
- Modify: `sap-tutorials/tutorial-repo-Contribution-template` — same
- Modify: `sap-tutorials/repository-template` — same

**Interfaces:**
- Consumes: `caller-template/tutorial-pr-checks.yml`.
- Produces: new repos created from these templates inherit the checks and carry no CircleCI.

- [ ] **Step 1: Add caller + remove CircleCI in each template via PR**

For each of the three template repos, open a PR that commits the caller file and deletes `.circleci/`. Use the same `gh api` pattern as Task 6 Step 2.

- [ ] **Step 2: Verify a fresh repo from the template**

Create a throwaway repo from `tutorial-repo-Contribution-template`, open a trivial PR, confirm the checks run and comment. Delete the throwaway repo.

- [ ] **Step 3: Merge the template PRs**

Merge once verified. (No commit in `tutorial-ci` for this task — changes live in the template repos.)

---

### Task 9: Full rollout (operational)

**Files:** none in-repo — this is an execution step run against the org.

- [ ] **Step 1: Rollout dry-run review**

Run `rollout.yml` with `dry_run: true`; confirm the target list matches the CircleCI footprint (both source and `*-Contribution` repos). Get Tom's sign-off on the list.

- [ ] **Step 2: Execute rollout in batches**

Run `rollout.yml` with `dry_run: false`, optionally batching via `only` (e.g. 5 repos at a time). Each run opens PRs adding the caller + removing `.circleci/`.

- [ ] **Step 3: Merge rollout PRs + spot-check**

Merge the generated PRs. Spot-check 2–3 repos: open a PR, confirm annotations + sticky comment, confirm no CircleCI job runs.

- [ ] **Step 4: Enable weekly drift check**

Confirm the scheduled `rollout.yml` cron is active (drift reporting). Done.

---

## Self-Review

**Spec coverage:**
- §4.1 central repo → Task 1. §4.2 caller → Task 6. §4.3 two-workflow + App token → Tasks 4, 5. §4.4 notify-not-block → Global Constraints + Task 4 Step 1 (exit 0) + Task 6 verification. §5 checks (markdownlint/lychee/gitleaks) → Tasks 2, 4. §5 SAP content check → **deferred to Plan 2** (documented; reusable workflow leaves a slot). §6 rollout → Tasks 7, 9. Templates → Task 8. §10 testing → Tasks 2, 3, 6, 7. §12 risks → config tuning (Task 6), fork pattern (Tasks 4–5).
- Gap acknowledged: the `content` category in the findings schema is populated only once Plan 2 adds the SAP checker; until then it is always empty (harmless).

**Placeholder scan:** No "TBD"/"handle edge cases" — each step has concrete commands/code. Off-the-shelf action version pins are named but left to the executor to resolve to the latest stable tag at implementation time (acceptable — these are external actions, not our code).

**Type consistency:** `normalizeFindings`/`renderAnnotations`/`renderComment` signatures and the `Finding` shape (`{category, file, line, severity, rule, message}`) are consistent across Tasks 3, 4, 5. `isTargetRepo` consistent in Task 7. Artifact name `tutorial-ci-findings` consistent in Tasks 4, 5. `v1` tag consistent across Tasks 5–7.
