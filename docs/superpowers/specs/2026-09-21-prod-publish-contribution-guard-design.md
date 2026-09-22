# PROD-namespace `-Contribution` publish guard — design

**Date:** 2026-09-21
**Status:** Design — awaiting review before implementation plan
**Target branch:** DEV (main is protected; no hotfix path)

## Problem

The public tutorial `devtoberfest2026-ai-week1-validation` renders on
`developers.sap.com/tutorials/...` but 404s on "view source in GitHub", because
its source only exists in the **QA/working** repo
`sap-tutorials/developer-advocates-Contribution`, never promoted to the public
`sap-tutorials/developer-advocates` repo.

### Investigation findings (what is and isn't true)

- The live page is served from the **public prod** HANA namespace
  (`x-content-source: db-current`, prod `tutorials-srv`), not the QA channel.
  Confirmed: `/tutorials-qa/` is a separate namespace and URL.
- The serve-time provenance envelope stamps `sourceRepo: sap-tutorials/Tutorials`
  for **every** slug — it is a hardcoded constant
  (`srv/lib/provenance-envelope.js:6`), not a per-record value. It told us nothing.
- The real fingerprint is `sourceCommit: null` on the prod `ContentCurrent` row:
  the slug was published with no `<slug>.commit-sha` sidecar.
- **QA content cannot physically leak into the public namespace.** QA and prod are
  isolated HDI containers (`tutorials-hana-qa` vs `tutorials-hana`,
  `.deploy/mta.yaml`), selected by the compile-time `namespace` closure baked into
  which app module received the request (`srv-qa/server.js:26-27` sets
  `namespace: 'com.sap.developers.ims.qa'`; the public `srv` uses the
  `createContentHandlers` default `com.sap.developers.ims`,
  `srv/lib/content-store.js:278`). A caller cannot cross channels.

### Root cause

The `fetch → build → publish` steps are **decoupled**. `fetch-tutorials` can be
run with `-Contribution` repos included (QA-repo discovery) while `publish-content`
targets the **public prod** srv (prod `CONTENT_API_KEY`). That produces
public-channel HTML sourced from a QA-only repo, with no commit-SHA sidecar
(hence `sourceCommit: null`). Nothing on the server rejects a public-namespace
publish carrying a `-Contribution`-sourced slug, and `carryForwardUnchanged`
(`srv/lib/content-publish-session.js:1261`) re-publishes it verbatim on every
subsequent full rebuild.

## Invariant to enforce

**Content sourced from a `-Contribution` (QA/working) repo must never be
published into the public content namespace.** QA-on-prod (`srv-qa`, the
`...ims.qa` namespace) is a legitimate, expected home for `-Contribution`
content and must NOT be blocked.

The discriminator is the **content namespace the publish handler is bound to**,
known at handler-construction time — not the CF space, and never a client-supplied
field.

## Design

### 1. Thread per-slug `sourceRepo` through the publish payload

Mirrors the existing `sourceCommit` / `sources` sidecar pattern exactly.

- **`db/_content-shape.cds`** — add to `ContentFilesAspect`:
  `sourceRepo : String(255);` (nullable, back-compat — same posture as
  `sourceCommit`).
- **`scripts/fetch-tutorials.ts`** — at discovery, `{slug, repo}` is already known.
  Write a `<slug>.source-repo` sidecar into the cache alongside `<slug>.commit-sha`.
- **`scripts/publish-content.ts`** — `collectSidecars` reads `<slug>.source-repo`
  into a `sourceRepos` payload map; include it in the publish body.
- **`srv/lib/content-publish-session.js`** `appendToSession` — accept
  `sourceRepos = {}`; set `sourceRepo: sourceRepos[slug] || null` on each entry
  (alongside `sourceCommit: sourceCommits[slug] || null`, ~`:196`).

### 2. The guard — public namespace only, skip-not-abort

In `appendToSession`, using the factory-closure `namespace`:

```
const isPublicNamespace = namespace === 'com.sap.developers.ims';
```

When `isPublicNamespace` is true, before building `entries`, partition incoming
slugs:

- A slug is **blocked** iff its `sourceRepos[slug]` is a non-empty string that
  ends with `-Contribution`.
- Blocked slugs are **excluded** from `entries` (not written). Existing
  `ContentCurrent` rows for those slugs are **left untouched** (no eviction) —
  carry-forward keeps serving whatever is already there.
- **Fail-safe:** `sourceRepo == null` / empty → NOT blocked. The guard only
  rejects positively-identified `-Contribution` slugs, so legacy rows and
  no-sidecar payloads pass through unchanged.
- QA namespace (`...ims.qa`) → `isPublicNamespace` false → guard dormant →
  `-Contribution` content flows normally. This satisfies "QA validly runs on prod".

**Visibility (a skip must not be silent):**
- `console.warn` (or the module logger) each blocked slug + its repo.
- Return the blocked-slug list from `appendToSession` so the commit summary /
  `ContentManifest` records it. (Exact surfacing — manifest column vs summary
  string — decided in the plan; reuse existing summary plumbing if present.)

### 3. Workflow tripwire (`.github/workflows/rebuild-content.yml`)

Cheap belt-and-suspenders that closes the CI path that caused this incident
(fetch includes `-Contribution` while publish targets the public prod srv):
before the publish step, fail the run if the resolved fetch channel would include
`-Contribution` repos while `steps.env.outputs.target == 'prod'` on the public
(non-QA) channel. One conditional step.

## Out of scope

- **Evicting the existing `devtoberfest2026-ai-week1-validation` row** from the
  public prod namespace. `skip-leave-existing` means the current contaminated row
  persists. Handled as a separate follow-up: either promote the ai-week* tutorials
  QA→public so the source matches what's live, or manually evict via the
  `unpublish-slugs` path.
- Fixing the `provenance-envelope.js` hardcoded `sourceRepo` constant. Now that a
  real per-slug `sourceRepo` exists on the row, the envelope *could* read it — but
  that is a provenance-accuracy improvement, not part of the guard. Note for a
  follow-up.

## Testing (TDD)

Unit tests (in-memory SQLite, public namespace) in the publish-session suite:

1. **Public namespace blocks `-Contribution`:** payload mixing a
   `sourceRepo: "sap-tutorials/developer-advocates-Contribution"` slug and a
   normal `sap-tutorials/developer-advocates` slug → assert the QA slug is not
   written, the normal slug is, and the blocked slug is reported.
2. **QA namespace allows `-Contribution`:** same payload against a handler
   constructed with `namespace: 'com.sap.developers.ims.qa'` → both written.
3. **Fail-safe null repo:** `sourceRepo` null/absent in public namespace → written
   (guard dormant for unidentified source).
4. **Sidecar round-trip:** `publish-content` collects `<slug>.source-repo` into the
   payload; `appendToSession` persists it on the row.

## Constraints

- **srv-qa cp-list audit (load-bearing):** changes touch `srv/lib/`. Re-walk
  transitive `./` imports from `srv/lib/content-store.js` and confirm every dep is
  in `.deploy/mta.yaml`'s `srv-qa` `cp` list. Missing transitive deps crash QA boot
  at MTA deploy time. Carry this as a global constraint in the implementation plan.
- Additive nullable `ContentFiles.sourceRepo` column → no migration risk.
- PR targets **DEV**.
