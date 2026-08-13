# "What's New" Page — Design

**Date:** 2026-08-13
**Status:** Approved design; pending implementation plan
**Author:** Thomas Jung (with Claude Code)

## Summary

A new **public**, community-facing `/whats-new/` page on developers.sap.com,
organized **by week**, that summarizes what shipped across the DevRel platform.
Content is generated **locally** by a Claude Code skill that reads the **merged
pull-request history** of three repos, has the AI summarize each PR in plain
language, and writes a structured Hugo data file. Hugo renders the page
statically — **no new server-side runtime infrastructure**.

The page is meant to be nice to look at and easy to consume, so it can be
promoted to the community (e.g. a Friday post).

## Goals

- A single public page grouped by week, newest week first.
- Built from the git/PR history of **three repos**: `tutorials-ims`,
  `gameboard`, `planner`.
- **Fuller changelog** voice: everything meaningful, grouped by type
  (Feature / Fix / Performance / Docs / Maintenance), in plain,
  community-readable language — not raw commit subjects.
- AI (Claude, at skill run-time) writes the summaries — no external API key.
- Runs **locally & manually** from a developer's desktop via a repo skill.
  The developer reviews and commits the result; it ships through the existing
  content/deploy pipeline.
- Looks on-brand (Horizon / SAP Fundamental Styles) and reads well.

## Non-Goals (YAGNI for v1)

- No GitHub Action / scheduled automation — the "daily" cadence is a manual
  local run (explicit product decision).
- No external LLM API, no server component, no new HANA entity.
- No RSS/JSON syndication feed in v1 (easy follow-up; the data file already
  makes it trivial).
- No pagination in v1 (revisit when the page grows past ~1 year).
- No commit-level fallback in v1 — merged PRs are the unit (see Data Sourcing).

## Architecture

```text
3 repos (tutorials-ims, gameboard, planner)
  → gh pr list --state merged   (scripts/whats-new/fetch-prs.mjs)
    → pending PRs not yet in the data file  (temp JSON)
      → Claude summarizes each (category + one-line plain-language summary)
        → scripts/whats-new/merge.mjs  (ISO-week math, dedupe, sort, write)
          → hugo/data/whats_new.json   (single source of truth, committed)
            → hugo/layouts/whats-new/list.html  (static render, grouped by week)
              → /whats-new/  served via existing page pipeline (page-fallback + CAP BLOB)
```

The AI summarization step **is Claude Code at run time** — the skill instructs
the model to read the pending PRs and produce summaries. No API key, no
service.

## Components

### 1. Data file — `hugo/data/whats_new.json`

Single source of truth. Flat list of PR-keyed entries so re-runs are
idempotent (a PR already present is never re-summarized → stable wording).

```jsonc
{
  "generatedAt": "2026-08-13T14:00:00Z",
  "repos": [
    { "key": "tutorials-ims", "slug": "sap-tutorials/tutorials-ims", "label": "Developer Portal" },
    { "key": "gameboard",     "slug": "<org>/gameboard",             "label": "Gameboard" },
    { "key": "planner",       "slug": "<org>/planner",               "label": "Planner" }
  ],
  "entries": [
    {
      "id": "tutorials-ims#1725",
      "repo": "tutorials-ims",
      "label": "Developer Portal",
      "number": 1725,
      "title": "Devtoberfest contest window with countdown",
      "summary": "The Devtoberfest banner now shows the exact contest window in your timezone, with a live countdown.",
      "category": "Feature",
      "mergedAt": "2026-08-05T09:12:00Z",
      "week": "2026-W32",
      "weekStart": "2026-08-03",
      "url": "https://github.com/sap-tutorials/tutorials-ims/pull/1725"
    }
  ]
}
```

Field notes:
- `id` = `"{repoKey}#{number}"` — the dedupe / skip-resummarize key.
- `category` ∈ `Feature | Fix | Performance | Docs | Maintenance`. Derived from
  the conventional-commit prefix (`feat`, `fix`, `perf`, `docs`; everything
  else — `chore/refactor/build/ci/test/style` — → `Maintenance`) as a **hint**,
  but Claude may reclassify from the actual PR content.
- `week` = ISO week id (`YYYY-Www`); `weekStart` = ISO date of that week's
  Monday. `weekStart` drives the human date-range header in Hugo, avoiding
  ISO-week math in templates.
- Entries retained indefinitely in v1 (page renders all weeks). Pagination is a
  documented follow-up.

### 2. Skill — `.claude/skills/whats-new/SKILL.md`

Orchestrates the run when a developer invokes `/whats-new`:

1. Read `hugo/data/whats_new.json` (init an empty scaffold if absent). Collect
   existing entry `id`s.
2. Run `scripts/whats-new/fetch-prs.mjs` (lookback window, default ~90 days) →
   pending PRs (those not already in the file) to a temp file.
3. Read pending PRs. For each: assign a `category` and write a one-line,
   community-friendly `summary` (strip internal jargon, deploy/CI noise phrasing,
   and bare issue refs; keep it about user-visible value where possible).
4. Run `scripts/whats-new/merge.mjs` with the summaries → merges into the data
   file (week math, dedupe by `id`, sort, bump `generatedAt`).
5. Report to the developer: N new items across which repos, and remind them to
   **review and commit** the data file. Deploy/publish is the normal pipeline
   (not the skill's job).

Robustness: if `gh` is unauthenticated or a repo is unreachable, that repo is
skipped **with a visible warning**, and the run continues for the others.

### 3. Deterministic scripts — `scripts/whats-new/`

Keep JSON integrity and date math in tested code (repo convention: Node under
`scripts/`), never in ad-hoc model edits.

- `fetch-prs.mjs`
  - Input: repo list (read from the data file's `repos`), lookback days, path
    to existing data file.
  - Uses `gh pr list --repo <slug> --state merged --limit <n>
    --search "merged:>=<date>" --json number,title,body,mergedAt,url,labels`
    via `child_process`.
  - Filters out PRs whose `id` is already present.
  - Emits pending PRs (raw metadata) as JSON.
- `merge.mjs`
  - Input: existing data file + Claude's summaries (`[{id, category, summary}]`)
    + the pending PR raw metadata (for `title`, `mergedAt`, `url`, `repo`).
  - Computes `week` + `weekStart` (ISO-week algorithm) from `mergedAt`.
  - Merges, dedupes by `id`, sorts entries (by `mergedAt` desc), bumps
    `generatedAt`, writes with stable 2-space indentation + trailing newline.

### 4. Hugo layout & content

- `hugo/content/whats-new/_index.md` — front matter: `title: "What's New"`,
  a `description`, `type: whats-new` (+ `layout: list`).
- `hugo/layouts/whats-new/list.html` — **server-rendered, no JS island**:
  - Group `.Site.Data.whats_new.entries` by `week`; sort week keys descending.
  - Per week: a `<section>` with a header showing the date range
    (`weekStart` … `weekStart+6d`, formatted).
  - Within a week: subsections in fixed order
    (Feature → Fix → Performance → Docs → Maintenance), each an entry list.
  - Each entry: title, summary, a **repo chip** (label), and a link to the PR.
  - A short intro hero explaining the page.

### 5. Routing

- Add `/whats-new/` to `IN_SCOPE_PAGES` in `srv/lib/page-key-map.js`
  (`{ route: '/whats-new/', key: 'page-whats-new', file: 'whats-new/index.html', mimeType: 'text/html' }`)
  so the page flows through the existing page-fallback snapshot + CAP-BLOB serve
  path used by `/topics/`, `/browse/`, verb hubs, etc.
- **Verify** the approuter `xs-app.json` routes `/whats-new/*` (or is covered by
  an existing catch-all). If not, add the route. This is the single integration
  risk and is an explicit implementation step, not an assumption.

### 6. Styling — `hugo/assets/css/whats-new.css`

- Reuse existing page chrome (header/footer partials, container classes).
- Scoped CSS using current Horizon / Fundamental design tokens: week cards,
  category pills, repo chips, readable typography, a light hero.
- Goal: nice enough to promote to the community.

## Data Flow (idempotency contract)

Running the skill twice with no new merges is a no-op beyond `generatedAt`.
A PR present in the data file is **never** re-fetched-for-summary or re-worded.
New PRs land in their correct ISO week; older weeks are untouched.

## Error Handling

- Missing/empty data file → scripts scaffold an empty structure.
- `gh` not installed / not authed → fetch script exits with a clear message;
  skill surfaces it.
- One repo unreachable → skip that repo with a warning, continue.
- Malformed existing data file → fail loudly (do not silently overwrite history).

## Testing

- **Vitest** on `merge.mjs`:
  - ISO-week + `weekStart` computed correctly (incl. year-boundary weeks).
  - Idempotency: same PR set applied twice → no duplicate entries, summaries
    unchanged.
  - New PR merges into the right week without disturbing existing entries.
- **Hugo render check** against a small fixture `whats_new.json`: build and
  assert the page emits the expected week `<section>`s and category groups.
- **e2e**: a minimal `test/e2e/` spec for the public page (repo convention
  nudges an e2e spec for user-facing UI changes; runs post-deploy, self-skips
  without `SMOKE_BASE_URL`).

## Open Items / Inputs Needed

- **Exact org/name slugs for `gameboard` and `planner`** — wired into the data
  file's `repos` list. The skill reads repos from there, so supplying them later
  is a one-line change. Until provided, those two repos are placeholders and the
  skill runs against `tutorials-ims` alone.

## Follow-ups (out of scope for v1)

- Optional RSS / `index.xml` feed generated from the same data file.
- Optional GitHub Action to run the skill daily and open a PR.
- Pagination once history grows large.
- Commit-level fallback for direct-to-`main` changes with no PR.
