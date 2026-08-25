# Org-Wide Tutorial PR Content Checks — Design

**Date:** 2026-08-25
**Status:** Draft for review
**Author:** Tom (with Claude)
**Scope:** `sap-tutorials` org on `github.tools.sap` (internal GHE)

## 1. Goal

Give tutorial authors fast, automatic feedback on PRs — markdown quality,
content/format correctness, and leaked-secret detection — that **notifies but
never blocks** the PR. The checks must be maintained **centrally at the org
level** (not copied-and-forgotten into each repo) and installed/updated across
repos by automation, mirroring how the content-publishing workflows are managed.

This replaces the CircleCI orb (`saptutorials/tutorial-checker@1.0.0`), which is
being decommissioned.

## 2. Current State (verified 2026-08-25)

- **CircleCI is the only PR content-check mechanism today.** Every content repo
  and both `*-Contribution` counterparts wire a private CircleCI orb
  (`saptutorials/tutorial-checker@1.0.0`) in `.circleci/config.yml`:
  - Source repos run `tutorial-checker-orb/build-pull-request` on PRs + a nightly `build-all`.
  - Contribution repos run `build-last-commit` (env `NODE_ENV=stage`) + nightly.
- **`tutorial-checker`** (Node linter the orb invokes) does SAP-specific validation
  only — no secret scanning. Checkers: spell, content, link, options, file-name,
  validations, tags, metadata, syntax, plus legacy `analyze/` accordion (VALIDATE/DONE)
  reporters. **These rules are legacy (AEM-era) and need a modernization pass** —
  see §7.
- **GitHub Actions in the repos do notification/issue automation only**
  (`label-issues.yml`, `close-issues.yaml`, `notify-tutorials-ims.yml`,
  `notify-qa.yml`, `community-requester-id.yaml`, `assign-tutorial-author.yml`).
  None lint content. A new Actions layer is therefore purely additive.
- **No org-level Actions distribution exists.** `sap-tutorials/.github` has no
  `workflow-templates/` and no `.github/workflows/`.
- **GHAS secret scanning + push protection are ON** (at least on `btp-foundation`),
  but **non-provider pattern scanning is OFF** — loose/custom secrets (BTP service
  keys, `default-env.json` blobs, destination creds) are not caught.
- **Templates** (`tutorial-repo-template`, `tutorial-repo-Contribution-template`,
  `repository-template`) all carry the CircleCI orb wiring; new repos inherit
  CircleCI, not Actions.

### Security finding

`tutorial-checker-orb/src/scripts/prepare.sh` contains a hardcoded GitHub PAT
committed in source. **The leaked token has been confirmed invalid** (already
revoked), so no rotation is required — the only remaining action is deleting the
dead credential from source as hygiene when the orb repo is retired. The new
pipeline stores no PAT and uses either the job `GITHUB_TOKEN` or the existing
`sap-tutorials` GitHub App (below).

## 3. Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Distribution | Central reusable workflow + tiny synced caller per repo |
| Check engine | Hybrid — modernized SAP rules + off-the-shelf linters + secret scan |
| Notification | Sticky PR comment **and** inline diff annotations |
| Repo scope | All content repos (source + `*-Contribution`) |
| Host repo | **New `sap-tutorials/tutorial-ci`** (recommendation; alt: `.github`) |
| Repo enumeration | **Auto-detect by orb reference** in `.circleci/config.yml` (recommendation) |
| Cross-repo comment auth | **Reuse existing `sap-tutorials` GitHub App** (`TUTORIALS_APP_ID` / `TUTORIALS_APP_PRIVATE_KEY` via `actions/create-github-app-token@v1`) |

The host-repo and enumeration choices are recommendations, open for Tom to flip at
spec review.

## 4. Architecture

### 4.1 Central repo: `sap-tutorials/tutorial-ci`

Single home for all logic, config, and rollout automation:

```
tutorial-ci/
  .github/workflows/
    tutorial-pr-checks.yml        # reusable (workflow_call) — runs all linters
    post-results.yml              # trusted (workflow_run) — posts sticky comment
    rollout.yml                   # fan-out installer/updater (manual + scheduled)
  config/
    markdownlint.yaml             # shared markdownlint-cli2 config
    gitleaks.toml                 # default rules + SAP custom patterns
    lychee.toml                   # link-check config (allowlist, timeouts)
  checker/                        # modernized SAP content checker (see §7)
    action.yml                    # composite action wrapping the checker
    src/...
  caller-template/
    tutorial-pr-checks.yml        # the ~10-line file synced into each repo
  README.md
```

A moving major tag `@v1` (re-pointed on releases) lets callers pin to `@v1` and
receive non-breaking updates automatically; breaking changes cut `@v2`.

### 4.2 Per-repo caller (synced, ~10 lines)

Added to both templates and pushed into existing content repos by `rollout.yml`:

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

The caller is intentionally trivial and stable; all behavior changes happen
centrally. Standardizing on `pull_request` for **all** repos removes the legacy
source-vs-Contribution (`build-pull-request` vs `build-last-commit`) split.

### 4.3 Notification: token model and fork handling

Contribution PRs are **usually same-repo branches** (contributors are collaborators),
but **forks still occur**. This matters only for token permissions:

- **Branch PR** → `pull_request` `GITHUB_TOKEN` has **write** scope; a comment can be
  posted from the same run.
- **Fork PR** → `GITHUB_TOKEN` is **read-only** *and* org/repo secrets (including the
  App key) are **not exposed** to the fork run. A comment cannot be posted from that
  run; only inline annotations work.

To give **every** author the same comment + annotations regardless of branch vs fork,
use the two-workflow pattern with the **existing GitHub App** as the write credential:

1. **`tutorial-pr-checks.yml`** (reusable, triggered via the caller on
   `pull_request`, read-only token):
   - Checks out the PR head (data only; we run *our* pinned tools, never the PR's
     `package.json` scripts).
   - Runs markdownlint, lychee, gitleaks, and the SAP checker over the changed
     `.md` files.
   - Emits **inline annotations** via `::warning file=…,line=…::` (annotations do
     not require write scope and work even on fork runs).
   - Writes a normalized findings JSON and uploads it as an **artifact**.
   - Always exits 0.
2. **`post-results.yml`** (trusted, in `tutorial-ci`, triggered on
   `workflow_run: completed`, runs in the base-repo context with secret access):
   - Mints a token from the existing App via
     `actions/create-github-app-token@v1` (`TUTORIALS_APP_ID` /
     `TUTORIALS_APP_PRIVATE_KEY`), scoped to the content repos.
   - Downloads the findings artifact from the triggering run.
   - Renders/updates a **sticky PR comment** (single comment, rewritten each push;
     e.g. `marocchino/sticky-pull-request-comment`), grouped by category
     (Markdown / Content / Links / Secrets), with counts and per-file detail.
   - Never fails the PR.

> **Simpler alternative (rejected):** a single `pull_request` workflow that comments
> inline. It works for branch PRs but silently drops the sticky comment on fork PRs
> (annotations only). Because community authors are the ones most likely to fork —
> and are exactly who we most want to notify — we keep the two-workflow pattern for
> uniform coverage. Flip to single-workflow only if fork PRs are ruled out entirely.

### 4.4 Notify-not-block guarantee

- Every check job runs to completion and the workflow exits 0.
- Findings are reported as `warning`/`notice` annotations, never `error` that
  fails the run.
- No branch-protection rule is added to require these checks.
- gitleaks and the SAP checker run in "report" mode, not "fail" mode.

## 5. Checks

All operate on the PR's changed markdown (diff against the PR base), except secret
scanning which scans the full diff (any file type).

1. **Markdown lint** — `markdownlint-cli2` with `config/markdownlint.yaml`
   (shared, tuned to tutorial conventions; e.g. relax line-length, enforce heading
   structure, no bare URLs).
2. **Link check** — `lychee` over changed `.md`, warn-only; allowlist + retry for
   flaky hosts to keep noise down.
3. **Secret scan** — `gitleaks` on the PR diff with `config/gitleaks.toml`:
   default provider rules **plus** SAP-specific patterns (BTP service keys,
   `default-env.json` credential blobs, destination client secrets, `ghp_`/`gho_`
   PATs, XSUAA client secrets). Complements GHAS (which misses non-provider
   patterns) and surfaces findings *at PR time* with author-facing annotations.
4. **SAP content checks** — the modernized checker (§7) run as a composite action
   against changed `.md` files: frontmatter/metadata contract, tutorial-step
   syntax, tags, options, filename/slug rules.

Each produces normalized findings `{category, file, line, severity, rule, message}`
merged into the artifact consumed by `post-results.yml`.

## 6. Distribution & Rollout

`tutorial-ci/.github/workflows/rollout.yml` (manual `workflow_dispatch` +
scheduled weekly drift check):

1. **Enumerate target repos** — auto-detect: list org repos, keep those whose
   `.circleci/config.yml` references the `tutorial-checker` orb (exactly the
   CircleCI footprint being removed). Fallback/override: an explicit allow/deny
   list in the workflow inputs.
2. For each target, open a PR that:
   - Adds/updates `.github/workflows/tutorial-pr-checks.yml` from
     `caller-template/`.
   - **Removes `.circleci/`** (folds CircleCI decommission into the same PR).
3. Idempotent: skips repos already current; the weekly run reports/repairs drift.
4. Templates (`tutorial-repo-template`, `tutorial-repo-Contribution-template`,
   `repository-template`) get the caller committed directly and their `.circleci/`
   removed, so new repos inherit the Actions checks.

Because the caller only references `@v1`, subsequent central updates need **no**
per-repo change — `rollout.yml` is for initial install + caller-shape changes only.

## 7. SAP Checker Modernization (workstream)

The legacy `tutorial-checker` rules target the AEM-era format. The **current**
source of truth for valid tutorial markdown is this repo's `scripts/parsers/`
(`frontmatter.ts`, `rules.ts`, `options.ts`, `branches.ts`, `os-classifier.ts`,
`prerequisites-markup.ts`, `video.ts`, `images.ts`, `render-frontmatter.ts`, …) —
what the build pipeline actually consumes.

Modernization steps:

1. **Inventory** every legacy checker rule (spell, content, link, options,
   file-name, validations, tags, metadata, syntax, `analyze/` accordion).
2. **Triage each** against `scripts/parsers/` + the current frontmatter contract:
   **keep / update / drop**. Legacy accordion/VALIDATE-DONE rules are strong
   drop candidates unless the current parsers still honor them.
3. **Add missing rules** the current pipeline needs, e.g.:
   - Required frontmatter fields the parsers depend on.
   - **YAML 1.1 boolean coercion** pitfalls (bare `yes/no/on/off` — matches the
     known `hugoFrontmatterStringify` gotcha) that break Hugo frontmatter.
   - Slug/casing rules (lowercase canonical slugs).
   - Step-count / step-structure invariants the parsers assume.
4. **Deliver** a slimmed, current rule set behind `checker/action.yml`, unit-tested
   against real tutorial fixtures.

This workstream lands **incrementally after** the generic pipeline (lint + links +
secrets + comment/annotations) is live, so authors get value immediately while the
SAP rules are reworked. Until modernization completes, the checker can run its
kept-and-verified rules only.

## 8. Open Items (resolve during spec review / planning)

1. **Host repo:** confirm new `sap-tutorials/tutorial-ci` vs hosting reusable
   workflows in `.github`.
2. **Repo enumeration source:** orb-reference auto-detect vs an explicit maintained
   list vs a repo topic/label.

**Resolved during review:**
- *Cross-repo comment credential* → reuse the existing `sap-tutorials` GitHub App
  (`TUTORIALS_APP_ID` / `TUTORIALS_APP_PRIVATE_KEY`); its installation must cover
  the target content repos.
- *Fork model* → PRs are usually branches but forks occur; the two-workflow
  App-token pattern (§4.3) covers both uniformly.
- *Leaked PAT* → confirmed already invalid; no rotation needed (§2).

## 9. Phasing

- **Phase 0** — Create `tutorial-ci` repo; scaffold reusable + trusted workflows;
  wire on one pilot repo (`btp-foundation-Contribution`) end-to-end with a canned
  finding to prove comment + annotations on a fork PR.
- **Phase 1** — Generic checks live (markdownlint + lychee + gitleaks) + notification.
  Roll out via `rollout.yml` to all content repos; remove `.circleci/`.
- **Phase 2** — Checker modernization (§7): inventory, triage, add rules, ship
  composite action; enable SAP content checks in the reusable workflow.
- **Phase 3** — Update the three template repos; enable weekly drift check.

## 10. Testing / Validation

- Reusable workflow validated on the pilot repo with fixture PRs: a clean PR
  (comment says "no issues"), a PR with a planted fake secret, a PR with markdown
  and frontmatter violations — confirm annotations + sticky comment appear and the
  PR remains mergeable (no blocking check).
- Fork-PR path exercised explicitly (fork → PR) to confirm the `workflow_run`
  comment posts under the read-only fork token constraint.
- Checker rules unit-tested against fixtures drawn from real tutorials in the
  content repos.
- `rollout.yml` dry-run mode lists target repos and diffs before opening PRs.

## 11. Out of Scope

- Decommissioning the CircleCI orb *infrastructure* itself (registry cleanup, and
  deleting the dead PAT from the orb source) — only the per-repo `.circleci/`
  wiring is removed here.
- Enabling GHAS non-provider pattern scanning org-wide (complementary; gitleaks
  covers the PR-time author-feedback need).
- Any change to the notification/issue-automation Actions already in the repos.

## 12. Risks & Mitigations

- **Comment noise** → sticky single comment, warn-level severities, tuned lint
  config, link-check allowlist.
- **Fork token limits** → two-workflow `workflow_run` pattern with the existing
  GitHub App token (§4.3) gives uniform comment coverage on branch and fork PRs.
- **Cross-repo auth for commenting** → existing `sap-tutorials` App, least-privilege
  installation limited to the content repos (§4.3).
- **Rollout drift / local edits** → `@v1`-pinned caller keeps logic central;
  weekly drift check repairs callers.
- **Legacy rule false positives** → modernization triages against real parsers
  before enabling SAP checks (§7); generic checks ship first.
