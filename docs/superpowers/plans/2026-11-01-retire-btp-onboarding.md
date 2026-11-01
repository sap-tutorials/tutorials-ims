# Retire btp-onboarding Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all references to the `btp-onboarding` and `btp-onboarding-Contribution` GitHub repos from the tracked codebase so those repos can be fully decommissioned.

**Architecture:** The seven `btp-ea-onboard-*` tutorial slugs are registered in `discovery-baseline.json` (fetch source) and `hashes.json` (content hash registry). `hugo/content/tutorials/`, `hugo/content-qa/tutorials/`, `hugo/content/concepts/`, and `hugo/data/browse.json` are **generated/gitignored** — they are not edited directly and will be correct after the next `fetch-tutorials` + `build:all` run (the retired slugs will simply be absent). The only tracked files requiring changes are the two JSON registries.

**Tech Stack:** Node.js, JSON

**Spec:** No separate spec — retirement scope defined in conversation context.

## Global Constraints

- Never edit generated files (`hugo/content/tutorials/`, `hugo/content-qa/tutorials/`, `hugo/content/concepts/`, `hugo/data/browse.json`, `hashes.json` entries for other slugs, `gen/`) — only the two tracked JSON registries.
- Preserve all non-`btp-ea-onboard-*` entries in both files exactly.
- Seven slugs to retire: `btp-ea-onboard-01-intro`, `btp-ea-onboard-02-ga`, `btp-ea-onboard-03-subb`, `btp-ea-onboard-04-subm`, `btp-ea-onboard-05-abapb`, `btp-ea-onboard-06-abapm`, `btp-ea-onboard-07-cli`.

## Review Focus

- `hashes.json` is a single-line JSON object — a naive string delete could corrupt JSON syntax; verify it parses cleanly after edit.
- `discovery-baseline.json` entries are 5 lines each (key + slug + repo + branch + closing brace + comma) — verify no trailing comma is left after the last deleted block.
- Other slugs that happen to contain the substring `btp-ea-onboard` (there are none, but confirm) must not be deleted.

---

### Task 1: Remove 7 slugs from `scripts/parsers/discovery-baseline.json`

**Files:**
- Modify: `scripts/parsers/discovery-baseline.json` (lines 1512–1546 — the 7 contiguous `btp-ea-onboard-*` blocks)

**Interfaces:**
- Produces: `discovery-baseline.json` with no `btp-onboarding` repo references; consumed by `fetch-tutorials` at build time.

- [ ] **Step 1: Use Node to delete the 7 keys and write back**

```bash
node -e "
const fs = require('fs');
const f = 'scripts/parsers/discovery-baseline.json';
const db = JSON.parse(fs.readFileSync(f, 'utf8'));
const slugs = [
  'btp-ea-onboard-01-intro','btp-ea-onboard-02-ga','btp-ea-onboard-03-subb',
  'btp-ea-onboard-04-subm','btp-ea-onboard-05-abapb','btp-ea-onboard-06-abapm',
  'btp-ea-onboard-07-cli'
];
slugs.forEach(s => delete db[s]);
fs.writeFileSync(f, JSON.stringify(db, null, 2) + '\n');
console.log('remaining btp-ea-onboard keys:', Object.keys(db).filter(k => k.startsWith('btp-ea-onboard')));
"
```

Expected: prints `remaining btp-ea-onboard keys: []`

- [ ] **Step 2: Verify the file still parses**

```bash
node -e "require('./scripts/parsers/discovery-baseline.json'); console.log('OK');"
```

Expected: `OK`

- [ ] **Step 3: Verify no btp-onboarding repo references remain**

```bash
grep -c "btp-onboarding" scripts/parsers/discovery-baseline.json && echo "FAIL: still has refs" || echo "PASS: clean"
```

Expected: `PASS: clean` (grep exits 1 when no matches → the `||` branch fires)

- [ ] **Step 4: Commit**

```bash
git add scripts/parsers/discovery-baseline.json
git commit -m "chore: remove btp-ea-onboard-* slugs from discovery-baseline (retire btp-onboarding repo)"
```

---

### Task 2: Remove 7 slug keys from `hashes.json`

**Files:**
- Modify: `hashes.json` (root — single-line JSON map of slug → content hash)

**Interfaces:**
- Produces: `hashes.json` with no `btp-ea-onboard-*` keys; consumed by `publish-content.ts` for delta detection.

- [ ] **Step 1: Use Node to delete the 7 keys and write back**

```bash
node -e "
const fs = require('fs');
const f = 'hashes.json';
const h = JSON.parse(fs.readFileSync(f, 'utf8'));
const slugs = [
  'btp-ea-onboard-01-intro','btp-ea-onboard-02-ga','btp-ea-onboard-03-subb',
  'btp-ea-onboard-04-subm','btp-ea-onboard-05-abapb','btp-ea-onboard-06-abapm',
  'btp-ea-onboard-07-cli'
];
slugs.forEach(s => delete h[s]);
fs.writeFileSync(f, JSON.stringify(h));
console.log('remaining btp-ea-onboard keys:', Object.keys(h).filter(k => k.startsWith('btp-ea-onboard')));
"
```

Expected: prints `remaining btp-ea-onboard keys: []`

Note: `hashes.json` is a minified single-line file — write back without pretty-printing (`JSON.stringify(h)`, no indent arg).

- [ ] **Step 2: Verify the file still parses**

```bash
node -e "require('./hashes.json'); console.log('OK');"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add hashes.json
git commit -m "chore: remove btp-ea-onboard-* hashes (retire btp-onboarding repo)"
```

---

### Task 3: Run unit tests and open PR

**Files:**
- No changes — verification and PR only.

- [ ] **Step 1: Run unit tests**

```bash
npm test
```

Expected: all tests pass. (The `purge-orphans-cap.test.js` fixture uses these slug names as example strings in `formatStepSummary` output — those tests are unrelated to slug existence and should still pass unchanged.)

- [ ] **Step 2: Open PR**

```bash
git push -u origin worktree-retire-btp-onboarding
gh pr create \
  --base DEV \
  --title "chore: retire btp-onboarding repo — remove 7 btp-ea-onboard-* slugs" \
  --body "$(cat <<'EOF'
## Summary

- Removes all 7 `btp-ea-onboard-*` slugs from `scripts/parsers/discovery-baseline.json` (fetch source registry) so `fetch-tutorials` no longer pulls from the decommissioned `sap-tutorials/btp-onboarding` and `sap-tutorials/btp-onboarding-Contribution` repos.
- Removes the corresponding 7 keys from `hashes.json` (content-hash registry).

## What is NOT changed (generated files, rebuilt on next `build:all`)

- `hugo/content/tutorials/btp-ea-onboard-*.md` — gitignored; gone after next `fetch-tutorials`
- `hugo/content-qa/tutorials/btp-ea-onboard-*.md` — same
- `hugo/content/concepts/*.md` (`teaches:` refs) — same
- `hugo/data/browse.json` — rebuilt each build
- `verdicts/preflight-smoke.json` — stale smoke results, overwritten on next run

## Test plan

- [ ] `npm test` passes locally
- [ ] After merge to DEV + deploy: `fetch-tutorials` no longer attempts to clone `btp-onboarding`
- [ ] After `build:all`: no `btp-ea-onboard-*` pages appear in browse or sitemap
EOF
)"
```

- [ ] **Step 3: Post PR URL in conversation as final report**
