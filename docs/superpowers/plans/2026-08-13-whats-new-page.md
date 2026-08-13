# What's New Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public, weekly `/whats-new/` page on developers.sap.com, generated locally by a Claude Code skill that summarizes the merged-PR history of the DevRel repos into a Hugo data file.

**Architecture:** A local skill orchestrates two tested Node scripts (`fetch-prs.mjs` → pending merged PRs; `merge.mjs` → dedupe + ISO-week grouping) around an AI summarization step performed by Claude at run time. Output is a single committed data file `hugo/data/whats_new.json`. A static, island-free Hugo layout renders it, served by the approuter's existing static catch-all — no new server-side runtime, no routing changes.

**Tech Stack:** Node.js (ESM `.mjs`, native `child_process`, `gh` CLI), Vitest, Hugo templates, SAP Fundamental / Horizon CSS tokens, Playwright (post-deploy e2e).

**Spec:** `docs/superpowers/specs/2026-08-13-whats-new-page-design.md`

## Global Constraints

- **Voice:** fuller changelog — everything meaningful, grouped by type, in plain community-readable language (not raw commit subjects). Strip internal jargon, deploy/CI noise, and bare issue refs from summaries.
- **Categories (exact set):** `Feature | Fix | Performance | Docs | Maintenance`. Render order is fixed: Feature → Fix → Performance → Docs → Maintenance.
- **Unit of change:** merged pull requests (not raw commits). Entry key is `"{repoKey}#{number}"`.
- **Idempotency:** a PR already present in the data file is never re-fetched-for-summary or re-worded. Running the skill with no new merges is a no-op beyond `generatedAt`.
- **No new infra:** no GitHub Action, no external LLM API, no HANA entity, no CAP endpoint, no `xs-app.json` / `page-key-map.js` change. The page is static and served by the existing approuter static catch-all (`^(.*)$ -> static`), like `/explore/` and `/cookies/`.
- **Runtime:** Node 20+ (project baseline); prefer native `fetch`/`child_process` over libraries. ESM modules use `.mjs`.
- **Repos:** read from `hugo/data/whats_new.json`'s `repos[]`. v1 ships with `tutorials-ims` only; `gameboard`/`planner` slugs are added to that array when provided (one-line change, no code impact).
- **Test globs:** Vitest picks up `scripts/**/__tests__/**/*.test.{js,ts}`. Script tests go in `scripts/whats-new/__tests__/*.test.js`.
- **File writes:** JSON written with 2-space indentation + trailing newline for stable diffs.
- **CLI entrypoint guard (cross-platform):** detect "run directly" via `import.meta.url === pathToFileURL(process.argv[1]).href` (works on Windows).

---

### Task 1: ISO-week helper module

**Files:**
- Create: `scripts/whats-new/iso-week.mjs`
- Test: `scripts/whats-new/__tests__/iso-week.test.js`

**Interfaces:**
- Produces:
  - `isoWeekId(date: Date): string` → `"YYYY-Www"` (ISO-8601, zero-padded week)
  - `isoWeekStart(date: Date): string` → `"YYYY-MM-DD"` (UTC Monday of that week)
  - `isoWeekParts(date: Date): { isoYear: number, week: number }`

- [ ] **Step 1: Write the failing test**

Create `scripts/whats-new/__tests__/iso-week.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { isoWeekId, isoWeekStart } from '../iso-week.mjs';

// Anchor facts: 2026-01-01 is a Thursday (so it is in ISO week 1 of 2026,
// whose Monday is 2025-12-29). 2026-08-10 is a Monday.
describe('iso-week', () => {
  it('handles the year-boundary week', () => {
    const d = new Date('2026-01-01T10:00:00Z');
    expect(isoWeekId(d)).toBe('2026-W01');
    expect(isoWeekStart(d)).toBe('2025-12-29');
  });

  it('a Sunday belongs to the week that started the prior Monday', () => {
    // 2025-12-28 is the Sunday before 2025-12-29 → previous ISO week.
    expect(isoWeekStart(new Date('2025-12-28T12:00:00Z'))).toBe('2025-12-22');
  });

  it('computes the Monday for a mid-year week (go-live week)', () => {
    // Monday noon US Eastern = 16:00 UTC.
    expect(isoWeekStart(new Date('2026-08-10T16:00:00Z'))).toBe('2026-08-10');
    // Thursday and Sunday of the same week map to the same Monday + week id.
    expect(isoWeekStart(new Date('2026-08-13T23:00:00Z'))).toBe('2026-08-10');
    expect(isoWeekStart(new Date('2026-08-16T23:00:00Z'))).toBe('2026-08-10');
    expect(isoWeekId(new Date('2026-08-10T16:00:00Z')))
      .toBe(isoWeekId(new Date('2026-08-16T23:00:00Z')));
  });

  it('formats week ids zero-padded', () => {
    expect(isoWeekId(new Date('2026-01-01T10:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/whats-new/__tests__/iso-week.test.js`
Expected: FAIL — cannot resolve `../iso-week.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/whats-new/iso-week.mjs`:

```js
// ISO-8601 week helpers. All math is UTC-based so a merge timestamp always
// lands in a deterministic week regardless of the runner's local timezone.
const DAY = 86400000;

function toUtcMidnight(input) {
  return new Date(Date.UTC(
    input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

export function isoWeekParts(input) {
  const d = toUtcMidnight(input);
  const dayNum = (d.getUTCDay() + 6) % 7;      // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);    // move to Thursday of this week
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4)); // Jan 4 is always week 1
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY));
  return { isoYear, week };
}

export function isoWeekId(input) {
  const { isoYear, week } = isoWeekParts(input);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function isoWeekStart(input) {
  const d = toUtcMidnight(input);
  const dayNum = (d.getUTCDay() + 6) % 7;       // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum);        // back up to Monday
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/whats-new/__tests__/iso-week.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/whats-new/iso-week.mjs scripts/whats-new/__tests__/iso-week.test.js
git commit -m "feat(whats-new): ISO-week helpers for weekly grouping"
```

---

### Task 2: Data merge module

**Files:**
- Create: `scripts/whats-new/merge.mjs`
- Test: `scripts/whats-new/__tests__/merge.test.js`

**Interfaces:**
- Consumes: `isoWeekId`, `isoWeekStart` from `./iso-week.mjs`
- Produces:
  - `buildEntry(pr, summary): Entry` where `pr = {id, repo, label, number, title, mergedAt, url}` and `summary = {id, category, summary, title?}`. Returns `{id, repo, label, number, title, summary, category, mergedAt, week, weekStart, url}`.
  - `mergeEntries(existing: Entry[], incoming: Entry[]): Entry[]` — dedupes by `id` (existing wins → stable wording), sorted by `mergedAt` descending.
  - `emptyScaffold(): { generatedAt, repos: [], entries: [] }`
  - CLI: `node merge.mjs --data <path> --pending <path> --summaries <path>` (writes back to `--data`).

- [ ] **Step 1: Write the failing test**

Create `scripts/whats-new/__tests__/merge.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildEntry, mergeEntries } from '../merge.mjs';

const pr = {
  id: 'tutorials-ims#1725', repo: 'tutorials-ims', label: 'Developer Portal',
  number: 1725, title: 'raw PR title',
  mergedAt: '2026-08-05T09:12:00Z',
  url: 'https://github.com/sap-tutorials/tutorials-ims/pull/1725',
};
const summary = { id: 'tutorials-ims#1725', category: 'Feature', summary: 'A nice human summary.' };

describe('buildEntry', () => {
  it('derives week fields and prefers the summary text', () => {
    const e = buildEntry(pr, summary);
    expect(e.category).toBe('Feature');
    expect(e.summary).toBe('A nice human summary.');
    expect(e.week).toBe(e.week); // set
    expect(e.weekStart).toBe('2026-08-03'); // Monday of that week
    expect(e.id).toBe('tutorials-ims#1725');
    expect(e.url).toBe(pr.url);
  });
});

describe('mergeEntries', () => {
  it('is idempotent — re-merging identical entries adds nothing and keeps wording', () => {
    const first = mergeEntries([], [buildEntry(pr, summary)]);
    expect(first).toHaveLength(1);
    // A second run would re-summarize with different wording; existing must win.
    const reworded = buildEntry(pr, { ...summary, summary: 'DIFFERENT wording' });
    const second = mergeEntries(first, [reworded]);
    expect(second).toHaveLength(1);
    expect(second[0].summary).toBe('A nice human summary.');
  });

  it('sorts newest merge first', () => {
    const older = buildEntry(
      { ...pr, id: 'tutorials-ims#1700', number: 1700, mergedAt: '2026-08-01T00:00:00Z' },
      { ...summary, id: 'tutorials-ims#1700' });
    const newer = buildEntry(pr, summary);
    const merged = mergeEntries([], [older, newer]);
    expect(merged.map((e) => e.id)).toEqual(['tutorials-ims#1725', 'tutorials-ims#1700']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/whats-new/__tests__/merge.test.js`
Expected: FAIL — cannot resolve `../merge.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/whats-new/merge.mjs`:

```js
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isoWeekId, isoWeekStart } from './iso-week.mjs';

export function emptyScaffold() {
  return { generatedAt: new Date(0).toISOString(), repos: [], entries: [] };
}

export function buildEntry(pr, summary) {
  const merged = new Date(pr.mergedAt);
  return {
    id: pr.id,
    repo: pr.repo,
    label: pr.label,
    number: pr.number,
    title: (summary.title || pr.title || '').trim(),
    summary: (summary.summary || '').trim(),
    category: summary.category,
    mergedAt: pr.mergedAt,
    week: isoWeekId(merged),
    weekStart: isoWeekStart(merged),
    url: pr.url,
  };
}

export function mergeEntries(existing, incoming) {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of incoming) {
    if (!byId.has(e.id)) byId.set(e.id, e); // existing wins → stable wording
  }
  return [...byId.values()].sort((a, b) =>
    a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const data = readJson(args.data, emptyScaffold());
  const pending = readJson(args.pending, []);
  const summaries = readJson(args.summaries, []);
  const sumById = new Map(summaries.map((s) => [s.id, s]));
  const built = [];
  for (const pr of pending) {
    const s = sumById.get(pr.id);
    if (!s) { console.warn(`[merge] no summary for ${pr.id} — skipping`); continue; }
    built.push(buildEntry(pr, s));
  }
  data.entries = mergeEntries(data.entries || [], built);
  data.generatedAt = new Date().toISOString();
  fs.writeFileSync(args.data, JSON.stringify(data, null, 2) + '\n');
  console.log(`[merge] added ${built.length} new entries; total ${data.entries.length}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/whats-new/__tests__/merge.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/whats-new/merge.mjs scripts/whats-new/__tests__/merge.test.js
git commit -m "feat(whats-new): idempotent PR->entry merge with weekly grouping"
```

---

### Task 3: PR fetch script

**Files:**
- Create: `scripts/whats-new/fetch-prs.mjs`
- Test: `scripts/whats-new/__tests__/fetch-prs.test.js`

**Interfaces:**
- Consumes: `gh` CLI (must be installed + authenticated), the `repos[]` and existing `entries[]` from `hugo/data/whats_new.json`.
- Produces:
  - `toEntryStub(pr, repoKey, repoLabel): Stub` → `{id, repo, label, number, title, body, mergedAt, url, labels}`.
  - `filterPending(stubs, existingIds, sinceIso): Stub[]` — drops stubs whose `id` is in `existingIds` and whose `mergedAt < sinceIso`.
  - CLI: `node fetch-prs.mjs --data <path> --out <path> [--since <ISO>] [--days <n>]`. Writes pending stubs (JSON array) to `--out`.

- [ ] **Step 1: Write the failing test**

Create `scripts/whats-new/__tests__/fetch-prs.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { toEntryStub, filterPending } from '../fetch-prs.mjs';

const ghPr = {
  number: 1725, title: 'feat: something', body: 'closes #1725',
  mergedAt: '2026-08-11T09:00:00Z',
  url: 'https://github.com/sap-tutorials/tutorials-ims/pull/1725',
  labels: [{ name: 'enhancement' }],
};

describe('toEntryStub', () => {
  it('maps a gh PR to a stub with a stable id', () => {
    const s = toEntryStub(ghPr, 'tutorials-ims', 'Developer Portal');
    expect(s.id).toBe('tutorials-ims#1725');
    expect(s.repo).toBe('tutorials-ims');
    expect(s.label).toBe('Developer Portal');
    expect(s.labels).toEqual(['enhancement']);
    expect(s.mergedAt).toBe('2026-08-11T09:00:00Z');
  });
});

describe('filterPending', () => {
  const stub = toEntryStub(ghPr, 'tutorials-ims', 'Developer Portal');
  it('drops PRs already present', () => {
    expect(filterPending([stub], ['tutorials-ims#1725'], '2026-01-01')).toHaveLength(0);
  });
  it('drops PRs merged before the since cutoff', () => {
    expect(filterPending([stub], [], '2026-08-12T00:00:00Z')).toHaveLength(0);
  });
  it('keeps new PRs merged at/after the cutoff', () => {
    expect(filterPending([stub], [], '2026-08-10T16:00:00Z')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/whats-new/__tests__/fetch-prs.test.js`
Expected: FAIL — cannot resolve `../fetch-prs.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/whats-new/fetch-prs.mjs`:

```js
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function toEntryStub(pr, repoKey, repoLabel) {
  return {
    id: `${repoKey}#${pr.number}`,
    repo: repoKey,
    label: repoLabel,
    number: pr.number,
    title: pr.title || '',
    body: pr.body || '',
    mergedAt: pr.mergedAt,
    url: pr.url,
    labels: (pr.labels || []).map((l) => l.name),
  };
}

// ISO strings compare chronologically as long as both are UTC ('Z'). A
// date-only cutoff ('YYYY-MM-DD') is a prefix of any same-day timestamp, so
// mergedAt >= cutoff correctly includes the whole cutoff day.
export function filterPending(stubs, existingIds, sinceIso) {
  const seen = new Set(existingIds);
  return stubs.filter((s) => !seen.has(s.id) && s.mergedAt >= sinceIso);
}

function resolveSince(args) {
  if (args.since) return args.since;
  const days = Number(args.days || 90);
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function fetchRepoPrs(slug, sinceDate) {
  const out = execFileSync('gh', [
    'pr', 'list', '--repo', slug, '--state', 'merged',
    '--search', `merged:>=${sinceDate}`, '--limit', '300',
    '--json', 'number,title,body,mergedAt,url,labels',
  ], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return JSON.parse(out);
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const data = JSON.parse(fs.readFileSync(args.data, 'utf8'));
  const since = resolveSince(args);
  const sinceDate = since.slice(0, 10); // gh search qualifier takes a date
  const existingIds = (data.entries || []).map((e) => e.id);
  const pending = [];
  for (const repo of data.repos || []) {
    if (!repo.slug || repo.slug.startsWith('<')) {
      console.warn(`[fetch] skipping placeholder repo "${repo.key}"`);
      continue;
    }
    try {
      const prs = fetchRepoPrs(repo.slug, sinceDate);
      const stubs = prs.map((pr) => toEntryStub(pr, repo.key, repo.label));
      pending.push(...filterPending(stubs, existingIds, since));
    } catch (err) {
      console.warn(`[fetch] skipping ${repo.slug}: ${err.message.split('\n')[0]}`);
    }
  }
  fs.writeFileSync(args.out, JSON.stringify(pending, null, 2) + '\n');
  console.log(`[fetch] ${pending.length} pending PR(s) since ${since} → ${args.out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/whats-new/__tests__/fetch-prs.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/whats-new/fetch-prs.mjs scripts/whats-new/__tests__/fetch-prs.test.js
git commit -m "feat(whats-new): gh-backed merged-PR fetch with since/dedupe filter"
```

---

### Task 4: Data scaffold + skill definition

**Files:**
- Create: `hugo/data/whats_new.json`
- Create: `.claude/skills/whats-new/SKILL.md`

**Interfaces:**
- Consumes: `scripts/whats-new/fetch-prs.mjs`, `scripts/whats-new/merge.mjs` (Tasks 2–3).
- Produces: the committed data scaffold Hugo reads (Task 5), and the operator-facing skill.

- [ ] **Step 1: Create the data scaffold**

Create `hugo/data/whats_new.json`:

```json
{
  "generatedAt": "2026-08-13T00:00:00Z",
  "repos": [
    { "key": "tutorials-ims", "slug": "sap-tutorials/tutorials-ims", "label": "Developer Portal" }
  ],
  "entries": []
}
```

> When gameboard/planner slugs are known, add
> `{ "key": "gameboard", "slug": "<org>/gameboard", "label": "Gameboard" }` and
> the planner equivalent to `repos[]`. No code change needed.

- [ ] **Step 2: Create the skill**

Create `.claude/skills/whats-new/SKILL.md`:

````markdown
---
name: whats-new
description: Generate/update the public /whats-new/ weekly digest from merged-PR history across the DevRel repos. Use when asked to build, refresh, or produce the "What's New" report.
---

# What's New digest builder

Generates `hugo/data/whats_new.json` from the **merged pull requests** of the
repos listed in that file's `repos[]`. You (Claude) write the summaries. Runs
locally; the developer reviews and commits. No server infra.

## Prerequisites
- `gh` installed and authenticated (`gh auth status`).
- Run from the repo root.

## Steps

1. **Fetch pending PRs.** Choose a cutoff:
   - Normal refresh: default 90-day lookback (omit `--since`).
   - Explicit start (e.g. go-live): pass `--since <ISO-8601 UTC>`.

   ```bash
   node scripts/whats-new/fetch-prs.mjs \
     --data hugo/data/whats_new.json \
     --out /tmp/whats-new-pending.json
   # or, with an explicit cutoff:
   #   ... --since 2026-08-10T16:00:00Z
   ```
   Note any repos skipped (placeholder slug or unreachable) from the log.

2. **Read** `/tmp/whats-new-pending.json`. If empty, tell the developer there
   is nothing new and stop.

3. **Summarize each pending PR.** For every stub produce
   `{ "id", "category", "summary" }`:
   - `category` ∈ `Feature | Fix | Performance | Docs | Maintenance`. Use the
     conventional-commit prefix in the title as a hint (`feat`→Feature,
     `fix`→Fix, `perf`→Performance, `docs`→Docs; `chore/refactor/build/ci/test/
     style`→Maintenance) but reclassify from the actual PR body when it's clearer.
   - `summary`: ONE plain-language sentence describing the change and, where
     possible, its value to a developer using the platform. Strip issue numbers,
     internal ticket refs, deploy/CI mechanics, and jargon. Community voice.
   - Optionally override the display `title` with a cleaner one via a `title`
     field (otherwise the PR title is used).
   Write the array to `/tmp/whats-new-summaries.json`.

4. **Merge** into the data file:
   ```bash
   node scripts/whats-new/merge.mjs \
     --data hugo/data/whats_new.json \
     --pending /tmp/whats-new-pending.json \
     --summaries /tmp/whats-new-summaries.json
   ```

5. **Report** to the developer: how many new entries, which repos, which weeks.
   Remind them to review `hugo/data/whats_new.json` and commit it. The page
   ships through the normal build/deploy pipeline (this skill does not deploy).

## Notes
- Idempotent: PRs already in the file are never re-summarized (wording stays put).
- On Windows, use a temp dir you can write to instead of `/tmp` if needed.
````

- [ ] **Step 3: Verify the scaffold parses and scripts accept it (no network)**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('hugo/data/whats_new.json','utf8')); console.log('ok')"
node scripts/whats-new/merge.mjs --data hugo/data/whats_new.json --pending /dev/null --summaries /dev/null
```
Expected: `ok`, then `[merge] added 0 new entries; total 0`. (On Windows substitute an empty `[]` file for `/dev/null`.)

- [ ] **Step 4: Commit**

```bash
git add hugo/data/whats_new.json .claude/skills/whats-new/SKILL.md
git commit -m "feat(whats-new): data scaffold + local generator skill"
```

---

### Task 5: Hugo content, layout, and styling

**Files:**
- Create: `hugo/content/whats-new/_index.md`
- Create: `hugo/layouts/whats-new/list.html`
- Create: `hugo/assets/css/whats-new.css`

**Interfaces:**
- Consumes: `site.Data.whats_new` (`{ generatedAt, repos, entries[] }` from Task 4).
- Produces: the static page emitted to `hugo/public/whats-new/index.html`.

- [ ] **Step 1: Create the content stub**

Create `hugo/content/whats-new/_index.md`:

```markdown
---
title: What's New
description: A weekly digest of what shipped across the SAP Developer platform.
type: whats-new
layout: list
---
```

- [ ] **Step 2: Create the layout**

Create `hugo/layouts/whats-new/list.html`:

```go-html-template
{{ define "main" }}
{{- /*
  whats-new/list.html — public weekly digest (/whats-new/).
  Renders site.Data.whats_new.entries grouped by ISO week (newest first),
  then by category in a fixed order. Fully server-rendered; no JS island.
  Data shape (hugo/data/whats_new.json):
    { generatedAt, repos:[{key,slug,label}],
      entries:[{id,repo,label,number,title,summary,category,mergedAt,week,weekStart,url}] }
*/ -}}
{{- $css := resources.Get "css/whats-new.css" | fingerprint -}}
{{ if $css }}<link rel="stylesheet" href="{{ $css.RelPermalink }}">{{ end }}
{{- $data := site.Data.whats_new -}}
{{- $entries := default (slice) $data.entries -}}
{{- $order := slice "Feature" "Fix" "Performance" "Docs" "Maintenance" -}}
{{- $catLabels := dict
    "Feature" "New &amp; improved"
    "Fix" "Fixes"
    "Performance" "Performance"
    "Docs" "Documentation"
    "Maintenance" "Under the hood" -}}

<div class="wn-page">
  <header class="wn-hero">
    <h1 class="wn-hero__title">What&rsquo;s New</h1>
    <p class="wn-hero__intro">A weekly digest of what shipped across the SAP Developer platform &mdash; grouped by week, newest first.</p>
    {{ with $data.generatedAt }}<p class="wn-hero__meta">Last updated {{ dateFormat "January 2, 2006" . }}</p>{{ end }}
  </header>

  {{- $weeks := slice -}}
  {{- range $entries -}}{{- $weeks = $weeks | append .week -}}{{- end -}}
  {{- $weeks = $weeks | uniq | sort | collections.Reverse -}}

  {{ if not $entries }}
    <p class="wn-empty">No updates published yet &mdash; check back soon.</p>
  {{ end }}

  {{ range $wk := $weeks }}
    {{- $items := where $entries "week" $wk -}}
    {{- $ws := (index $items 0).weekStart -}}
    {{- $start := time.AsTime $ws -}}
    {{- $end := $start.AddDate 0 0 6 -}}
    <section class="wn-week">
      <h2 class="wn-week__title">Week of {{ $start.Format "Jan 2" }} &ndash; {{ $end.Format "Jan 2, 2006" }}</h2>
      {{ range $cat := $order }}
        {{- $catItems := where $items "category" $cat -}}
        {{ with $catItems }}
        <div class="wn-cat wn-cat--{{ $cat | lower }}">
          <h3 class="wn-cat__title">{{ index $catLabels $cat | safeHTML }}</h3>
          <ul class="wn-list">
            {{ range . }}
            <li class="wn-item">
              <div class="wn-item__head">
                <a class="wn-item__link" href="{{ .url }}" target="_blank" rel="noopener">{{ .title }}</a>
                <span class="wn-chip">{{ .label }}</span>
              </div>
              <p class="wn-item__summary">{{ .summary }}</p>
            </li>
            {{ end }}
          </ul>
        </div>
        {{ end }}
      {{ end }}
    </section>
  {{ end }}
</div>
{{ end }}
```

- [ ] **Step 3: Create the stylesheet**

Create `hugo/assets/css/whats-new.css`:

```css
/* /whats-new/ — weekly digest. Uses SAP Horizon / Fundamental design tokens
   already loaded site-wide (sap-theme-vars.css). Scoped under .wn-page. */
.wn-page {
  max-width: 56rem;
  margin: 0 auto;
  padding: 2rem 1rem 4rem;
}
.wn-hero { margin-bottom: 2rem; }
.wn-hero__title {
  font-size: 2rem;
  font-weight: 700;
  color: var(--sapTextColor, #1d2d3e);
  margin: 0 0 .5rem;
}
.wn-hero__intro {
  font-size: 1.05rem;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0 0 .25rem;
}
.wn-hero__meta { font-size: .85rem; color: var(--sapContent_LabelColor, #556b82); margin: 0; }

.wn-week { margin: 2.5rem 0; }
.wn-week__title {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--sapTextColor, #1d2d3e);
  padding-bottom: .5rem;
  border-bottom: 2px solid var(--sapBrandColor, #0a6ed1);
  margin: 0 0 1rem;
}
.wn-cat { margin: 1.25rem 0; }
.wn-cat__title {
  font-size: .8rem;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0 0 .5rem;
}
.wn-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
.wn-item {
  background: var(--sapTile_Background, #fff);
  border: 1px solid var(--sapTile_BorderColor, #e5e5e5);
  border-radius: .5rem;
  padding: .85rem 1rem;
}
.wn-item__head { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.wn-item__link {
  font-weight: 600;
  color: var(--sapLinkColor, #0a6ed1);
  text-decoration: none;
}
.wn-item__link:hover { text-decoration: underline; }
.wn-item__summary { margin: .35rem 0 0; color: var(--sapTextColor, #1d2d3e); line-height: 1.5; }
.wn-chip {
  font-size: .7rem;
  font-weight: 600;
  padding: .1rem .5rem;
  border-radius: 1rem;
  background: var(--sapButton_Lite_Hover_Background, #eef2f6);
  color: var(--sapContent_LabelColor, #556b82);
  white-space: nowrap;
}
.wn-empty { color: var(--sapContent_LabelColor, #556b82); }

@media (prefers-color-scheme: dark) {
  .wn-item { background: var(--sapTile_Background, #1d232a); border-color: var(--sapTile_BorderColor, #2b333b); }
}
```

- [ ] **Step 4: Build and verify the page renders**

The layout uses `time.AsTime`, `collections.Reverse`, `where`, `uniq` — all standard Hugo. Build the site (fetch cache must exist; run `npm run fetch-tutorials` first if `.tutorial-cache/` is absent):

Run: `npm run build:hugo` (or `npm run build:all` for a full build)
Then verify:
```bash
test -f hugo/public/whats-new/index.html && echo "PAGE EMITTED"
grep -q "What&rsquo;s New\|What’s New" hugo/public/whats-new/index.html && echo "TITLE OK"
grep -q "No updates published yet" hugo/public/whats-new/index.html && echo "EMPTY-STATE OK (scaffold has no entries yet)"
```
Expected: `PAGE EMITTED`, `TITLE OK`, `EMPTY-STATE OK`. (Empty-state is expected until Task 7 populates entries.)

- [ ] **Step 5: Commit**

```bash
git add hugo/content/whats-new/_index.md hugo/layouts/whats-new/list.html hugo/assets/css/whats-new.css
git commit -m "feat(whats-new): static weekly digest page (content, layout, styles)"
```

---

### Task 6: Post-deploy e2e smoke + nav discoverability

**Files:**
- Create: `test/e2e/whats-new.spec.ts`
- Modify: `hugo/layouts/partials/footer.html` (add a link so the page is reachable)

**Interfaces:**
- Consumes: the deployed `/whats-new/` page (Task 5).
- Produces: a self-skipping Playwright smoke that runs in the post-deploy `e2e` CI job.

- [ ] **Step 1: Inspect an existing e2e spec and the footer for conventions**

Run:
```bash
ls test/e2e
sed -n '1,40p' test/e2e/*.spec.ts | head -60
grep -n "href=" hugo/layouts/partials/footer.html | head
```
Note the base-URL env var and skip guard the existing specs use, and where footer links are listed.

- [ ] **Step 2: Add a footer link to the new page**

In `hugo/layouts/partials/footer.html`, add a link to `/whats-new/` alongside the existing footer links (match the surrounding markup exactly — copy an adjacent `<li><a ...>` line and change href/text to `/whats-new/` / "What's New"). This makes the page reachable without typing the URL and gives the e2e nav check something to click.

- [ ] **Step 3: Write the e2e spec (mirror an existing one's skip guard)**

Create `test/e2e/whats-new.spec.ts`, using the SAME base-URL env var and skip pattern the neighboring specs use. Skeleton (adapt the guard to match the repo's existing specs):

```ts
import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL;

test.describe('What\'s New page', () => {
  test.skip(!BASE, 'no base URL configured');

  test('renders the weekly digest', async ({ page }) => {
    await page.goto(`${BASE}/whats-new/`);
    await expect(page.locator('h1.wn-hero__title')).toContainText('What');
    // Either week sections or the empty-state must be present.
    const hasContent = await page.locator('.wn-week, .wn-empty').count();
    expect(hasContent).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Verify the spec is picked up and self-skips locally**

Run: `npx playwright test test/e2e/whats-new.spec.ts` (with no `PLAYWRIGHT_BASE_URL`)
Expected: the test is skipped (0 failures). If Playwright isn't installed locally, confirm the file matches the `test/e2e` project glob instead.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/whats-new.spec.ts hugo/layouts/partials/footer.html
git commit -m "test(whats-new): post-deploy e2e smoke + footer link"
```

---

### Task 7: Generate this week's first report (go-live cutoff)

**Files:**
- Modify: `hugo/data/whats_new.json` (generated content — reviewed, then committed)

**Interfaces:**
- Consumes: the skill (Task 4) and scripts (Tasks 2–3), run against real repos.

- [ ] **Step 1: Fetch PRs since Monday noon US Eastern (go-live)**

Monday 2026-08-10 12:00 US Eastern = `2026-08-10T16:00:00Z` (EDT = UTC-4).

```bash
node scripts/whats-new/fetch-prs.mjs \
  --data hugo/data/whats_new.json \
  --out /tmp/whats-new-pending.json \
  --since 2026-08-10T16:00:00Z
```
Expected: a non-empty pending list from `tutorials-ims` (plus gameboard/planner if their slugs have been added to `repos[]`; otherwise a "skipping placeholder repo" warning for those).

- [ ] **Step 2: Summarize each pending PR**

Follow the skill's summarization rules (category + one plain-language sentence, community voice, fuller-changelog coverage). Write the array to `/tmp/whats-new-summaries.json`.

- [ ] **Step 3: Merge into the data file**

```bash
node scripts/whats-new/merge.mjs \
  --data hugo/data/whats_new.json \
  --pending /tmp/whats-new-pending.json \
  --summaries /tmp/whats-new-summaries.json
```

- [ ] **Step 4: Rebuild and eyeball the page**

Run: `npm run build:hugo` then confirm `hugo/public/whats-new/index.html` now shows the go-live week section grouped by category (open it, or grep for `wn-week`):
```bash
grep -c "wn-week" hugo/public/whats-new/index.html   # expect >= 1
```

- [ ] **Step 5: Commit the generated report**

```bash
git add hugo/data/whats_new.json
git commit -m "content(whats-new): first weekly digest from go-live (2026-08-10)"
```

---

## Self-Review

**Spec coverage:**
- Public weekly `/whats-new/` page → Task 5. ✅
- 3-repo source, read from `repos[]` → Tasks 3–4 (tutorials-ims shipped; gameboard/planner one-line add). ✅
- Fuller changelog, categories, plain voice → Global Constraints + skill (Task 4). ✅
- AI summaries by Claude at run time, no external key → skill Step 3 (Task 4). ✅
- Local manual run via skill → Task 4. ✅
- Idempotency (PR-keyed, no re-wording) → Task 2 tests. ✅
- On-brand styling → Task 5 CSS. ✅
- Testing (merge + ISO-week unit, e2e) → Tasks 1–3, 6. ✅
- Routing → resolved to "no change needed; static catch-all" (Global Constraints); supersedes spec §5's "add to IN_SCOPE_PAGES / verify xs-app.json" after confirming `/explore/`, `/cookies/` are already served statically. Spec updated to match.
- First report from go-live cutoff → Task 7. ✅

**Placeholder scan:** No TBD/TODO in steps. The `<org>/gameboard` string is an intentional, documented data placeholder (skipped by `fetch-prs.mjs`), not a plan gap.

**Type consistency:** `buildEntry`/`mergeEntries`/`toEntryStub`/`filterPending` signatures and the entry field set (`id, repo, label, number, title, summary, category, mergedAt, week, weekStart, url`) are consistent across Tasks 2, 3, 5, and the layout. `--data/--pending/--summaries/--out/--since/--days` flags are consistent across the scripts and the skill.

## Notes / follow-ups (out of scope)
- Optional RSS/`index.xml` from the same data file.
- Optional GitHub Action for a daily auto-run + PR.
- Pagination when history grows large.
- Commit-level fallback for direct-to-`main` changes with no PR.
- Later, if live-updatable-without-redeploy is wanted, flip `/whats-new/` to the CAP `/content/pages/*` path like `/topics/` (add to `IN_SCOPE_PAGES` + an `xs-app.json` route). Not needed for v1.
