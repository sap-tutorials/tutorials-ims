# GraphQL API — Reference

Design: [#996 plan](../../superpowers/plans/2026-07-05-996-graphql-support.md)

## Architecture

- Plugin: `@cap-js/graphql` (registered in `srv/graphql-config.js`).
- Mount mode: `DUAL_MOUNT` (from Task 1 spike).
- Services exposed:
  - `KnowledgeGraphService` — service-level `@graphql` (Task 8 fix commit d73981af). The plugin's `served` hook does not honor entity-level `@protocol` for GraphQL, so every entity of the service is exposed. Admin projections (`ConceptClusters`, `KgCommunities`, `KgCommunityMembers`, changelog views) live in `AdminService`, not `KnowledgeGraphService`, so they are naturally excluded. The four public entities in this surface: `Concepts`, `ConceptEdges`, `TutorialConceptLinks`, `PublishedConcepts`.
  - `SearchService` (`@graphql` on the service, `@requires: 'any'`)
  - `DeveloperService` (`@graphql` on the service, `me`-shaped entities gated by `@restrict` requiring `Tutorial.API`)
  - **`HomepageService` intentionally excluded** — functions/actions only, no entity fields; not projected by @cap-js/graphql v0.14. Rejoin when we add read-entity projections or when the plugin supports actions.

## AppRouter

Routes `/graphql` (`xsuaa`) and `/graphql/public` (`none`, DUAL_MOUNT only) declared **before** the `/graph/` regex in `approuter/xs-app.json`.

## Contract Enforcement

- `test/unit/graphql-schema-shape.test.js` — asserts no draft leaks, no admin KG projections, no actions/functions.
- `test/unit/graphql-breaking-change.test.js` — diffs `graphql/schema.graphql` against `graphql/.last-release.graphql`; fails on breaking changes without `@deprecated`.
- `test/hybrid/graphql-endpoint.test.js` — asserts `Tutorial.API` gating on `DeveloperService.Tutorials`.
- `test/smoke/graphql-smoke.test.js` — post-deploy assertions against the deployed AppRouter.

## Observability

- Existing `@cap-js/telemetry` covers GraphQL resolvers (they dispatch through the same handler pipeline as OData).
- Plugin logs operation names at `info`; not full queries. See `cds.log('graphql')`.
- No custom metrics module in v1.

## Safety Limits

v1 posture: **bare minimum**. No depth limit, no cost limit, no persisted queries, introspection on everywhere. Revisit if abuse observed — adding `graphql-depth-limit` + `graphql-query-complexity` is a config-only change.

## When Adding a New Service to the GraphQL Surface

1. Add `@graphql` (whole service) or `@protocol: ['odata', 'graphql']` (per-entity) to the CDS.
2. Update `test/unit/graphql-schema-shape.test.js` allow-list.
3. Run `npm run build:sdl` and commit `graphql/schema.graphql`.
4. Run `npm test -- test/unit/graphql-breaking-change.test.js` — additive changes will pass.
5. Update `hugo/content/api-docs/graphql/_index.md` with new example queries.

## When Deprecating a Field

1. Add `@deprecated: { reason: '<why>', successor: '<new field>' }` in the CDS.
2. Land the new field in parallel.
3. Ship one release with both.
4. Next release: remove the old field. The breaking-change guard will pass because the CI diff sees `deprecationReason` on the outgoing field.

## Failure Modes

| Symptom | Likely cause |
|---|---|
| `/graphql` returns 404 | AppRouter route not registered, or CAP boot failed to load `@cap-js/graphql` |
| Schema shape test drops a service | Someone removed `@graphql` from a CDS |
| Breaking-change test fails on PR | Rename or removal without `@deprecated` — add one, or accept the breakage and update `.last-release.graphql` in a release commit |
| Hybrid test says `FORBIDDEN` on the "with-scope" case | `Tutorial.API` scope name typo in one of the two `xs-security.json` files |
