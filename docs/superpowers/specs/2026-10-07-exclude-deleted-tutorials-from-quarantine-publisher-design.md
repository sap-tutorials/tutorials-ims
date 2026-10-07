# Exclude DELETED / INACTIVE tutorials from quarantine and the publisher pipeline

**Date:** 2026-10-07
**Status:** Design — approved in chat, pending spec review
**Related:** #2585 (quarantine persistence), #2586 (per-tutorial quarantine facet), #1960 (reclassify contentless), #2349 (`--unpublish-slugs`)

## Problem

A tutorial can carry IMS lifecycle status `DELETED` on its HANA `Tutorials`
row yet still be (a) surfaced in the Admin-UI "active quarantine" facet and
(b) fetched, rendered, validated, and quarantined by the full-rebuild
publisher. Concrete live PROD case:

- slug `conncet-private-link-to-gcp-service-connect-(kyma)` (note the typo
  `conncet`), legacyId 25212, `status = DELETED`, `stepCount = null`.
- Admin-UI shows it under the active-quarantine facet at
  `/admin-ui/#/tutorials&/tu/Tutorials(ID=f27d6692-a945-5112-9aaf-8b9f8a183b69,...)`.

### Root cause

The quarantine subsystem and the publisher pipeline are **blind to
`Tutorials.status`**. `status = DELETED` lives only on the HANA `Tutorials`
row (set by `scripts/reclassify-contentless-tutorials.cjs` for a slug whose
content never published — here because of the typo). Nothing reads it in:

- **Discovery / fetch** — `scripts/parsers/github.ts` `discoverAllTutorials`
  walks the `sap-tutorials` GitHub org by folder structure only; the source
  `.md` for this slug still exists upstream in `sap-tutorials/Tutorials`, so
  it is discovered every rebuild. `scripts/fetch-tutorials.ts` has no status
  filter.
- **Validator** — `scripts/validate-tutorials.ts` quarantines on frontmatter
  / stepCount / shortcode checks only; no DB access, no status check. The
  rendered `.md` has no `status` field.
- **Quarantine ingest** — `quarantineIngestHandler`
  (`packages/content/content-store.js`) writes exactly the events array it is
  handed; no join to `Tutorials`.
- **Admin facet** — `srv/admin-service.cds` joins
  `QuarantineEventsCurrent.slug = $self.slug` with **no status predicate**, so
  a DELETED row whose slug is in the current snapshot lights up the facet.

The result is a resurrection loop: `reclassify-contentless` sets `DELETED`,
the next full rebuild re-discovers the still-upstream `.md`, validation
rejects it into quarantine, and publish may re-flip it toward `ACTIVE`.

### Latent bug surfaced

`/content/source-hashes` already LEFT JOINs `Tutorials` but its predicate is
`t.status IS NULL OR t.status != 'INACTIVE'` — it excludes `INACTIVE` only,
**not** `DELETED`. Any new work here must handle both statuses explicitly.

## Goals

1. A tutorial with `status IN ('DELETED','INACTIVE')` is never written into
   quarantine and never surfaces in the Admin active-quarantine facet.
2. Such a tutorial is never fetched, rendered, or validated by the publisher
   — processing stops at discovery.
3. The current live PROD quarantine entry is cleared without waiting for the
   next scheduled full rebuild (one-off cleanup).

## Non-goals

- No change to how `status = DELETED` is *produced*
  (`reclassify-contentless-tutorials.cjs`, `migrate-from-hana.js`,
  `--purge-orphans` / `--unpublish-slugs` keep their current behavior).
- No removal of the upstream `.md` as part of this change. (That is the
  separate "durable retire = remove from source + rebuild with
  purge-orphans" path; out of scope here — this change makes the platform
  robust to a lingering upstream source.)
- No change to the quarantine data model (`db/tutorial-quarantine.cds`),
  snapshot semantics, or the `isCurrent` facet definition.

## Design

Three enforcement points (defense in depth) plus a one-off cleanup. All
status comparisons use the set `('DELETED','INACTIVE')`. All slug
comparisons are lowercase-canonical.

### 1. New read endpoint `GET /content/excluded-slugs`

A dedicated sibling to `/content/source-hashes`. It is **not** an extension
of source-hashes: that endpoint emits only the *surviving* slug→hash map and
`--purge-orphans` reads `Object.keys()` assuming every key is a live slug;
adding DELETED/INACTIVE slugs into it would corrupt orphan computation and
could resurrect them. A separate endpoint keeps the two concerns clean.

**Handler** (in `packages/content/content-store.js`, factory-scoped like
`sourceHashesHandler`): one query, four DB/model variants mirroring
`sourceHashesHandler`’s HANA/SQLite split, but a single simple shape since no
version/content join is needed:

```sql
SELECT DISTINCT LOWER(t.slug) AS slug
  FROM com_sap_developers_ims_tutorials AS t
 WHERE t.status IN ('DELETED','INACTIVE')
```

**Response:** `{ "slugs": [ "<lowercased-slug>", ... ] }`. The `{slugs:[...]}`
envelope (not a bare array) leaves room for future fields without breaking
callers.

**Auth:** mirror the `/content/hashes` + `/content/source-hashes` pair —
- PROD (`srv/server.js`): anonymous public-read, registered with no
  middleware.
- QA (`srv-qa/server.js`): `hashesAuth` (bearer `CONTENT_API_KEY_QA` **or**
  XSUAA `Tutorial.Author`).

`Cache-Control: no-cache`, same as the sibling endpoints.

### 2. Publisher: stop processing at discovery (fetch + validate)

**Fetch** (`scripts/fetch-tutorials.ts`): immediately after
`allTutorials = discovery.tutorials` (the point before `_discovery.json` is
written, before the HANA baseline upload, and before the task map), fetch the
excluded set and filter:

```ts
const excluded = await fetchExcludedSlugs({ baseUrl, apiKey }) // Set<string>, lowercased, fail-open
if (excluded.size) {
  const before = allTutorials.length
  allTutorials = allTutorials.filter(t => !excluded.has(t.slug.toLowerCase()))
  log(`[fetch] excluded ${before - allTutorials.length} DELETED/INACTIVE tutorial(s)`)
}
```

Apply the same filter in the `--regenerate` branch (where `allTutorials` is
rebuilt from cached `.md` + `_discovery.json`). The excluded set is also
written to a sidecar `.tutorial-cache/_excluded.json` (array of lowercased
slugs) for the validator to consume.

`fetchExcludedSlugs` is a new helper in `scripts/lib/publish-client.ts`
mirroring `fetchRemoteSourceHashes`: optional `apiKey`, treats 404/503 as
empty (`new Set()`), returns `Set<string>` of lowercased slugs. Fail-open: a
not-yet-deployed endpoint must not break the rebuild.

**Validator** (`scripts/validate-tutorials.ts`): add `loadExcludedSlugs()`
mirroring `loadRepoBySlug()` — a fail-open read of
`.tutorial-cache/_excluded.json` returning a `Set<string>`. In `main()`, skip
any file whose slug is in that set *before* the validation checks and the
quarantine push (around :163 / :207); such files are neither validated nor
quarantined. This is belt-and-suspenders: once fetch drops excluded slugs
their `.md` is never written, but the validator may run against a tree not
produced by this fetch.

### 3. Quarantine ingest: drop DELETED/INACTIVE events (CAP-side chokepoint)

In `quarantineIngestHandler` (`packages/content/content-store.js`), before
the snapshot insert, resolve the excluded slug set from the DB and drop
matching events:

```js
const excludedRows = await db.run(SELECT`slug`.from(Tutorials).where`status in ${['DELETED','INACTIVE']}`)
const excluded = new Set(excludedRows.map(r => (r.slug||'').toLowerCase()))
events = events.filter(e => !excluded.has((e.slug||'').toLowerCase()))
```

This runs where DB access already exists, so even if an excluded slug reaches
ingest (e.g. a publisher that skipped the new filter), it never persists.
Because the Admin facet is slug-only, dropping the event removes the facet
entry. The empty-snapshot auto-clear path is unchanged: if filtering empties
the events array, the handler’s existing empty-snapshot behavior applies.

### 4. One-off cleanup of the live PROD entry

The three changes above take effect on the next full rebuild / ingest. To
clear the current live entry immediately without a full rebuild, re-POST the
current snapshot minus excluded slugs. Mechanism: a small maintenance script
`scripts/clear-deleted-from-quarantine.cjs` run via `cds bind --exec` against
the target space that:

1. Reads the current snapshot’s events (`isCurrent = true`).
2. Resolves excluded slugs (`Tutorials.status IN ('DELETED','INACTIVE')`).
3. If any current event matches, re-POSTs the surviving events as a new
   snapshot via the existing `/content/quarantine-events` ingest route
   (buildMode `full`), so the normal `isCurrent` flip clears the entry.
4. Dry-run by default; `--commit` to apply. Idempotent (no matching events →
   no-op).

Attribution via the existing `initiator` field. This reuses the ingest route
rather than mutating snapshots directly, so snapshot immutability holds.

## Testing

All unit tests run on in-memory SQLite (`npm test`).

- **Endpoint** — new test: seed Tutorials rows with statuses
  `{DELETED, INACTIVE, ACTIVE, null}`; assert `/content/excluded-slugs`
  returns exactly the DELETED+INACTIVE slugs, lowercased, in the `{slugs}`
  envelope. Assert PROD route is anonymous and QA route requires auth.
- **Ingest drop** — extend `srv/__tests__/lib/quarantine-ingest-routes.test.js`:
  seed a DELETED Tutorials row, POST a snapshot whose events include that
  slug, assert the persisted current snapshot omits it and keeps the rest;
  assert an all-excluded events array yields the empty-snapshot behavior.
- **Discovery filter** — unit test the fetch-side filter: given an
  `allTutorials` array and an excluded Set, assert excluded slugs are removed
  and `_excluded.json` is written. Assert `fetchExcludedSlugs` fail-opens on
  404/503.
- **Validator** — test `loadExcludedSlugs()` fail-open (missing file → empty
  Set) and that an excluded slug’s `.md` is neither quarantined nor validated.
- **Cleanup script** — test the core function (dry-run returns the survivor
  set; commit re-POSTs survivors; no-match → no-op) against a seeded
  in-memory snapshot.

## Rollout

1. Land endpoint + ingest filter + discovery/validator filters + cleanup
   script behind no feature flag (fail-open throughout; no behavior change
   when the endpoint is absent).
2. Deploy to DEV; verify `/content/excluded-slugs` returns the DELETED slug;
   run a full rebuild and confirm the slug is neither fetched nor quarantined.
3. Run the one-off cleanup against PROD (`--commit`) to clear the live entry,
   or let the next PROD full rebuild clear it.
4. PR targets DEV per repo convention; `main` is protected.

## Files touched

- `packages/content/content-store.js` — new `excludedSlugsHandler`; ingest
  filter in `quarantineIngestHandler`.
- `srv/server.js`, `srv-qa/server.js` — register `/content/excluded-slugs`
  (anonymous PROD / `hashesAuth` QA).
- `scripts/lib/publish-client.ts` — `fetchExcludedSlugs` helper.
- `scripts/fetch-tutorials.ts` — discovery-time filter + `_excluded.json`
  sidecar write (main + `--regenerate` branches).
- `scripts/validate-tutorials.ts` — `loadExcludedSlugs()` + skip in `main()`.
- `scripts/clear-deleted-from-quarantine.cjs` — new one-off cleanup script.
- Tests as listed above.
