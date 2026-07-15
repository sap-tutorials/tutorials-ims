---
title: "@cache pilot — KnowledgeGraphService.PublishedConcepts (issue #1182)"
description: Declarative @cache annotation on the anonymous PublishedConceptsWithAliases read (⌘K command palette), invalidation tied to the existing KG publish/write signals, hit-rate measured via the #1179 metrics tables, with a documented expand/hold/revert decision.
date: 2026-07-15
issue: 1182
status: approved
---

# `@cache` pilot — `KnowledgeGraphService.PublishedConcepts`

## Context

Issue #1182 asks us to evaluate cds-caching's declarative `@cache` annotations on a
read-heavy, low-churn surface, measure the hit rate, tie invalidation to our real
freshness signals, and record an **expand / hold / revert** decision. This is now
unblocked: the CDS-Database caching store (`store: 'cds'` + metrics) is live on DEV
after the #1182 resolve-guard fix (PR #1208, deployed 2026-07-15).

> Note: the issue references `srv/hcql-enablement.cds` and "9 @hcql services". That
> file does not exist in this repo — HCQL is docs-only. It doesn't matter for caching:
> `@cache` binds at the CAP service-handler level and is protocol-agnostic (OData /
> REST / GraphQL / HCQL / MCP all share the annotation). We annotate the CAP service
> projection directly.

## Pilot surface

**`KnowledgeGraphService.PublishedConceptsWithAliases`** — the read behind the ⌘K
command palette's CONCEPTS group. The palette issues, per keystroke:

```
GET /graph/PublishedConceptsWithAliases?$search=<term>&$top=6&$select=slug,name,description
```

(`srv/knowledge-graph-service.cds:98-105`, consumed by
`hugo-apps/src/cmd-palette/CommandPalette.vue:325`.)

We do **not** annotate the sibling plain projection `PublishedConcepts`
(`knowledge-graph-service.cds:82-86`): its only consumer,
`srv/lib/published-concepts-query.js`, reads via raw `db.run(SELECT.from(...))` at
rebuild time, which bypasses the service handler — so `@cache` there would cache
nothing (dead config). See [Scope boundary](#scope-boundary).

### Why this surface

- **Anonymous & non-user-scoped.** The service is `@requires: 'any'`
  (`knowledge-graph-service.cds:35`); these `@readonly` projections return the same
  rows for every caller. No per-user data.
- **Un-cached today.** Unlike `neighborhood()` (already cached by the hand-wired
  `srv/lib/kg-neighborhood-cache.js`, #1177), the palette OData read hits the DB on
  every request. So measured hits reflect **real avoided work**, not a wrapper over an
  already-cached call. (This is why we pivoted away from `kg_prerequisites` /
  `kg_what_to_learn_next`, which are thin `.slice()`s over the already-cached
  `neighborhood()`.)
- **Low churn.** Rows change only when a concept is published/unpublished or edited —
  admin/pipeline events that already emit an `after`-write signal we can hook.

### Auth-safety (the issue's #1 hard constraint)

cds-caching's default cache key is **`{hash}`-only**: `isUserAware` defaults to `false`
and `isTenantAware` defaults to `isMultitenantMode()` (false — we are single-tenant)
(`node_modules/cds-caching/lib/support/RuntimeConfigurationManager.js:21-30`). The hash
is computed from the full inbound query, so `$search=foo` and `$search=bar` get distinct
keys.

This is **safe here precisely because the data is not user-scoped** — the same cached
row is correct for every caller, so a user-agnostic key is correct, not a leak. We are
NOT enabling `isUserAware`, and we are deliberately NOT annotating any user-scoped
surface (Author `MyTutorials*`, Analytics `QueryHistory`/`SavedQueries`, Developer
`getMy*`/progress, Homepage `personalized()`), which would leak across users under a
`{hash}`-only key.

## The annotation

```cds
@cache: { ttl: 300000, tags: [{ value: 'kg-published-concepts' }] }
@readonly
@cds.search: { name, description, aliasSearchBlob }
entity PublishedConceptsWithAliases as projection on ims.Concepts { ... }
```

- **`ttl: 300000` (5 min)** — matches the existing `kg-neighborhood` TTL and the ≤5-min
  freshness expectation documented for KG surfaces. Bounds staleness even if a bust is
  missed.
- **`tags: [{ value: 'kg-published-concepts' }]`** — lets us bust every entry for this
  surface with a single `deleteByTag('kg-published-concepts')`.
- **We do NOT set `invalidateOnWrite`.** Its plugin auto-hook fires on CRUD of the
  *annotated projection entity*, but published-state changes come through bound actions
  (`publishConcept`/`unpublishConcept`) on the base `Concepts` entity, which the
  auto-hook would not reliably catch. Explicit tag-bust from the existing write hooks is
  correct and reuses proven infrastructure.

## Invalidation — tied to real freshness signals

Add `deleteByTag('kg-published-concepts')` (fail-open, mirroring `bustNeighborhoodCache`)
to the **existing** KG `after`-write handlers in `srv/server.js` that already fire on the
exact events that change published-concept membership:

- `kg.after(['CREATE','UPDATE','DELETE'], 'Concepts', …)` (`srv/server.js:999`)
- `kg.after('publishConcept', …)` and `kg.after('unpublishConcept', …)`
  (`srv/server.js:1009-1015`) — these flip `publishedAt`, which is the projection's
  `where publishedAt is not null` filter.

The bust logic lives in a small, unit-testable helper
`srv/lib/kg-published-concepts-cache.js` exporting `bustPublishedConceptsCache()` —
structurally identical to `bustNeighborhoodCache()` in `kg-neighborhood-cache.js`
(connect to `caching`, `deleteByTag(PUBLISHED_CONCEPTS_TAG)`, warn-and-continue on
failure so a bust failure never breaks a write; TTL is the backstop).

### Why this is tied to the real signal, not a proxy

`rebuild-content.yml` re-fetches and re-renders content but does not itself write
`Concepts`; publish-state changes come through the admin actions above. Hooking the
`Concepts` write + publish/unpublish action handlers busts the cache on the actual
mutation, not on a downstream proxy. This is the same class of signal
`bustNeighborhoodCache` already uses (`graphVersion` bump on rebuild + write hooks).

## Measurement

`metrics.enabled` is already on for the shared `caching` service (#1179), persisting to
`plugin.cds_caching.Metrics` / `KeyMetrics` in HANA. `@cache` uses the same shared
service, so palette reads flow into those tables automatically. Read via SQL:

```sql
SELECT "cache","period","hits","misses","hitRatio","avgHitLatency","avgMissLatency"
  FROM "PLUGIN_CDS_CACHING_METRICS" WHERE "period"='hourly' ORDER BY "timestamp" DESC;
```

**Caveat:** the shared `caching` service (namespace `kg`) also carries the
`kg-neighborhood` entries, so aggregate `Metrics` blend both surfaces. Use the per-key
`KeyMetrics` breakdown (or filter by the `kg-published-concepts` tag) to isolate the
pilot's own hit rate.

## Scope boundary

`@cache` on the projection intercepts **service-layer (OData/HCQL/MCP) reads** — i.e. the
⌘K palette's HTTP GET. It does **not** intercept `srv/lib/published-concepts-query.js`,
which reads via raw `db.run(SELECT.from(PublishedConcepts))` at rebuild time (that path
bypasses the service handler). This is expected and in-scope-limited: the rebuild-time
full-list read is infrequent (once per rebuild) and already off the hot request path, so
it is not a caching target. Documented here so the metrics are not misread as "the
projection isn't being cached."

## Testing

- **Hybrid no-stale-content regression** (`test/hybrid/kg-published-concepts-cache.test.js`):
  1. read `PublishedConceptsWithAliases` via the service (warm the cache),
  2. publish/unpublish a concept through the bound action,
  3. assert the next read reflects the change (bust fired) — plus a plain TTL/tag
     round-trip (set → get hit → `deleteByTag` → miss). Guards the "invalidation wrong =
     stale content" bug class the issue calls out.
- **Unit** (`test/unit/kg-published-concepts-cache.test.js`): `bustPublishedConceptsCache`
  is fail-open (a `deleteByTag` throw is swallowed + warn-logged, never rethrown) and
  targets the correct tag value.

## Files touched

| File | Change |
|---|---|
| `srv/knowledge-graph-service.cds` | `@cache` on `PublishedConceptsWithAliases` only |
| `srv/lib/kg-published-concepts-cache.js` | new — `bustPublishedConceptsCache()` helper + tag constant |
| `srv/server.js` | call `bustPublishedConceptsCache()` in the existing `Concepts` CRUD + `publishConcept`/`unpublishConcept` `after` hooks |
| `test/hybrid/kg-published-concepts-cache.test.js` | new — no-stale-regression + round-trip |
| `test/unit/kg-published-concepts-cache.test.js` | new — fail-open bust helper |
| `docs/developers/reference/cds-caching-store.md` | append a "`@cache` pilot + decision record" section |

## Rollout & decision

**DEV-only first** (matches every recent KG feature). Soak, read the isolated hit rate
from `KeyMetrics`, then record the **expand / hold / revert** verdict in the decision
section of `cds-caching-store.md`. No PROD rollout in this change.

## Non-goals

- No `isUserAware` / user-scoped caching — out of scope and unnecessary for anonymous data.
- No caching of user-scoped surfaces (explicitly excluded for auth-safety).
- No migration of the hand-wired `kg-neighborhood-cache.js` to `@cache` (separate,
  larger change — this pilot is greenfield).
- No PROD rollout in this change.
