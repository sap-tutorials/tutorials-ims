# #862 Reopen — MyOwnedTutorials + Sandbox Exclusion + ownerEmail Scrub

**Date:** 2026-07-01
**Status:** Draft for review
**Tracking issue:** [#862](https://github.com/sap-tutorials/tutorials-ims/issues/862)
**Author:** Thomas Jung (with Claude)

## Summary

Fix the three distinct problems Riley surfaced when reopening #862:

1. **Semantic mismatch.** Sage's "My Tutorials" panel is owner-based, not authorship-based. Legacy IMS returned tutorials where the caller was **Owner** (the post-publish monitoring signal, `TutorialMeta.ownerEmail`), not tutorials where they were the declared **Author** (`Tutorials.author_ID`). PR #872's `MyAuthoredTutorials` gave Sage the wrong endpoint — no repair of `author_ID` can ever return "Get to Know SAP Tutorials" for Riley, because Daniel Wroblewski is that tutorial's declared author.
2. **Sandbox repo scanning.** `sap-tutorials/sandbox` is a Sage-testing repo that is not intended for production discovery, but its content (`rbrainey-sandbox-1`) is in DEV HANA and appears in `.tutorial-cache/discovery-baseline.json`. It must be excluded from discovery and its rows soft-deleted.
3. **`TutorialMeta.ownerEmail` data drift.** DEV has 58 `TutorialMeta` rows with Riley's email in `ownerEmail`; legacy IMS returns 1 for the same user. The bulk of those 58 came in via migration and don't reflect current ownership. Even a correctly-shaped owner-based endpoint returns 58 spurious rows against the current data.

This spec ships all three fixes plus an ADR that codifies the four ownership signals so future contributors don't have to re-derive the semantics.

## Problem

### A. Author FK ≠ Owner monitoring signal

`MyTutorialsView` (`db/views.cds`) unions four ownership sources with a `bestPriority` rank:

| Priority | Source | Meaning |
|---|---|---|
| 1 | `Tutorials.author_ID = Users.ID` | Declared author (from frontmatter `authorProfile`) |
| 2 | `TutorialContributors.user_ID` | Explicit contributor |
| 3 | `TutorialMeta.ownerEmail = Users.email` | Post-publish monitoring signal |
| 4 | Legacy `TutorialMeta.owner` free-text match | Migrated data only |

Legacy IMS "My Tutorials" for Riley returned one row: **"Get to Know SAP Tutorials"** — Owner: Riley, Author: Daniel Wroblewski. That is exactly a priority-3 match. Priority 1 (`MyAuthoredTutorials`, PR #872) filters that row out, correctly, because Riley isn't the FK author.

Sage's `getMyTutorials()` therefore needs a priority-3 endpoint, not priority-1. `MyAuthoredTutorials` isn't broken — it was solving the wrong problem.

### B. `sandbox` / `sandbox-Contribution` repos leak into discovery

`scripts/parsers/github.ts` filters:

```typescript
export const EXCLUDED_REPOS = new Set(['tutorials-ims'])
export const INCLUDED_PRIVATE_REPOS = new Set(['meta-tutorials'])
```

Private repos not in `INCLUDED_PRIVATE_REPOS` are skipped unless they end with `-Contribution`. Under that policy, `sandbox` (private, not allowlisted) should skip; `sandbox-Contribution` (private, ends in `-Contribution`) is picked up as a QA source when `includeContribution=true` or `onlyContribution=true`.

However, `.tutorial-cache/discovery-baseline.json` line 5552 has:

```json
"rbrainey-sandbox-1": {
  "slug": "rbrainey-sandbox-1",
  "repo": "sandbox",
  ...
}
```

The row is in DEV HANA. Two paths could have created it: (a) an earlier `EXCLUDED_REPOS` policy admitted it and it never got cleaned up; or (b) the discovery-baseline fallback (used when GitHub is unavailable at build time) skips the private-repo filter. Either way, the row exists and shows up on `MyAuthoredTutorials` because `author_ID` was set. We need to both stop future scans **and** remove the current rows.

### C. `TutorialMeta.ownerEmail` is polluted from migration

Thomas probed HANA directly:

> Your email is stamped as `TutorialMeta.ownerEmail` on 58 tutorials. Most of those aren't yours — `OWNER` (the free-text field) points at Bill Jiang, Smita Naik, Madeline Schaefer, and a dozen other actual authors.

`ownerEmail` was auto-populated during the legacy IMS migration in ways that don't reflect the current declared owner. Priority 3 is a legitimate signal only where `ownerEmail` was set correctly; where it wasn't, we get 57 spurious rows for Riley on a correctly-shaped `MyOwnedTutorials`.

## Goals

1. `GET /author/MyOwnedTutorials` returns rows where `TutorialMeta.ownerEmail` matches the caller's `Users.email` — the legacy-IMS "My Tutorials" semantics. Response shape identical to `MyTutorials` / `MyAuthoredTutorials`.
2. `sandbox` and `sandbox-Contribution` are excluded from future discovery runs. Existing `Tutorials` rows sourced from those repos are soft-deleted (`status='INACTIVE'`) on DEV.
3. `TutorialMeta.ownerEmail` values in DEV that can't be corroborated against frontmatter or `owner` free-text are nulled out via an offline, dry-runnable, `--commit`-gated script.
4. ADR 0006 codifies the four ownership signals and their consumers so this class of confusion is easier to spot on future PRs.

## Non-Goals

- Scrubbing PROD's `TutorialMeta.ownerEmail`. Deferred until the PROD cutover ([[project_prod_cutover_july_2026]]) or Legacy IMS decommissioning, whichever comes first.
- Populating missing `Users.githubLogin` values. This is a related follow-up (only 5 of 18 DEV users have `githubLogin` set) but the fix here doesn't depend on it — `MyOwnedTutorials` uses `Users.email`, not `githubLogin`.
- Adding a fifth ownership signal (e.g. `Repositories.owner`). Out of scope; if a future need arises, follow the same view-projection pattern.
- Retrofitting a `Repositories.excluded` admin-configurable flag. Overkill for two entries; the `EXCLUDED_REPOS` Set stays code-defined.
- Reworking the resolver (Phase 0 / (a) / (b) already landed correctly in #876; the follow-up scrub is data-only).

## Architecture Overview

Three orthogonal changes plus an ADR:

```
┌────────────────────────────────────────────────────────────────┐
│  A. Endpoint fix — srv/                                        │
│     author-service.cds       → + entity MyOwnedTutorials       │
│                                    (bestPriority = 3)          │
│     author-service.js        → + before('READ') caller scope   │
│                                                                │
│  B. Sandbox exclusion — scripts/                               │
│     parsers/github.ts        → EXCLUDED_REPOS +=               │
│                                    {sandbox, sandbox-Contrib}  │
│     soft-delete-sandbox-     → find Tutorials WHERE repository │
│       tutorials.cjs (NEW)      → repo.name IN (…), set INACTIVE│
│                                                                │
│  C. ownerEmail scrub — scripts/ (data-only, DEV)               │
│     scrub-tutorialmeta-      → for each TutorialMeta row,      │
│       owner-email.cjs (NEW)    corroborate current ownerEmail  │
│                                against frontmatter + owner     │
│                                free-text; null out unmatched   │
│                                                                │
│  D. Docs — docs/decisions/                                     │
│     0006-authorship-vs-ownership-semantics.md (NEW ADR)        │
│     .vitepress/config.ts     → sidebar entry                   │
└────────────────────────────────────────────────────────────────┘
```

`MyTutorialsView` and its Raw / BestPriority layers do not change. `MyTutorials` and `MyAuthoredTutorials` do not change. Advocate object page and admin Tutorial Health continue to work.

## Components

### C1. `srv/author-service.cds` — add `MyOwnedTutorials`

New projection immediately after `MyAuthoredTutorials`:

```cds
// #862 reopen — MyOwnedTutorials is the panel-shaped surface for "tutorials
// I currently monitor / am the declared post-publish owner of." It projects
// MyTutorialsView with a bestPriority = 3 filter (source 3 in db/views.cds:
// TutorialMeta.ownerEmail = Users.email). This is what legacy IMS's
// "My Tutorials" panel meant, and what the Sage VS Code extension needs.
//
// Contrast with MyAuthoredTutorials (bestPriority = 1, strict author_ID FK)
// and MyTutorials (broad four-source UNION). See ADR 0006 for the semantics.
@readonly entity MyOwnedTutorials as
  projection on ims.MyTutorialsView { *, tutorial_ID as ID }
  where bestPriority = 3;
```

Header comment block on the service updated to reference the three-endpoint surface.

### C2. `srv/author-service.js` — register `before('READ')`

Add a caller-scoping handler mirroring the existing `MyTutorials` / `MyAuthoredTutorials` ones:

```javascript
this.before('READ', MyOwnedTutorials, async (req) => {
  const dbUser = await resolveDbUser(req)
  if (!dbUser) return req.reject(401, 'User not resolved')
  req.query.where({ userId: dbUser.uuid })
})
```

Uses the existing `resolveDbUser()` helper. `req.user.id` → `Users.uuid` is the CAP-context-friendly identifier per §4.4 of the earlier spec.

### B1. `scripts/parsers/github.ts` — `EXCLUDED_REPOS` update

```typescript
export const EXCLUDED_REPOS = new Set(['tutorials-ims', 'sandbox', 'sandbox-Contribution'])
```

The GraphQL discovery loop (line ~545) and REST fallback (line ~605) already consult this Set — one edit lands both paths. Existing `EXCLUDED_REPOS.has()` calls run before the `-Contribution` allowlist branch, so `sandbox-Contribution` is caught even in QA-channel builds.

### B2. `scripts/soft-delete-sandbox-tutorials.cjs` (new)

Modeled on `scripts/repair-mixed-case-tutorial-duplicates.cjs`:

- Dry-run by default; `--commit` required to write.
- SELECT `Tutorials.ID, Tutorials.slug, Tutorials.status` WHERE `repository.name IN ('sandbox', 'sandbox-Contribution')`.
- For each result:
  - If `status = 'INACTIVE'` → bucket `already-inactive`, no action.
  - Else → bucket `soft-delete`, UPDATE `status = 'INACTIVE'`.
- Emit CSV to stdout + summary bucket counts.
- Idempotent: re-runs after `--commit` show zero soft-deletes.

Explicitly does NOT hard-delete or touch `TutorialMeta` / `TutorialContributors` / `ContentFiles` for those slugs — soft-delete matches the existing pattern (`srv/admin-service.js:844`, `srv/lib/content-store.js:1499`) and preserves the audit trail.

### C3. `scripts/scrub-tutorialmeta-owner-email.cjs` (new)

Modeled on `scripts/repair-author-id-phase-c.cjs` (v3 shape from #879). Bucket-based classification, dry-run by default, `--commit` gate, CSV output.

**Inputs per row:**
- `TutorialMeta.owner` (free-text)
- `TutorialMeta.ownerEmail` (candidate to scrub)
- Tutorial slug → `hugo/content/tutorials/<slug>.md` frontmatter (via `gray-matter`, matches #879's approach)
  - Extract `authorProfile` → GitHub login → `Users.githubLogin` → `Users.email`
  - Extract `author` (free-text display name) as a second-order corroboration
- `Users.email` map keyed by `firstName + ' ' + lastName` (for owner-free-text → email)

**Classification per row:**

| Bucket | Predicate | Action |
|---|---|---|
| `ok` | Current `ownerEmail` matches `Users.email` for frontmatter-derived author OR for `owner`-free-text-derived user | leave |
| `null-out` | Current `ownerEmail` is non-null AND matches no corroborating signal | UPDATE ... SET ownerEmail = NULL |
| `no-frontmatter` | Tutorial `.md` file missing on disk | leave, log as `suspect` |
| `no-owner-email` | `ownerEmail` already NULL | leave, no-op |
| `no-users-row` | Corroborating login/name resolves to no `Users` row | leave, log — separate concern |

**Corroboration guard (learned from #879):** the classifier must not read its reference data from the same corrupt column it's classifying. `ownerEmail` is the input under review; expected values are derived only from frontmatter + `Users.githubLogin` + `Users.firstName+lastName`.

**Output:**
- `--dry-run` writes `.migration-data/scrub-owner-email-dryrun.csv` with `slug,current_ownerEmail,expected_from_frontmatter,expected_from_owner_freetext,bucket,reason`.
- Summary printed to stdout: bucket counts + rough impact on `MyOwnedTutorials` (compute rowcount before and simulated after for Riley + any other user with more than 5 owned rows).
- `--commit` requires the dry-run CSV to exist and to have been generated within the last hour (mtime check), so `--commit` is always preceded by a review pass.

### D1. `docs/decisions/0006-authorship-vs-ownership-semantics.md` (new ADR)

Follows the template established by PR #881. Content skeleton:

- **Context:** Four ownership signals accumulated organically (author FK, contributor FK, ownerEmail monitoring, legacy free-text). Naming drift ("author" vs "owner" vs "contributor") caused #862 to ship the wrong endpoint (`MyAuthoredTutorials`, priority 1) when Sage needed the priority-3 semantics.
- **Decision:** The four signals mean four different things. Signal-to-endpoint mapping:

  | Signal | Endpoint | Consumer |
  |---|---|---|
  | Priority 1 — author FK | `MyAuthoredTutorials` | Advocate object page, admin Tutorial Health |
  | Priority 3 — `TutorialMeta.ownerEmail` | `MyOwnedTutorials` | Sage VS Code extension "My Tutorials" panel |
  | Union of 1–4 | `MyTutorials` | Legacy compatibility, ad-hoc admin queries |
  | Priority 2 — contributor FK | (no dedicated endpoint yet; filter `MyTutorials?$filter=bestPriority eq 2`) | YAGNI until a concrete use case |

- **Consequences:** New endpoint per signal when a client's semantic needs are stable. Client-side `$filter=bestPriority` is fine for one-off admin views but not for cache-friendly production endpoints. Any future ownership signal (e.g. `Repositories.owner`) becomes priority 5 in `MyTutorialsRaw` and gets its own endpoint if a client asks for it.
- **Alternatives Considered:** Overloading `MyAuthoredTutorials` to mean priority ≤ 3 (rejected — name mismatch); single `MyTutorials` + client `$filter` (rejected — puts filter discipline on every client, loses caching).
- **References:** #862, #872, #876, this spec.

Sidebar entry in `docs/.vitepress/config.ts` under **Developers → Reference → Architecture decisions (ADR)**.

### C4. `test/unit/author-service.test.js` — three new cases

`describe('AuthorService.MyOwnedTutorials filtering (#862 reopen)')`:

1. Returns only rows where the caller's `Users.uuid` matches a `MyTutorialsView` row with `bestPriority = 3`.
2. Does NOT return rows where the caller is only the `author_ID` FK (would appear on `MyAuthoredTutorials`).
3. Response shape identical to `MyTutorials` — same columns and types, `ID` field populated.

Data seeded via existing test-fixture helpers. In-memory SQLite; no hybrid DB required.

## Data Flow — Riley's Case After the Fix

```
Sage panel → GET /author/MyOwnedTutorials
                        │
                        ▼
before('READ'): req.query.where({ userId: <Riley.uuid> })
                        │
                        ▼
MyTutorialsView (bestPriority = 3)
                        │
                        ▼
MyTutorialsRaw source 3: TutorialMeta.ownerEmail = 'riley.rainey@sap.com'
                        │
                        ▼
Pre-scrub  → 58 rows (drift from legacy migration)
Post-scrub → ~1 row  → "Get to Know SAP Tutorials" (Author: Daniel W)
```

For comparison, unchanged endpoints:

- `GET /author/MyAuthoredTutorials` → 1 row (post-#879 repair): `rbrainey-sandbox-1` — which becomes 0 rows after B2's sandbox soft-delete.
- `GET /author/MyTutorials` → broad UNION, includes contributor + legacy free-text signals.

## Error Handling

- **Endpoint handler:** identical error contract to existing `MyTutorials` / `MyAuthoredTutorials` handlers. 401 when the JWT doesn't resolve to a `Users` row; 500 with CAP error envelope on unexpected DB errors. No new failure modes.
- **`soft-delete-sandbox-tutorials.cjs`:** exits non-zero on DB connection failure or if `--commit` runs without a prior successful dry-run (mtime check on the dry-run CSV). No partial-write risk: single UPDATE per row inside a transaction.
- **`scrub-tutorialmeta-owner-email.cjs`:** exits non-zero on frontmatter read errors > 5% of rows (suspicious, aborts and asks the operator to rebuild `hugo/content/tutorials/`). Individual `.md` read failures bucket the row as `no-frontmatter` and leave it alone.

## Testing Strategy

- **Unit** (fast, in-memory SQLite): three new `MyOwnedTutorials` cases in `test/unit/author-service.test.js`. Existing `MyAuthoredTutorials` and `MyTutorials` tests unchanged and continue to guard those endpoints.
- **Hybrid** (real HANA via `cds bind --exec`): no new tests. `MyOwnedTutorials` is a pure CDS projection — hybrid coverage of the underlying view already exists.
- **Manual, post-deploy on DEV:**
  1. `curl -H "Authorization: Bearer <riley-token>" .../author/MyOwnedTutorials` → expect exactly 1 row after scrub, "Get to Know SAP Tutorials," `.ID` populated.
  2. `curl .../author/MyAuthoredTutorials` → expect 0 rows for Riley after sandbox soft-delete.
  3. `curl .../tutorials/rbrainey-sandbox-1` → 404.
  4. Next `rebuild-content.yml` run: verify `sap-tutorials/sandbox` and `sap-tutorials/sandbox-Contribution` don't appear in the discovery log line-by-line.

## Rollout Sequence

1. **PR lands** to `main` via review (feature branch + PR, not direct merge).
2. **MTA deploy to DEV** (~15 min): approuter + srv + srv-qa.
3. **Sandbox soft-delete on DEV:** `npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs --commit`.
4. **`ownerEmail` scrub dry-run on DEV:** `npx cds bind --exec -- node scripts/scrub-tutorialmeta-owner-email.cjs`. Review CSV.
5. **`ownerEmail` scrub commit on DEV** if step 4 looks correct: `... --commit`.
6. **Notify Riley** to retest with the new `GET /author/MyOwnedTutorials` URL.
7. **Await confirmation** before closing.

If Riley's Sage panel matches expected content after step 6, close #862.

## Compatibility

- `GET /author/MyTutorials` — unchanged.
- `GET /author/MyAuthoredTutorials` — unchanged (still bestPriority=1; still what Advocate + admin Tutorial Health need).
- `GET /author/MyOwnedTutorials` — new; documented in the ADR + comment blocks.
- Response shapes identical across all three endpoints (same view columns + `ID` alias).
- No CDS schema changes; no HDI redeploy required (view-only + no new columns on `TutorialMeta`).
- Sage adopts the new endpoint with a one-line URL change; if Sage doesn't update, `MyAuthoredTutorials` returns 0 rows for Riley (correct after sandbox soft-delete) and Sage's panel appears empty — a benign forced fix, not a broken client.

## Where the Reference Code Lives

- Endpoint: [srv/author-service.cds](../../srv/author-service.cds), [srv/author-service.js](../../srv/author-service.js)
- Underlying view (unchanged): [db/views.cds](../../db/views.cds) — `MyTutorialsRaw` sources 1–4 + `MyTutorialsView`
- Sandbox exclusion: [scripts/parsers/github.ts](../../scripts/parsers/github.ts)
- Repair-script model to follow: [scripts/repair-author-id-phase-c.cjs](../../scripts/repair-author-id-phase-c.cjs) (v3 shape from #879)
- Soft-delete pattern to mirror: [scripts/repair-mixed-case-tutorial-duplicates.cjs](../../scripts/repair-mixed-case-tutorial-duplicates.cjs)
- ADR template: [docs/decisions/_template.md](../../decisions/_template.md)

## Follow-ups (Filed as Separate Issues Later)

- Populate `Users.githubLogin` more broadly on DEV (only 5/18 have it set); enables broader Phase-0 resolver hits on future publishes.
- Scrub `TutorialMeta.ownerEmail` on PROD after cutover.
- Consider a "Contributions" tab in Sage using `MyTutorials?$filter=bestPriority eq 2`, if there's a concrete use case.
