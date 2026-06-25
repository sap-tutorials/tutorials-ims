# Advocate ↔ User 1:1 Optional Association — Design

**Status:** Approved · **Date:** 2026-06-25 · **Author:** Thomas Jung
**Related:** PR #387 (Advocates), PR #618 (Tutorials.author + TutorialContributors.user), PR #631 (Source Markdown facet — most recent advocate-adjacent work)

## Problem

The `Advocates` entity duplicates identity information (`firstName`, `lastName`, presence of an email via a curated `AdvocateLinks` row) that mostly already exists in `Users` for SAP-internal advocates who are also tutorial authors. There is no way to:

- Discover what tutorials an advocate has authored or contributed to (the FKs added in PR #618 live on `Users`, not on `Advocates`).
- Surface an advocate's official SAP email on the public roster page (`/developer-advocates/`) without requiring the advocate to curate it in `AdvocateLinks`.
- Show the linked SAP-Developers identity from the admin UI when both records exist.

This spec adds a single optional `Advocates → Users` association that unlocks all three.

## Non-goals

- **Not** consolidating `firstName`/`lastName` onto `Users` (advocate-side stays authoritative — see decision below).
- **Not** auto-creating `Users` rows for advocates that don't have one (rejected option in Q5).
- **Not** a bulk "match all advocates to users by email" admin action (out of scope; manual linking is fine for ~50 rows).
- **Not** changing the public roster card visual treatment (Vue island consumes the new fields if present; the tutorial-count pill is a follow-up PR).
- **Not** the reverse direction ("Authored by Thomas Jung, SAP Developer Advocate" badge on tutorial pages). The schema supports it; FE work is separate.

## Decisions

These five decisions were settled in brainstorming on 2026-06-25:

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Source of truth for advocate name/email when linked? | Advocates fields stay authoritative; Users link is auxiliary. | No migration risk; public roster decoupled from auth/identity churn; unlinking doesn't orphan an advocate. |
| 2 | Should `/api/advocates` expose `Users.email`? | Yes — when linked AND email is non-empty. | The SAP Developer Advocates roster is explicit public-outreach material; email is the standard contact channel. |
| 3 | Enforce 1:1 (a User can be linked to at most one Advocate)? | Yes — `@assert.unique.user` on `Advocates`. | Strict interpretation of "1:1 optional association"; HANA UNIQUE-on-nullable allows any number of unlinked advocates. |
| 4 | Where to surface tutorials authored/contributed by this advocate? | Admin Object Page facets AND `/api/advocates` output. | Same data, both surfaces, no extra cost — the projection-level alias plumbs both. |
| 5 | How to handle 50+ existing unlinked advocates? | No backfill — admins link manually post-deploy via the value-help. | Privacy/correctness wins (operator confirms each match); avoids creating disconnected `Users` rows for advocates who don't yet have a Users record. |

## Architecture

One nullable association + one unique constraint at the data layer. Everything else is composition over the existing data flow:

```
                     ┌─────────────────────┐
                     │   AdminService UI   │
                     │  (FE V4 Object Page)│
                     └─────────────────────┘
                                │
                  value-help    │  Identity FieldGroup
                  search:email  │  + Authored/Contributed
                                │  ReferenceFacets
                                ▼
       ┌──────────────────────────────────────────────────┐
       │   Advocates  ────►  Users  ────►  Tutorials      │
       │   ─ user_ID         ─ email       ─ slug, title  │
       │   (nullable)        ─ authoredTutorials          │
       │                     ─ tutorialContributions      │
       └──────────────────────────────────────────────────┘
                                ▲
                                │  $expand:
                                │  user, user.authoredTutorials,
                                │  user.tutorialContributions
                                │
                     ┌─────────────────────┐
                     │ srv/handlers/       │
                     │ advocate-handlers.js│
                     │ → /api/advocates    │ ← Vue island consumes
                     │   (public, 60s SWR) │   email + tutorial arrays
                     └─────────────────────┘
```

## 1. Schema

**File: `db/advocates.cds`** — one field + one annotation:

```cds
entity Advocates : cuid, managed {
  // ... existing fields unchanged ...

  // Optional 1:1 link to a User record. When set, unlocks:
  //   - Read-through Users.email on /api/advocates output
  //   - Tutorials authored/contributed via Users.authoredTutorials and
  //     Users.tutorialContributions (the FKs PR #618 added)
  // Nullable. Setting to null is a valid operation — the advocate stays
  // on the roster; only the email and tutorials affordances disappear.
  user : Association to ims.Users;

  // ... rest unchanged ...
}

// CAP generates the FK column as `user_ID`. The annotation uses the
// ASSOCIATION NAME, not the generated column name — CAP resolves it to
// `user_ID` at compile time and emits the HANA UNIQUE index on that
// column. Precedent: db/devtoberfest.cds:45 `@assert.unique.userEvent: [user, event]`
// and db/knowledge-graph.cds:77-78 `@assert.unique.tutorialConcept : [tutorial, concept, predicate]`.
// NULLs are distinct in HANA's UNIQUE semantics, so any number of
// unlinked advocates coexist.
@assert.unique.user: [user]
```

No other schema changes. `Users` stays as-is (it already has `authoredTutorials` and `tutorialContributions` from PR #618).

### 1a. PersonalData cascade — privacy-safe FK on User anonymization

This codebase has a **declarative anonymization cascade** in `srv/lib/anonymization-cascade.js`. Any entity annotated `@PersonalData.EntitySemantics` + a `@PersonalData.FieldSemantics: 'DataSubjectID'` element gets its rows processed when a `Users` row is anonymized. The cascade actions are `null-personal`, `delete`, `audit-only`, `identity-replace`.

Because `Advocates.user_ID` is the ONE place in this codebase where we publicly expose `Users.email` (via `/api/advocates`), we proactively NULL the FK on User anonymization rather than relying on the anonymized email being scrubbed to a placeholder. This is **intentionally divergent** from PR #618's choice not to annotate `Tutorials.author` / `TutorialContributors.user` (those FKs survive anonymization because they're internal authorship records, not a public-facing surface).

**Add to `db/audit-logging.cds`:**

```cds
annotate ims.Advocates with @PersonalData: {
  EntitySemantics: 'Other',
  cascade        : 'null-personal'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
```

The cascade module's `cascadeNullPersonal` (srv/lib/anonymization-cascade.js) will then `UPDATE Advocates SET user_ID = NULL WHERE user_ID = <anonymized-user-id>` automatically. No new handler needed — we just light up the existing machinery.

No `@PersonalData.IsPotentiallyPersonal` annotations on Advocates own fields (firstName, lastName etc.) — those are public-roster fields by design, not personal data of the linked user.

## 2. AdminService projection + Object Page wiring

**File: `srv/admin-service.cds`** — add two convenience associations on the `Advocates` projection so Fiori Elements V4 can render LineItem tables (it can't bind directly to a 2-hop association):

```cds
entity Advocates as projection on ims.Advocates {
  *,
  user.authoredTutorials      as authoredTutorials,
  user.tutorialContributions  as contributedTutorials,
} actions {
  action uploadPhoto(photoBase64 : String, mimeType : String) returns Advocates;
  action clearPhoto() returns Advocates;
};
```

**File: `app/admin-annotations.cds`** — value-help + Identity facet + Authored/Contributed facets:

```cds
annotate AdminService.Advocates with {
  user @(
    Common: {
      Text                  : user.email,
      TextArrangement       : #TextOnly,
      ValueList             : {
        CollectionPath  : 'Users',
        SearchSupported : true,
        Parameters : [
          { $Type: 'Common.ValueListParameterInOut',     LocalDataProperty: user_ID, ValueListProperty: 'ID' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                           ValueListProperty: 'email' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                           ValueListProperty: 'firstName' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                           ValueListProperty: 'lastName' },
        ],
      },
      Label : 'Linked User',
    }
  );
};

annotate AdminService.Advocates with @(
  UI: {
    FieldGroup #IdentityLink : {
      Data : [
        { $Type : 'UI.DataField', Value : user_ID,    Label : 'Linked User' },
        { $Type : 'UI.DataField', Value : user.email, Label : 'Email (from linked User)' },
      ],
    },
    Facets : [
      // existing facets stay in order; insert IdentityLink after the
      // existing header-data facet and before Photo:
      { $Type : 'UI.ReferenceFacet', ID: 'IdentityLinkFacet', Label: 'Identity',             Target : '@UI.FieldGroup#IdentityLink' },
      // ... existing Photo/Bio/Topics/Links facets ...
      // Append the two tutorials facets after Links:
      { $Type : 'UI.ReferenceFacet', ID: 'AuthoredFacet',     Label: 'Authored Tutorials',    Target : 'authoredTutorials/@UI.LineItem' },
      { $Type : 'UI.ReferenceFacet', ID: 'ContributedFacet',  Label: 'Contributed Tutorials', Target : 'contributedTutorials/@UI.LineItem' },
    ],
  }
);
```

Read-only Email row stays visible even when no user is linked (renders blank — matches the rest of the OP).

The `Users` projection in `srv/admin-service.cds` already supports `$search` by email (the "CONTAINS" wiring at admin-service.cds:18 — added in PR #618). `SearchSupported: true` is what enables the search box in the value-help dialog.

`TutorialContributors` already has a `@UI.LineItem` annotation (from PR #618). `Tutorials` already has one (the admin tile expansion PRs). No new LineItem annotations needed.

## 3. Public API — `/api/advocates`

**File: `srv/routes/advocates-public.js`** (the actual handler file — `advocate-handlers.js` is the AdminService draft + photo wiring, not the public JSON route).

The existing handler uses **separate `SELECT.from(...)` queries with manual JS joins** — NOT deep `$expand`. We follow that pattern exactly. After fetching `advocates`, we make ONE small extra query to pull `Users` rows for those advocates that have `user_ID` set, plus TWO more for `Tutorials` (by author) and `TutorialContributors` joined to `Tutorials.slug/title`:

```js
const advocates = await db.run(
  SELECT.from(Advocates).where({ isActive: true }),
);
const ids       = advocates.map((a) => a.ID);
const userIds   = [...new Set(advocates.map((a) => a.user_ID).filter(Boolean))];

const [topics, links, users, authoredRows, contribRows] = await Promise.all([
  // existing topics + links queries unchanged
  ids.length ? db.run(SELECT.from(AdvocateTopics).where({ advocate_ID: { in: ids } })) : [],
  ids.length ? db.run(SELECT.from(AdvocateLinks).where({ advocate_ID: { in: ids } })) : [],
  // NEW — only fetch Users for advocates that have a link
  userIds.length
    ? db.run(SELECT.from(Users).columns('ID', 'email').where({ ID: { in: userIds } }))
    : [],
  // NEW — tutorials authored by any of those users
  userIds.length
    ? db.run(SELECT.from(Tutorials)
        .columns('slug', 'title', 'author_ID')
        .where({ author_ID: { in: userIds } }))
    : [],
  // NEW — tutorial contributor rows for any of those users, joined to
  // tutorial slug/title in a second small query to avoid CQN $expand
  // through the contributors→tutorial edge (not all CAP versions accept
  // nested expand in SELECT.columns).
  userIds.length
    ? db.run(SELECT.from(TutorialContributors)
        .columns('user_ID', 'tutorial_ID')
        .where({ user_ID: { in: userIds } }))
    : [],
]);

// Resolve contributed tutorial slug/title in one extra query
const contribTutorialIds = [...new Set(contribRows.map((r) => r.tutorial_ID).filter(Boolean))];
const contribTutorials = contribTutorialIds.length
  ? await db.run(SELECT.from(Tutorials)
      .columns('ID', 'slug', 'title')
      .where({ ID: { in: contribTutorialIds } }))
  : [];

// Build lookups
const userById     = new Map(users.map((u) => [u.ID, u]));
const authoredByUserId = new Map();
for (const t of authoredRows) {
  if (!t.slug || !t.title) continue;
  if (!authoredByUserId.has(t.author_ID)) authoredByUserId.set(t.author_ID, []);
  authoredByUserId.get(t.author_ID).push({ slug: t.slug, title: t.title });
}
const tutorialById = new Map(contribTutorials.map((t) => [t.ID, t]));
const contribByUserId = new Map();
for (const c of contribRows) {
  const t = tutorialById.get(c.tutorial_ID);
  if (!t || !t.slug || !t.title) continue;
  if (!contribByUserId.has(c.user_ID)) contribByUserId.set(c.user_ID, []);
  contribByUserId.get(c.user_ID).push({ slug: t.slug, title: t.title });
}

// Inside the existing `advocates: advocates.map((a) => ({ ... }))` shape:
{
  // ... all existing fields unchanged ...
  ...(a.user_ID && userById.get(a.user_ID)?.email
    ? { email: userById.get(a.user_ID).email } : {}),
  ...(a.user_ID && authoredByUserId.get(a.user_ID)?.length
    ? { authoredTutorials: authoredByUserId.get(a.user_ID).slice().sort((x, y) => x.title.localeCompare(y.title)) }
    : {}),
  ...(a.user_ID && contribByUserId.get(a.user_ID)?.length
    ? { contributedTutorials: contribByUserId.get(a.user_ID).slice().sort((x, y) => x.title.localeCompare(y.title)) }
    : {}),
}
```

The query count goes from 3 to 5-6 (still all under one `Promise.all`), and each new query is keyed by a small set of IDs — same shape as the existing topics/links/tags fetch. No CQN deep-expand.

**Etag input:** include `users`, `authoredRows`, `contribRows`, `contribTutorials` in `maxModified()` so a `Users.email` change or new tutorial authorship busts the cache.

**Response shape — additive only:**

```jsonc
{
  "slug": "thomas-jung",
  "firstName": "Thomas",
  "lastName": "Jung",
  // ... all existing fields unchanged ...
  "email": "thomas.jung@sap.com",                                 // NEW — when linked + email non-empty
  "authoredTutorials":    [{ "slug": "...", "title": "..." }],     // NEW — when linked + non-empty
  "contributedTutorials": [{ "slug": "...", "title": "..." }]      // NEW — when linked + non-empty
}
```

**Omission semantics:** keys are absent (not set to `null` or `[]`) when they would carry no information. The Vue island can use simple `v-if="advocate.email"` / `v-if="advocate.authoredTutorials?.length"` gates.

**Cache:** existing 60s + SWR on the endpoint (per CLAUDE.md) is unchanged. Worst-case response growth is +5-10 KB on the full ~50 KB payload — well within budget.

## 4. Privacy

`Users.email` is annotated `@PersonalData.IsPotentiallyPersonal` in `db/audit-logging.cds`. Promoting it to a public-facing surface is a deliberate decision documented here:

- The SAP Developer Advocates program (`learning.sap.com` / `developers.sap.com/developer-advocates`) is **explicit public-outreach**. The roster exists to give external developers a way to contact these folks.
- Email is exposed **only when an admin has explicitly linked the advocate to a user record**. Operator action, not automatic.
- Email is **never** exposed for unlinked advocates, even if a `Users` row with the same name exists.
- The existing `@cap-js/change-tracking` on Advocates captures every `user_ID` change in the audit log, so privacy reviewers can reconstruct who linked what when.
- On `Users` anonymization, the cascade (Section 1a) NULLs `Advocates.user_ID` BEFORE the User row is anonymized — so the public endpoint immediately stops emitting the (now-anonymized) email. This is stronger than relying on the anonymized email being scrubbed to a placeholder.

**Audit-log gap on the public endpoint (explicit decision):** `/api/advocates` is an **unauthenticated cached JSON feed** (60s + SWR per CLAUDE.md). Emitting a per-read audit-log event would (a) destroy the cache value, (b) generate massive log volume from anonymous scrapers, and (c) not provide actionable forensics because the caller is unauthenticated. We accept that READ events on the public endpoint are NOT individually audited; the audit trail for "who could see this email" is reconstructable from:

1. `@cap-js/change-tracking` events on `Advocates.user_ID` (when the link was set/cleared/changed)
2. Web-server access logs on `tutorials-approuter` (timestamp + IP for each /api/advocates hit, retained per the platform's standard log retention policy)

This is the same audit posture as `Advocates.firstName`/`lastName` already follows on the public endpoint.

## 5. Testing

| Layer | File | Coverage |
|---|---|---|
| **Unit** (in-memory SQLite, Vitest) | `test/unit/advocate-user-link.test.js` | Schema accepts null user; accepts a link; rejects two advocates pointing at one user (`@assert.unique`); accepts many unlinked. Value-help: Users entity supports `$search` by email. `/api/advocates` shaping: email included/omitted, tutorials included/omitted/sorted/contributed-flattened. **Draft round-trip:** create a draft advocate, set `user_ID`, activate, assert success; activate a SECOND draft with the same `user_ID` and assert `ASSERT_UNIQUE` error code. |
| **Unit** (cascade) | `test/unit/anonymization-cascade-advocates.test.js` | Extends the existing cascade test fixture (`srv/lib/anonymization-cascade.test.js` pattern): assert that anonymizing a User triggers `cascadeNullPersonal` on Advocates → `user_ID` set to NULL. Verify the cascade plan from `getCascadePlan()` includes `Advocates` with `action: 'null-personal'` and `dataSubjectField: 'user_ID'`. |
| **Hybrid** (real HANA via `cds bind --exec`) | `test/hybrid/advocate-user-link.test.js` | UNIQUE constraint enforced at the DB level (not just by CAP runtime) — inserts via raw SQL to bypass CAP and expects HANA constraint-violation SQLSTATE. Inserts an advocate with `user_ID`, anonymizes the user via `srv/lib/anonymization.js` flow, asserts `Advocates.user_ID` is NULL and `/api/advocates` no longer emits the email. Requires `ALLOW_HYBRID_WRITES=true`; follows the `test/hybrid/_guard.js` pattern (test slugs prefixed `__TEST__`, cleaned up in `afterAll`). |
| **Smoke** (HTTP against deployed DEV) | `test/smoke/advocates-user-link.smoke.test.js` | `/api/advocates` returns 200 + JSON array. Conditional: IF any advocate row in DEV has `user_ID` set, the response includes `email` for that row. (Passes-today / asserts-tomorrow per `test/smoke/health.test.js` precedent.) Conditional: IF any linked advocate also has authored tutorials, the response includes `authoredTutorials` array. |
| **Vue island** | `hugo-apps/src/advocates/__tests__/App.test.ts` (exact path to be confirmed during implementation) | Renders `mailto:` link when `email` present, omits when absent. Tutorial-count pill when `authoredTutorials.length > 0`, hidden when absent. Existing fixture under `hugo-apps/src/advocates/__tests__/` extended with the new fields. |

~25-30 test cases total across 5 files. The cascade test is the key new piece — it asserts the privacy guarantee at the unit level so a regression is caught before reaching HANA.

## 6. Rollout

1. **PR** merged to `main`.
2. **`npm run build:all` + `mbt build` + `cf deploy`** to DEV (~18-25 min).
3. **HDI db-deployer** task runs as part of the MTA. The HDI deployer rewrites the `Advocates` table definition with the new `user_ID` column and the UNIQUE constraint. Idempotent — re-runs are no-ops once schema matches.
4. **Smoke verify:** `/api/advocates` returns 200, no advocates yet have `email` (none linked).
5. **Manual linking:** Tom (or another admin) opens `/admin-ui/#advocates-display`, drills into an advocate, uses the value-help to find their User row by email, saves the draft.
6. **Verify:** `/developer-advocates/` shows mailto: + tutorial affordance on that advocate's card.

No content-rebuild workflow needed. No production cutover concern (production cutover end-of-July 2026 — empty `user_ID` columns are fine, same migration path).

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| HDI deploy on Advocates conflicts with active admin draft sessions | Low | MTA staging completes schema deploy before `tutorials-srv` restarts. HDI rewrites the table (not `ALTER TABLE` — corrected from earlier draft); admins on stale draft sessions reload after the deploy completes. |
| `@assert.unique.user` triggers on production with existing duplicates | None | DEV has no advocates linked at deploy time; production cutover (July 2026) follows same empty-FK path. |
| `@assert.unique` interacts unexpectedly with the draft layer (e.g. fires on PATCH instead of ACTIVATE) | Medium | Unit test in Section 5 explicitly exercises the draft round-trip: two drafts setting the same `user_ID`, both PATCH succeeds, the second ACTIVATE fails with `ASSERT_UNIQUE`. If the test reveals draft PATCH itself fires the check (blocking legitimate edits), add an explicit `before SAVE` handler as a fallback. |
| Response-size growth on `/api/advocates` | Low | +5-10 KB worst case on ~50 KB total; cache budget unchanged. The new ETag inputs (users, authored, contrib) bust the 60s cache when relevant data changes. |
| Vue island fixture goes stale (missing new fields) | Will fail loudly | Same-PR fixture update in `hugo-apps/src/advocates/__tests__/` (exact filename confirmed during implementation by listing the directory). Existing component tests catch a missing-field render error immediately. |
| Linked user gets anonymized via `/me/` | Rare but real | **Handled declaratively** by the `@PersonalData` cascade annotation in Section 1a. The existing `cascadeNullPersonal` in `srv/lib/anonymization-cascade.js` NULLs `Advocates.user_ID` automatically when a User is anonymized. Unit test in Section 5 asserts the cascade plan includes Advocates and the cascade action fires. |
| Audit-log churn from `user_ID` field changes | Expected | `@cap-js/change-tracking` already covers this entity. The new `@PersonalData` annotation also produces a `PersonalDataAccessed` audit event on link/unlink — which is the right level of audit for this surface. |
| Privacy regression — accidental email exposure for unlinked advocates | Low | Server-side `if (a.user_ID && userById.get(a.user_ID)?.email)` gate; cascade NULLs FK on anonymization; smoke test asserts the negative case. |
| `srv-qa` cp-list drift | Medium | The public handler at `srv/routes/advocates-public.js` is already in the QA `cp` list. No new `srv/lib/` dependency added. If a later iteration adds one, the cp-list lint catches it (`check-srv-qa-imports.ts` precedent). Verify during implementation by running `npm run check:srv-qa` after edits. |

## 8. Out of scope

- Tutorial-count badges visual treatment on the public roster card (data ships; CSS/Vue rendering is a follow-up PR).
- Reverse direction "Authored by ... SAP Developer Advocate" badge on tutorial pages.
- Bulk-link admin action.
- Public roster sorting/filtering by tutorial count.
- Surfacing `Users.avatarUrl` as a fallback when `Advocates.hasPhoto = false`. (Tempting, but the existing photo system has its own management/audit story — separate concern.)
