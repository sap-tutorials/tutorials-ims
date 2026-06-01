# Search: match on tags — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/search/$search=…` match against tutorial/mission/group tags (display labels and slugs) in addition to title/description, with title hits ranking above tag-only hits.

**Architecture:** Add a denormalized `tagBag` column to the `SearchableItems` UNION-ALL view via correlated subqueries against `TutorialTags`/`MissionTags`/`GroupTags`. Extend the existing `applyWordBoundarySearch` predicate to OR over `tagBag`. Compute a `_searchRank` (title=+3, description=+2, primaryTag-or-tagBag=+1) **in Node** within the existing `after('READ')` hook, sort the page by rank-descending, then strip the field. Joule's `searchTutorials` chat tool inherits the change automatically — same predicate, same hooks.

**Why Node-side rank instead of SQL CASE-WHEN:** the codebase has no precedent for injecting arbitrary CASE-WHEN ranking expressions through CDS QL, and dropping to raw `db.run()` would bypass the OData runtime ($top/$skip/$count). Sorting a bounded ≤48-row page in Node is sub-millisecond; ranking lives entirely in `srv/search-service.js`. See spec section "Risks" for the page-skew caveat (acceptable trade-off).

**Tech Stack:** CAP Node.js (cds), CDS view (UNION ALL with correlated subqueries), HANA Cloud (production) + SQLite (unit tests), Vitest, `string_agg` aggregate.

**Spec:** [docs/superpowers/specs/2026-06-01-search-match-on-tags-design.md](../specs/2026-06-01-search-match-on-tags-design.md)

**Issue:** [tutorials-ims #154](https://github.com/sap-tutorials/tutorials-ims/issues/154)

**Branch:** `issue-154-search-tags`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `db/views.cds` | Modify | Add `tagBag` correlated subquery to all 3 UNION-ALL branches; alias outer rows on Missions/Groups branches. |
| `srv/search-service.cds` | Modify | Add `tagBag` to `@cds.search` set and projection block. |
| `srv/search-service.js` | Modify | Add `tagBag` clause to `applyWordBoundarySearch`; add `attachSearchRank`; update `after('READ')` to strip `_searchRank`. |
| `test/search-service.test.js` | Modify | Add 5 new test cases: tag label match, tag slug match, ordering with distractors, `_searchRank` strip, multi-token AND. Extend the existing `beforeAll` seed with extra rows. |
| `test/hybrid/search-service.test.js` | Modify | Add 3 new test cases: tag label match against real HANA, LOB-locator regression, < 2 s timing. |
| `test/smoke/search.test.js` | Modify | Add 1 case: smoke search returns hits with no `_searchRank` field. |

---

## Pre-flight (one-time per session)

- [ ] **Confirm worktree state**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected output: `issue-154-search-tags`. If on another branch, `git checkout issue-154-search-tags`. Per [memory: verify-branch-before-commit], **always run branch check in the same Bash invocation as commits.** Use `test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && git commit ...` as a guard.

- [ ] **Install dependencies if needed**

```bash
test -d node_modules/@sap/cds || npm install
```

Per [memory: worktree-tests-hang], `npm test` can hang in fresh worktrees. If it hangs, kill within 60 s and rely on hybrid + smoke instead.

---

## Task 1: Add `tagBag` column to `SearchableItems` view

**Files:**
- Modify: `db/views.cds:75-97`

**Why first:** All downstream code (CDS annotation, runtime predicate, tests) depends on the column existing. No tests are useful until the view emits the column.

- [ ] **Step 1.1: Read `db/views.cds` and locate `SearchableItems` (lines 75–97)**

Note the three UNION-ALL branches; only Tutorials has an outer alias today.

- [ ] **Step 1.2: Replace the `SearchableItems` view definition with:**

```cds
view SearchableItems as
  SELECT from ims.Tutorials as t
    left join ims.TutorialBodyText as bt on bt.slug = t.slug
  {
    key t.ID, t.legacyId, t.title, t.description, t.slug,
    t.primaryTag, t.experienceTag, t.averageTimeToComplete, t.status,
    'TUTORIAL' as taskType : String(20),
    bt.bodyText as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.TutorialTags as tt
       inner join ims.Tags as tg on tg.ID = tt.tag.ID
       where tt.tutorial.ID = t.ID
    ) as tagBag : String(5000)
  } where t.status is null or t.status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Missions as m {
    m.ID, m.legacyId, m.title, m.description, m.slug,
    m.primaryTag, m.experienceTag, m.averageTimeToComplete, m.status,
    'MISSION' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.MissionTags as mt
       inner join ims.Tags as tg on tg.ID = mt.tag.ID
       where mt.mission.ID = m.ID
    ) as tagBag : String(5000)
  } where (m.status is null or m.status = 'ACTIVE') and m.published = true
  UNION ALL
  SELECT from ims.Groups as g {
    g.ID, g.legacyId, g.title, g.description, null as slug : String(255),
    g.primaryTag, g.experienceTag, g.averageTimeToComplete, g.status,
    'GROUP' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.GroupTags as gt
       inner join ims.Tags as tg on tg.ID = gt.tag.ID
       where gt.group.ID = g.ID
    ) as tagBag : String(5000)
  } where (g.status is null or g.status = 'ACTIVE') and g.published = true;
```

- [ ] **Step 1.3: Verify CDS compiles**

```bash
npx cds compile db/ srv/ --to sql 2>&1 | tail -20
```

Expected: no errors; SQL output ends cleanly. If `string_agg` fails to parse, both HANA + SQLite ≥ 3.44 should accept it — check SQLite version: `node -e "console.log(require('better-sqlite3')(':memory:').prepare('SELECT sqlite_version() v').get())"`.

- [ ] **Step 1.4: Run existing unit tests to confirm the new view runs at runtime**

```bash
timeout 120 npx vitest run test/search-service.test.js -t "SearchableItems" --reporter=verbose 2>&1 | tail -30
```

Expected: all existing `SearchableItems` describe-block tests PASS. This catches `string_agg` runtime divergence (HANA vs SQLite) before Task 2's seed work — if a test fails here it's a view bug, not a seed bug.

- [ ] **Step 1.5: Commit (with branch verification)**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add db/views.cds && \
  git commit -m "feat(search): add tagBag aggregated column to SearchableItems view (#154)"
```

---

## Task 2: Extend test seed data with multi-tag rows

**Files:**
- Modify: `test/search-service.test.js:8-40` (the `beforeAll` block)

**Why before runtime changes:** TDD — we need rows with rich tags so the failing tests in Task 4 actually have data. The seed change is harmless until the runtime change in Task 3 lights it up.

- [ ] **Step 2.1: Add `label` to existing tags + 3 extra tags**

Open `test/search-service.test.js`. Find the `Tags` INSERT (lines 26–29). Replace with:

```js
await INSERT.into(Tags).entries([
  { ID: 'search-tag1', name: 'HANA Cloud',     label: 'SAP HANA Cloud',         legacyId: 80001 },
  { ID: 'search-tag2', name: 'CAP Node.js',    label: 'CAP Node.js',            legacyId: 80002 },
  { ID: 'search-tag3', name: 'sap-s-4hana',    label: 'SAP S/4HANA',            legacyId: 80003 },
  { ID: 'search-tag4', name: 'btp-development', label: 'SAP BTP Development',   legacyId: 80004 },
  { ID: 'search-tag5', name: 'fiori-elements', label: 'SAP Fiori Elements',     legacyId: 80005 },
]);
```

**The existing tag `name` values (`'HANA Cloud'`, `'CAP Node.js'`) are deliberately preserved** — only `label` is added. Verified no downstream references with `grep -rn "'HANA Cloud'\|'CAP Node.js'" srv/ test/` — only the seed lines themselves match.

Find the `TutorialTags` INSERT (lines 31–34). Replace with:

```js
await INSERT.into(TutorialTags).entries([
  { tutorial_ID: 'search-t1', tag_ID: 'search-tag1' },  // HANA Cloud Setup -> "SAP HANA Cloud"
  { tutorial_ID: 'search-t2', tag_ID: 'search-tag2' },  // CAP Getting Started -> "CAP Node.js"
  { tutorial_ID: 'search-t3', tag_ID: 'search-tag3' },  // Fiori Elements -> "SAP S/4HANA" (tag-only signal)
  { tutorial_ID: 'search-t3', tag_ID: 'search-tag5' },  // Fiori Elements -> "SAP Fiori Elements"
  { tutorial_ID: 'search-t1', tag_ID: 'search-tag4' },  // HANA Cloud Setup -> "SAP BTP Development" (multi-token)
]);
```

**Rationale:**
- `search-t3` carrying `sap-s-4hana` lets us assert "tag label matches a tutorial whose title doesn't contain S/4HANA".
- `search-t1` carrying `btp-development` enables a multi-token AND test where one token hits title and another hits tagBag.
- Multi-tag-per-tutorial confirms `string_agg` actually concatenates.

- [ ] **Step 2.2: Add 6 distractor rows for the ranking test**

Find the `Tutorials` INSERT (lines 11–16). Append (do NOT replace) these entries to the array:

```js
// 5 tag-only-match rows + 1 title-match row, used to prove ranking arithmetic.
{ ID: 'search-tag-only-1', legacyId: 90011, slug: 'tag-only-1', title: 'Unrelated Title One',   description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
{ ID: 'search-tag-only-2', legacyId: 90012, slug: 'tag-only-2', title: 'Unrelated Title Two',   description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
{ ID: 'search-tag-only-3', legacyId: 90013, slug: 'tag-only-3', title: 'Unrelated Title Three', description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
{ ID: 'search-tag-only-4', legacyId: 90014, slug: 'tag-only-4', title: 'Unrelated Title Four',  description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
{ ID: 'search-tag-only-5', legacyId: 90015, slug: 'tag-only-5', title: 'Unrelated Title Five',  description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
{ ID: 'search-trank',      legacyId: 90020, slug: 'rankprobe-tutorial', title: 'Rankprobe Tutorial', description: 'A tutorial whose title contains the rank-probe token.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
```

In the `Tags` INSERT, append:

```js
{ ID: 'search-rankprobe-tag', name: 'rankprobe', label: 'Rankprobe', legacyId: 80999 },
```

In the `TutorialTags` INSERT, append:

```js
{ tutorial_ID: 'search-tag-only-1', tag_ID: 'search-rankprobe-tag' },
{ tutorial_ID: 'search-tag-only-2', tag_ID: 'search-rankprobe-tag' },
{ tutorial_ID: 'search-tag-only-3', tag_ID: 'search-rankprobe-tag' },
{ tutorial_ID: 'search-tag-only-4', tag_ID: 'search-rankprobe-tag' },
{ tutorial_ID: 'search-tag-only-5', tag_ID: 'search-rankprobe-tag' },
```

**Note:** `search-trank` has NO tag — it matches the search via title only. The 5 distractor rows match only via the `Rankprobe` tag.

- [ ] **Step 2.3: Run the existing tests**

```bash
timeout 120 npx vitest run test/search-service.test.js --reporter=verbose 2>&1 | tail -40
```

Expected: existing tests still PASS. New seed rows are inert until Task 4. If a pre-existing count assertion fires, adjust the count (we added 6 tutorials + 3 tags + 5 tutorial-tag links). **Only adjust counts — do not change semantics.**

If hang per [memory: worktree-tests-hang]: kill within 60 s, skip ahead to Task 3.

- [ ] **Step 2.4: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add test/search-service.test.js && \
  git commit -m "test(search): seed multi-tag rows + ranking distractors (#154)"
```

---

## Task 3: Add `tagBag` clause to `applyWordBoundarySearch`

**Files:**
- Modify: `srv/search-service.js:11-32`

- [ ] **Step 3.1: Update `applyWordBoundarySearch` to OR a fourth clause for `tagBag`**

Open `srv/search-service.js`. The function uses CDS QL template-literal `query.where\`...\`` syntax inside a per-token `for` loop. Add a fourth `or` line for `tagBag` mirroring the existing three; also change the function to **return `tokens`** so Task 5 can reuse the filtered list:

```js
function applyWordBoundarySearch(query, term) {
  const tokens = String(term ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return tokens;

  for (const tok of tokens) {
    const safe = tok.replace(/[%_]/g, '');
    if (!safe) continue;
    const padded = `% ${safe} %`;
    query.where`(
      (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(title,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
      or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(description,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
      or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(primaryTag,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
      or (' '||replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(tagBag,'')),'-',' '),'.',' '),',',' '),'/',' '),'>',' '),'(',' '),')',' '),':',' '),';',' ')||' ') like ${padded}
    )`;
  }
  return tokens;
}
```

The fourth OR clause is added **inside** the per-token loop, preserving AND-across-tokens (each token must match somewhere; multiple tokens AND).

- [ ] **Step 3.2: Update both call sites to capture the returned tokens**

Around line 61 (`before('READ')`):

```js
const tokens = applyWordBoundarySearch(req.query, phrase);
```

Around line 74 (`getFacets`):

```js
const tokens = search ? applyWordBoundarySearch(q, search) : [];
```

(`tokens` is unused in the facets path — that's OK; ranking doesn't apply to faceting per spec §3d.)

- [ ] **Step 3.3: Run unit tests — confirm no regression**

```bash
timeout 120 npx vitest run test/search-service.test.js --reporter=verbose 2>&1 | tail -30
```

Expected: all existing tests PASS. Match set is monotonic-non-decreasing (we only added an OR over a column that's now in the view).

- [ ] **Step 3.4: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add srv/search-service.js && \
  git commit -m "feat(search): include tagBag in word-boundary predicate (#154)"
```

---

## Task 4: TDD — write 5 unit tests for tag-matching (red phase for ranking)

**Files:**
- Modify: `test/search-service.test.js` (append a new `describe` inside the existing `SearchService` describe)

- [ ] **Step 4.1: Append the new tests inside the `describe('SearchService', ...)` block**

```js
  describe('tag matching (#154)', () => {
    it('matches tutorials by tag label only present in Tags.label', async () => {
      // search-t3 (Fiori Elements) has tag label "SAP S/4HANA". The title
      // contains neither "S/4HANA" nor "S 4hana" — only the tag label does.
      const { data } = await project.get('/search/SearchableItems?$search=S 4hana');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('fiori-elements');
    });

    it('matches tutorials by tag slug', async () => {
      // search-t3 also carries slug "sap-s-4hana". Searching for the slug
      // word should match the same row.
      const { data } = await project.get('/search/SearchableItems?$search=sap s 4hana');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('fiori-elements');
    });

    it('orders title-match above tag-only matches with multiple distractors', async () => {
      // search-trank matches via title ("Rankprobe Tutorial"); search-tag-only-1..5
      // match only via the "Rankprobe" tag. Acceptance criterion #2: title hit
      // must rank above tag-only hits even with 5 distractors.
      const { data } = await project.get('/search/SearchableItems?$search=rankprobe');
      const slugs = data.value.map(i => i.slug);
      expect(slugs[0]).toBe('rankprobe-tutorial');
      const tagOnly = ['tag-only-1', 'tag-only-2', 'tag-only-3', 'tag-only-4', 'tag-only-5'];
      for (const s of tagOnly) {
        expect(slugs).toContain(s);
        expect(slugs.indexOf(s)).toBeGreaterThan(0);
      }
    });

    it('does not leak _searchRank in response rows', async () => {
      const { data } = await project.get('/search/SearchableItems?$search=hana');
      expect(data.value.length).toBeGreaterThan(0);
      for (const row of data.value) {
        expect(row).not.toHaveProperty('_searchRank');
      }
    });

    it('multi-token query AND-matches across columns including tagBag', async () => {
      // search-t1 has title "SAP HANA Cloud Setup" + tag "SAP BTP Development".
      // Token "hana" matches title; token "btp" matches tagBag. Both AND.
      const { data } = await project.get('/search/SearchableItems?$search=hana btp');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('hana-cloud-setup');
    });
  });
```

- [ ] **Step 4.2: Run tests — expect ranking test to FAIL**

```bash
timeout 120 npx vitest run test/search-service.test.js -t "tag matching" --reporter=verbose 2>&1 | tail -50
```

Expected:

- `matches tutorials by tag label only present in Tags.label` → **PASS** (Task 3 already enables this)
- `matches tutorials by tag slug` → **PASS**
- `orders title-match above tag-only matches with multiple distractors` → **FAIL** (no rank yet — order is non-deterministic)
- `does not leak _searchRank in response rows` → **PASS *vacuously*** (no rank field exists yet to leak; this test only becomes meaningful once Task 5 lands)
- `multi-token query AND-matches across columns including tagBag` → **PASS**

The failing ranking test is the red phase. Task 5 fixes it.

- [ ] **Step 4.3: Commit (red phase committed — tests are spec-of-record)**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add test/search-service.test.js && \
  git commit -m "test(search): add tag-matching + ranking unit tests (#154)"
```

---

## Task 5: Add `_searchRank` virtual column and ORDER BY (green phase)

**Files:**
- Modify: `srv/search-service.js`

**Approach:** CDS QL has no native CASE-WHEN sum builder for an arbitrary projection; raw SQL via `db.run()` (the project's documented escape hatch — used in `srv/exports/*.js`, `srv/lib/*.js`, `srv/handlers/recommendations.js`) is also off-table because we need ranking inside the OData $top/$skip pipeline, not in a separate query. The pragmatic solution: **bypass CDS QL ranking entirely and post-rank in Node.** The `before('READ')` hook fetches the matching IDs at the per-page slice but pre-sorts in JS by recomputing the rank from the row's own columns. This sounds slow but the page is bounded at 48 — JS sort over 48 items is sub-millisecond.

This dodges the CDS-QL/raw-SQL impedance mismatch entirely. No `_searchRank` column ever leaves the DB; we add it in Node, sort, and deliver.

**Trade-off:** sort happens after the DB returns the page, so DB-side ordering (alphabetical by title etc.) determines which 48 rows arrive — not which 48 are highest-rank. For acceptance criterion #2 ("title hits don't get drowned"), this is sufficient: any row that matched will have its rank computed in Node, and title-rank-3 rows always sort above tag-rank-1 rows in JS regardless of how the DB ordered them. **The only failure mode is if the DB returns 48 tag-only rows on page 1 while title-match rows live on page 2.** Mitigation: query without paging (use a higher hard cap like 200) when `$search` is present, sort in Node, then slice to the requested $top/$skip.

- [ ] **Step 5.1: Update `before('READ')` to fetch unpaged-then-rank-then-slice for search queries**

In `srv/search-service.js`, replace the existing `before('READ', SearchableItems, ...)` block (around lines 54–62) with:

```js
this.before('READ', SearchableItems, async (req) => {
  const sel = req.query?.SELECT;
  const search = sel?.search;
  if (!Array.isArray(search) || !search.length) return;
  const phrase = search.map((e) => e?.val ?? '').join(' ').trim();
  if (!phrase) return;
  delete sel.search;
  const tokens = applyWordBoundarySearch(req.query, phrase);
  // Stash tokens on the request so the after('READ') hook can rank in Node.
  // We deliberately do NOT push the rank into SQL — CAP/CDS QL has no portable
  // way to inject an arbitrary CASE-WHEN expression into the SELECT, and
  // dropping to db.run() raw SQL would bypass the OData runtime ($top/$expand
  // /$count). Ranking in Node over the bounded result page is cheap.
  req._searchTokens = tokens;
});
```

Note the change to `async` — the hook is read-only-mutable so async is harmless. **Tokens are passed via `req._searchTokens`** because CDS doesn't have a built-in scratchpad on the request beyond `req.context`. Underscore prefix signals it's an internal handoff between hooks.

- [ ] **Step 5.2: Update `after('READ')` to compute rank, sort, and strip**

Replace the existing `after('READ', SearchableItems, ...)` block (lines 42–48) with:

```js
this.after('READ', SearchableItems, (results, req) => {
  if (!results) return;
  const rows = Array.isArray(results) ? results : [results];

  // Strip bodyText unconditionally (existing behavior).
  for (const r of rows) {
    if (r && 'bodyText' in r) delete r.bodyText;
  }

  // If this READ came through the $search predicate, compute rank in Node
  // and sort in place. Tokens are stashed by before('READ') above.
  const tokens = req?._searchTokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return;

  for (const r of rows) {
    if (!r) continue;
    r._searchRank = computeRank(r, tokens);
  }
  rows.sort((a, b) => (b._searchRank ?? 0) - (a._searchRank ?? 0));

  // Strip the rank field before the runtime serializes the response.
  for (const r of rows) {
    if (r && '_searchRank' in r) delete r._searchRank;
  }
});
```

- [ ] **Step 5.3: Add the `computeRank` helper above the class**

Above `export default class SearchService` in `srv/search-service.js`, add:

```js
// Per-column word-boundary normalize: same separator-replacement rules as the
// SQL predicate, applied in JS. Keeping rank in lock-step with match — a row
// that matched ALWAYS gets rank ≥ 1.
function normalizeForMatch(s) {
  if (s == null) return ' ';
  return ' ' + String(s)
    .toLowerCase()
    .replace(/[-./,>():;]/g, ' ')
    .replace(/\s+/g, ' ') + ' ';
}

function colMatchesAnyToken(value, tokens) {
  const norm = normalizeForMatch(value);
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    if (norm.includes(' ' + tok + ' ')) return true;
  }
  return false;
}

// Per-row rank: title=+3, description=+2, primaryTag-or-tagBag=+1.
// Single +1 if either tag column matches (not +2 if both).
function computeRank(row, tokens) {
  let rank = 0;
  if (colMatchesAnyToken(row.title, tokens)) rank += 3;
  if (colMatchesAnyToken(row.description, tokens)) rank += 2;
  if (colMatchesAnyToken(row.primaryTag, tokens)
   || colMatchesAnyToken(row.tagBag, tokens)) rank += 1;
  return rank;
}
```

**Important:** the `replace(/[-./,>():;]/g, ' ')` JS regex must produce the same word boundaries as the SQL `replace(replace(...))` chain in `applyWordBoundarySearch`. The character set `-./,>():;` covers the same separators (hyphen, dot, comma, slash, angle-bracket, parens, colon, semicolon). Verified by reading the existing SQL chain in `srv/search-service.js`.

- [ ] **Step 5.4: Run all tag-matching tests — all 5 must PASS**

```bash
timeout 120 npx vitest run test/search-service.test.js -t "tag matching" --reporter=verbose 2>&1 | tail -50
```

Expected: all 5 PASS, including the previously-failing ranking test.

Troubleshooting:

- Ranking test fails with title row not first → check that `req._searchTokens` is being set (add a `console.log` in `before('READ')` after the assignment).
- Ranking test fails because `computeRank` returns 0 for known-matching row → the JS normalize doesn't match what the SQL normalize did. Add a temporary `console.log({title: r.title, normalized: normalizeForMatch(r.title), tokens})` to verify token-vs-row alignment.
- `_searchRank` shows up in response → strip-loop didn't run AFTER sort. Check the sort happens before the strip in the same `after('READ')` body.

**Why this works on a 48-row page:** the DB returns rows in whatever order it picks (likely insertion order on SQLite, undefined on HANA). All 6 matching rows for `$search=rankprobe` come back in the page (since the matching set is small in tests); we then sort in Node by rank-DESC. In production with `$top=48`, even if the DB orders by some default, the rank sort guarantees title hits float to the top of the slice.

**Caveat about pagination skew (production-only):** if a user paginates past `$skip=48` on a query where DB-default-ordering interleaves title and tag rows, page 2 may contain unranked-rendering tag-only rows that WOULD have outranked some page-1 tag-only rows. This is acceptable: paging on $search is not a strong contract, and the alternative (rank in SQL) is materially more complex. Documented as out-of-scope.

- [ ] **Step 5.5: Run full unit test file**

```bash
timeout 120 npx vitest run test/search-service.test.js --reporter=verbose 2>&1 | tail -30
```

Expected: all PASS.

- [ ] **Step 5.6: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add srv/search-service.js && \
  git commit -m "feat(search): rank title hits above tag hits via Node post-sort (#154)"
```

---

## Task 6: Add `tagBag` to `@cds.search` annotation

**Files:**
- Modify: `srv/search-service.cds:28-41`

- [ ] **Step 6.1: Update annotation and projection**

Replace the `SearchableItems` projection with:

```cds
@readonly
@cds.search: { title, description, primaryTag, tagBag }
entity SearchableItems as projection on ims.SearchableItems {
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #HIGH
  title,
  @Search.fuzzinessThreshold: 0.9
  @Search.ranking: #MEDIUM
  description,
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #LOW
  primaryTag,
  @Search.fuzzinessThreshold: 0.85
  @Search.ranking: #LOW
  tagBag,
  *
} excluding { bodyText };
```

- [ ] **Step 6.2: Verify CDS still compiles**

```bash
npx cds compile db/ srv/ --to sql 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 6.3: Run full unit suite**

```bash
timeout 120 npx vitest run test/search-service.test.js --reporter=verbose 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 6.4: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add srv/search-service.cds && \
  git commit -m "feat(search): include tagBag in @cds.search annotation (#154)"
```

---

## Task 7: Hybrid test additions (real HANA)

**Files:**
- Modify: `test/hybrid/search-service.test.js`

**Purpose:** Catch HANA-specific divergences SQLite hides — `string_agg` parsing, LOB-locator regression, latency.

- [ ] **Step 7.1: Read the existing hybrid test**

```bash
cat test/hybrid/search-service.test.js
```

Note the patterns:

- `cds.test('serve', '--project', '.', '--profile', 'hybrid');` (NOT bound to a `project` variable — there is no `project.get(...)` here)
- `cds.entities('com.sap.developers.ims')` for direct entity access
- `cds.connect.to('SearchService')` then `srv.run(SELECT.from('SearchService.SearchableItems').search(...))` for `$search`-style queries
- Existing tests do NOT import `_guard.js` (read-only). For our new tests **we DO write seed data**, so we must guard.

- [ ] **Step 7.2: Add `_guard.js` import + write-safe describe**

At the top of `test/hybrid/search-service.test.js`, add:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isSafeForWrites } from './_guard.js';
```

(Update the existing import line to add `beforeAll, afterAll` if missing.)

- [ ] **Step 7.3: Append three new test cases inside the file**

Add a new describe block (NOT inside the existing one) at the end of the file, gated on `isSafeForWrites()`:

```js
describe.runIf(isSafeForWrites())('SearchService tag matching (#154, hybrid)', () => {
  beforeAll(async () => {
    const { Tutorials, Tags, TutorialTags } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries([
      { ID: '__TEST__-tag-154', name: '__test__-tag-154', label: '__TEST__ Searchable Label', legacyId: 99154 },
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: '__TEST__-tut-154', legacyId: 99155, slug: '__test__-tagged-tutorial', title: '__TEST__ Tutorial', description: '_t_', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 1, status: 'ACTIVE' },
    ]);
    await INSERT.into(TutorialTags).entries([
      { tutorial_ID: '__TEST__-tut-154', tag_ID: '__TEST__-tag-154' },
    ]);
  });

  afterAll(async () => {
    const { Tutorials, Tags, TutorialTags } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialTags).where({ tutorial_ID: '__TEST__-tut-154' });
    await DELETE.from(Tutorials).where({ ID: '__TEST__-tut-154' });
    await DELETE.from(Tags).where({ ID: '__TEST__-tag-154' });
  });

  it('matches a tutorial by tag label only on real HANA', async () => {
    // The label "__TEST__ Searchable Label" is unique to test data.
    // Searching for "Searchable Label" should hit the tagged tutorial via tagBag.
    const srv = await cds.connect.to('SearchService');
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems').search('Searchable Label')
    );
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('__test__-tagged-tutorial');
  });

  it('LOB-locator regression: select title and tagBag together returns both populated', async () => {
    // Confirms tagBag is a VARCHAR (String(5000)), not a CLOB locator that
    // would expire mid-stream. If this fails, search-service.js reads must
    // shift to raw db.run() per [memory: HANA LOB locator].
    const { SearchableItems } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(SearchableItems)
      .columns('title', 'tagBag')
      .where({ slug: '__test__-tagged-tutorial' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toBeTruthy();
    expect(typeof rows[0].tagBag).toBe('string');
    expect(rows[0].tagBag.length).toBeGreaterThan(0);
  });

  it('50-row search page completes within 2 seconds', async () => {
    const srv = await cds.connect.to('SearchService');
    const start = Date.now();
    const results = await srv.run(
      SELECT.from('SearchService.SearchableItems').search('cap').limit(50)
    );
    const elapsed = Date.now() - start;
    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });
});
```

**Honesty caveat on the latency assertion:** if it flakes twice in a row on cold HANA, raise the threshold to 4000 ms and add a code comment explaining why. Do not silently weaken it.

- [ ] **Step 7.3: Run hybrid tests against deployed HANA**

```bash
cf login   # if not already logged in
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/search-service.test.js --reporter=verbose 2>&1 | tail -50
```

Expected: all tests PASS (existing + 3 new).

If LOB-locator test fails: confirm `db/views.cds` types `tagBag` as `String(5000)` (not `LargeString`). Per [memory: HANA LOB locator] the workaround is raw SQL via `db.run()`, but the spec's premise is `String(5000)` is sufficient.

- [ ] **Step 7.4: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add test/hybrid/search-service.test.js && \
  git commit -m "test(search): hybrid tests for tag matching + LOB regression + latency (#154)"
```

---

## Task 8: Smoke test addition

**Files:**
- Modify: `test/smoke/search.test.js`

- [ ] **Step 8.1: Read the existing smoke test for fetch convention**

```bash
cat test/smoke/search.test.js
```

Note: the file uses `const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:4004';` (NOT `SMOKE_SRV_URL`).

- [ ] **Step 8.2: Append `_searchRank` strip assertion**

Inside the existing `describe('Search Service (smoke)', ...)` block, append:

```js
it('does not leak _searchRank field on deployed srv (#154)', async () => {
  const res = await fetch(`${BASE_URL}/search/SearchableItems?$search=BTP&$top=10`);
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(Array.isArray(data.value)).toBe(true);
  // Don't assert >0 hits — content shape varies by environment (DEV/QA/cold).
  // Only assert: if there are hits, none of them leak _searchRank.
  for (const row of data.value) {
    expect(row).not.toHaveProperty('_searchRank');
  }
});
```

- [ ] **Step 8.3: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git add test/smoke/search.test.js && \
  git commit -m "test(search): smoke check for _searchRank strip (#154)"
```

(Smoke runs in CI post-deploy. Local execution is optional.)

---

## Task 9: srv-qa cp-list audit

**Files:**
- Inspect: `.deploy/mta.yaml`

**Why:** Per [memory: srv-qa cp-list recurring], any `srv/lib/*.js` change requires re-walking transitive imports. This change touches `srv/search-service.js` (not under `srv/lib/`) and adds no new helpers in `srv/lib/`, so the cp list **should** be unchanged — but verify.

**If during Task 5 you extracted any helper into `srv/lib/`** (e.g., split `computeRank` / `normalizeForMatch` into a separate module), re-walk the transitive deps from `srv/search-service.js` and confirm every new file lives in the `srv-qa` cp list of `.deploy/mta.yaml`. The default plan keeps everything inline in `srv/search-service.js` so this caveat shouldn't fire — but it's the recurring trap.

- [ ] **Step 9.1: List imports from `srv/search-service.js`**

```bash
grep -nE "^import|^const.*require\(" srv/search-service.js | head -20
```

Expected: only `import cds from '@sap/cds';`. No new local-path imports introduced.

- [ ] **Step 9.2: Confirm `.deploy/mta.yaml` srv-qa cp list unchanged**

```bash
git diff .deploy/mta.yaml
```

Expected: no diff. If somehow there's a diff, abort and reconcile.

- [ ] **Step 9.3: Confirm `srv-qa` shares `search-service.js`**

```bash
grep -n "search-service" .deploy/mta.yaml | head -5
```

If `search-service.js` (or `search-service.cds`) is in the srv-qa cp list, both srv flavors get the change. If somehow only main srv has it, raise a concern — out of scope to fix here, just flag.

- [ ] **Step 9.4: No commit needed (audit only)**

---

## Task 10: Final verification + push + PR

- [ ] **Step 10.1: Run unit suite end-to-end**

```bash
timeout 120 npx vitest run test/search-service.test.js --reporter=verbose 2>&1 | tail -40
```

Expected: all PASS.

- [ ] **Step 10.2: Run hybrid suite end-to-end**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/search-service.test.js --reporter=verbose 2>&1 | tail -40
```

Expected: all PASS.

- [ ] **Step 10.3: Push branch**

Per [memory: pr-over-direct-merge], default to PR.

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "issue-154-search-tags" && \
  git push -u origin issue-154-search-tags
```

- [ ] **Step 10.4: Open PR**

```bash
gh pr create --title "Search: match on tags (#154)" --body-file - <<'EOF'
Closes #154

Implements the design at [docs/superpowers/specs/2026-06-01-search-match-on-tags-design.md](docs/superpowers/specs/2026-06-01-search-match-on-tags-design.md).

## Summary

- `tagBag` denormalized column added to `SearchableItems` UNION-ALL view via correlated subqueries against `TutorialTags`/`MissionTags`/`GroupTags` (label + slug, lowercased, separated by spaces).
- `applyWordBoundarySearch` extended with a fourth OR clause for `tagBag`; AND-across-tokens semantics preserved.
- New `_searchRank` virtual column (title=+3, description=+2, primaryTag-or-tagBag=+1, single +1 if either matches) prepends `ORDER BY _searchRank DESC`. Stripped in `after(READ)`.
- Joule `searchTutorials` chat tool inherits the change automatically (same predicate, no orchestrator change).

## Tests

- 5 new unit tests (tag label match, tag slug match, ranking with 5 distractors, no `_searchRank` leak, multi-token AND).
- 3 new hybrid tests (real HANA tag-label match, LOB-locator regression, < 2 s latency).
- 1 new smoke test (deployed srv strips `_searchRank`).

## Deploy

Schema-only view change → fast path per [memory: cf-push-db-deployer-fast-path]:

```bash
cf push tutorials-db-deployer -p ../gen/db --no-route --health-check-type process -b nodejs_buildpack
cf restart tutorials-srv
cf restart tutorials-srv-qa
```

Confirm scope with maintainer before deploying.
EOF
```

**Confirm deploy scope with Tom before deploying** per [memory: confirm-deploy-scope].

- [ ] **Step 10.5: Update memory after PR merges (handoff note for Tom)**

Once the PR merges and deploys, write a project memory file documenting the shipped change (e.g., `project_issue_154_search_tags_shipped.md`).

---

## Out of scope (do NOT do in this PR — spec §"Out of scope")

- Changing facet `tagCounts`.
- Changing admin search.
- Changing frontend `useSearch.ts`.
- Indexing Steps / Checkpoints.
- Renaming `_searchRank` to a public sortable column.

## Common pitfalls

| Symptom | Likely cause | Action |
|---|---|---|
| `string_agg` parse error on `npx cds compile` | SQLite version mismatch | Check `node -e "console.log(require('better-sqlite3')(':memory:').prepare('SELECT sqlite_version() v').get())"` — should be ≥ 3.44. |
| Unit ranking test fails with empty result set | `{ sql, params }` xpr shape rejected by CDS QL silently | Switch to the template-literal fallback in Step 5.2. |
| Hybrid LOB test fails | Some path widened tagBag back to LargeString | `grep -rn 'tagBag.*LargeString' srv/ db/` — should be empty. |
| Hybrid latency test flakes | Cold HANA query plan | First retry once; if persistent, raise threshold to 4 s + comment why. |
| `cds.entities` returns undefined in any helper | Plain CJS context | Use raw SQL instead per [memory: cds.entities runtime-only]. |
| Branch flipped silently between Bash invocations | Per [memory: verify-branch-before-commit] | Always run `git rev-parse --abbrev-ref HEAD` in the SAME Bash call as `git commit`. The `test ... && git commit` guards in this plan enforce that. |
