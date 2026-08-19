---
title: 0006 — Authorship vs. ownership vs. contribution semantics
date: 2026-07-01
status: Accepted
deciders: (project team)
related:
  - "docs/superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md"
  - "https://github.com/sap-tutorials/tutorials-ims/issues/862"
  - "https://github.com/sap-tutorials/tutorials-ims/pull/872"
  - "https://github.com/sap-tutorials/tutorials-ims/pull/876"
---

# ADR 0006 — Authorship vs. ownership vs. contribution semantics

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-07-01 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

A tutorial has four independent "who's associated with this?" signals accumulated across the platform's history:

| Priority | Source | Meaning |
|---|---|---|
| 1 | `Tutorials.author_ID = Users.ID` | Declared author, derived from frontmatter `authorProfile` at publish time |
| 2 | `TutorialContributors.user_ID` | Explicit contributor (co-author, editor) |
| 3 | `TutorialMeta.ownerEmail = Users.email` | Post-publish monitoring signal — who's responsible for keeping this current |
| 4 | Legacy `TutorialMeta.owner` free-text match | Migrated data from the legacy IMS's free-text owner column |

These four are surfaced via a `MyTutorialsRaw` UNION and a `MyTutorialsView` that computes `bestPriority = min(priority)` per (tutorial, user). The naming drift — "author," "owner," "contributor," "monitor," "watcher" — has caused two bugs in one week: PR #872 shipped `MyAuthoredTutorials` (priority-1 only) to the Sage VS Code extension, whose "My Tutorials" panel actually wants priority-3 semantics. Fixing that in #876/#878/#879 was purely a data-quality effort; it couldn't correct the wrong endpoint choice.

## Decision

**These four signals mean four different things. Each production consumer gets a purpose-built endpoint over `MyTutorialsView` scoped to the signal(s) it needs:**

| Signal | Endpoint | Consumer |
|---|---|---|
| Priority 1 — author FK | `GET /author/MyAuthoredTutorials` | Advocate object page `ownedTutorials` facet, admin Tutorial Health |
| Priority 3 — `TutorialMeta.ownerEmail` | `GET /author/MyOwnedTutorials` | Sage VS Code extension "My Tutorials" panel |
| Union of 1–4 | `GET /author/MyTutorials` | Legacy compat, ad-hoc admin queries |
| Priority 2 — contributor FK | *(no dedicated endpoint yet)* | YAGNI — filter `MyTutorials?$filter=bestPriority eq 2` on demand |

A signal's meaning is expressed in the *endpoint name* and the *comment block* at its projection site — never left to the client to figure out.

## Consequences

- **Positive.** Each Sage / admin / advocate consumer reads one URL and gets exactly the row set it should. No client-side filter discipline. Cache-friendly (fewer distinct query shapes). New readers can grep for the endpoint name and land on both the projection and the intent comment.
- **Positive.** A future fifth signal (e.g. `Repositories.owner`) fits the pattern: add priority 5 in `MyTutorialsRaw`, add a fifth endpoint when a client asks for it. No design decisions to re-litigate.
- **Negative.** Three endpoints instead of one. Every future change to the shape of `MyTutorialsView` has to preserve response-column parity across all three (unit tests guard this).
- **Neutral.** `bestPriority` remains on every response. Clients who need an "any-priority-under-N" filter can still do it via `$filter=bestPriority le N` on the broad endpoint — the endpoints are conveniences, not restrictions.
- **Neutral.** `TutorialMeta.ownerEmail` is only useful if it's clean. Data quality issues in that column (migration drift) surface immediately on `MyOwnedTutorials`; scrub scripts (like `scripts/scrub-tutorialmeta-owner-email.cjs`) become part of the operational discipline.

## 2026-07-02 update — the ownerEmail write path is now author-only

Riley's second reopen ([#862 comment](https://github.com/sap-tutorials/tutorials-ims/issues/862#issuecomment-4867834304)) surfaced that even with the three purpose-built endpoints in place, `MyOwnedTutorials` returned rows Riley did not own. Root cause was upstream of every endpoint: the publish path (both `srv/lib/content-publish-session.js`'s chunked `upsertTutorialMetadata` and the legacy single-shot handler in `srv/lib/content-store.js`) was stamping

    TutorialMeta.owner = TutorialMeta.ownerEmail = primaryContributorEmail

on every publish. `primaryContributorEmail` is the first entry of the tutorial frontmatter's `contributors:` array — often the author of a small typo-fix PR, not the tutorial's owner. Once that email hit `ownerEmail`, source #3 in the `MyTutorialsRaw` UNION lit up and the contributor appeared on `MyOwnedTutorials` for every tutorial they had ever touched.

**New invariant** — `TutorialMeta.ownerEmail` is set by exactly two paths, both of which use an *authoritative* owner signal:

1. **`linkTutorialAuthorship`** (chunked publish, runs after `upsertTutorialMetadata`) — after resolving `authorUserId` via `resolveTutorialAuthor`, writes that user's email to `TutorialMeta.ownerEmail` **only when the current value is NULL**. The signal is Phase 0 (frontmatter `author_profile` → `Users.githubLogin`) or a role-matching contributor — never a bare "first committer" contributor.
2. **Admin UI** — explicit writes via the AdminService projection.

The publish path's `upsertTutorialMetadata` INSERTs `owner: null, ownerEmail: null` on new rows. Existing rows keep whatever they had. Rows that were poisoned pre-2026-07-02 need a separate scrub (see [`scripts/scrub-tutorialmeta-owner-email.cjs`](../../scripts/scrub-tutorialmeta-owner-email.cjs)).

**Regression guard** — three hybrid tests at [`test/hybrid/frontmatter-owner.test.js`](../../test/hybrid/frontmatter-owner.test.js) (Tests 5, 6, 7) enforce the invariant:

- **Test 5** — With frontmatter `author_profile` = Alice AND `contributors[0]` = Bob, ownerEmail resolves to Alice's email, never Bob's.
- **Test 6** — With only a contributor email (no frontmatter, no matching Users row), ownerEmail stays NULL. Absence of an author signal is not filled from a contributor.
- **Test 7** — An existing non-NULL ownerEmail (admin correction or legacy IMS value) is never overwritten.

## 2026-07-02b update — MyOwnedTutorials sources bestPriority IN (3, 4)

The 2026-07-02 update above surfaced a separate problem after live-probing legacy IMS: many `IMS_TUTORIAL_META.OWNER_ID → IMS_TUTORIAL_AUTHOR` rows have `EMAIL = '<userid>+<login>@users.noreply.github.com'` — a GitHub noreply placeholder that doesn't match `Users.email`. Riley's tutorial `tutorial-first-steps` (legacyId `15733`) is the canonical example. Under a bestPriority=3 (email-only) rule for `MyOwnedTutorials`, those users saw an empty panel.

But `IMS_TUTORIAL_AUTHOR` has a second column — `NAME` — which holds the display name Java IMS's admin UI renders ("Riley Rainey"). `MyTutorialsRaw` source-4 already has the join `WHERE m.owner = u.firstName || ' ' || u.lastName`. If the resync script preserves `A.NAME → TutorialMeta.owner` (not just `A.EMAIL → TutorialMeta.ownerEmail`), source-4 catches every user whose display name matches their Users row. **No hand-curated map, no GitHub-login seeding — just preserve the two signals IMS already has.**

Two-line code change:

1. **`MyOwnedTutorials` widens to `bestPriority IN (3, 4)`** — email OR name match ([srv/author-service.cds](../../srv/author-service.cds)).
2. **Resync script preserves both signals** — `A.NAME → owner`, `A.EMAIL → ownerEmail` (previously wrote email into both columns; [scripts/resync-tutorial-meta-from-ims.cjs](../../scripts/resync-tutorial-meta-from-ims.cjs)).

**Regression guards** ([test/unit/author-service.test.js](../../test/unit/author-service.test.js)):
- Alice + Alice A + alice@example.com + tutorial with `owner='Alice A', ownerEmail=alice@example.com` → priority 3 (email wins).
- Alice + Alice A + tutorial with `owner='Alice A', ownerEmail=null` → priority 4 (name-only match still fires) — this is the Riley shape.
- Strict-author (priority 1) is still excluded from `MyOwnedTutorials`.

### #923's watch-list additions — kept but unused for MyOwnedTutorials

While iterating on this fix, PR #923 briefly re-pointed `MyOwnedTutorials` at a personal-watch-list view sourced from `IMS_DASHBOARD_MONITOR_RECORD`. Live-probing IMS confirmed that table is the **"Monitored by me" checkbox filter** in the legacy IMS admin UI (a separate toggle), NOT the default `My Tutorials` panel. The repoint has been reverted; the `TutorialMonitors` entity, `MyMonitoredTutorialsView`, `toggleMonitor` action, and migration script from #923 remain in place for the eye-icon watch feature. See the entity comment at [db/schema.cds](../../db/schema.cds) for that surface's semantics.

**Endpoint map after this fix:**

| Signal | Endpoint | Consumer |
|---|---|---|
| Priority 1 — author FK | `GET /author/MyAuthoredTutorials` | Advocate object page, admin Tutorial Health |
| Priority 3 (ownerEmail = Users.email) OR 4 (owner = firstName + ' ' + lastName) | `GET /author/MyOwnedTutorials` | Sage VS Code extension "My Tutorials" panel |
| Union of 1–4 | `GET /author/MyTutorials` | Legacy compat, ad-hoc admin queries |
| `TutorialMonitors.user = caller` | *(no endpoint yet)* | Eye-icon watch feature (deferred Sage adoption) |

## 2026-08-19 update — MyOwnedTutorials includes priority 1 (author-owner overlap)

A SAGE user report (Peter Persiel, sapId `D062570`) surfaced a defect in the priority split above: his SAGE "My Tutorials" panel was **empty**, while the browser Admin UI correctly showed him as owner of **9** tutorials.

**Root cause.** `bestPriority = MIN(priority)` per (tutorial, user). Peter is the *declared author* of all 9 (frontmatter `authorProfile` → `Tutorials.author_ID = Users.ID`, priority 1) **and** matches `ownerEmail` (priority 3) and `owner` free-text name (priority 4). `MIN(1, 3, 4) = 1`, so every row collapsed to `bestPriority = 1` — which the old `MyOwnedTutorials` filter `bestPriority IN (3, 4)` **excludes**. The Admin UI reads the raw `owner`/`ownerEmail` strings directly (no `bestPriority` filter), which is why the two surfaces disagreed.

This is not Peter-specific: a DEV probe found **229 (tutorial, user) pairs across 13 users** hidden this way. Ironically it penalises the *best-linked* authors — the ones whose `authorProfile` correctly resolved to a `Users` row.

The 2026-07-01 decision treated "author" (pri 1) and "owner" (pri 3/4) as disjoint endpoints, but they overlap in reality, and `MIN()`-collapse lets the stronger author signal mask the included owner signals. A "My Tutorials" panel means **"tutorials I authored OR own."**

**Decision.** `MyOwnedTutorials` now filters `bestPriority IN (1, 3, 4)` — author OR ownerEmail OR owner-name. The **only** signal deliberately excluded is priority 2 (pure contributor: someone who touched a tutorial they neither authored nor own). `MyAuthoredTutorials` (`bestPriority = 1` only) is unchanged and remains the strict-authorship surface for the Advocate object page and admin Tutorial Health.

**One-line change** — [srv/author-service.cds](../../srv/author-service.cds), `MyOwnedTutorials` projection `where bestPriority in (1, 3, 4)`.

**Regression guard** — [test/unit/author-service.test.js](../../test/unit/author-service.test.js): the `MyOwnedTutorials` suite's `tut-A1` fixture (Alice as author **and** ownerEmail — Peter's exact shape) is now asserted to be **present** at `bestPriority = 1`, and the broad-return test expects `bestPriority IN (1, 3, 4)`. The prior "does NOT return strict-author rows" assertion was inverted (it encoded the bug). User-scoping is still guarded: another user's authored tutorial (`tut-B1`) must not leak into Alice's panel.

**Endpoint map after this fix:**

| Signal | Endpoint | Consumer |
|---|---|---|
| Priority 1 — author FK (strict) | `GET /author/MyAuthoredTutorials` | Advocate object page, admin Tutorial Health |
| Priority 1 (author) OR 3 (ownerEmail = Users.email) OR 4 (owner = firstName + ' ' + lastName) | `GET /author/MyOwnedTutorials` | Sage VS Code extension "My Tutorials" panel |
| Union of 1–4 | `GET /author/MyTutorials` | Legacy compat, ad-hoc admin queries |
| `TutorialMonitors.user = caller` | *(no endpoint yet)* | Eye-icon watch feature (deferred Sage adoption) |

## Alternatives Considered

- **Overload `MyAuthoredTutorials` to mean priority ≤ 3 (author OR contributor OR owner).** Rejected — the name would misdescribe the row set, and the Advocate/admin consumers explicitly need priority-1-only. Adding "Authored" behavior to it would drop rows they depend on.
- **Single `MyTutorials` endpoint + `$filter=bestPriority eq N` for every consumer.** Rejected — puts filter discipline on every client, kills response caching (three consumers → three distinct URLs anyway), and Sage's earlier code demonstrated the "consumer forgets to filter" failure mode.
- **Encode the signal on the row as `ownershipSource: 'author' | 'contributor' | 'owner' | 'legacy'` instead of `bestPriority`.** Cleaner naming but equivalent in query power; deferred as a rename that would break every existing client without adding capability.

## References

- Originating spec: [docs/superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md](../superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md)
- Related PRs: [#872](https://github.com/sap-tutorials/tutorials-ims/pull/872), [#876](https://github.com/sap-tutorials/tutorials-ims/pull/876), [#878](https://github.com/sap-tutorials/tutorials-ims/pull/878), [#879](https://github.com/sap-tutorials/tutorials-ims/pull/879)
- Code: [srv/author-service.cds](../../srv/author-service.cds), [db/views.cds](../../db/views.cds) — `MyTutorialsRaw` sources 1–4
- Design decisions aggregate: [docs/developers/reference/design-decisions.md](../developers/reference/design-decisions.md)
