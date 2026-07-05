# @cap-js/graphql mount spike

Version: 0.14.0
Date: 2026-07-05

## Result

MOUNT_MODE = DUAL_MOUNT

## Evidence

### Plugin architecture

`@cap-js/graphql` exposes two distinct layers:

1. **`index.js` — `collectServicesAndMountAdapter(srv, options)`**
   This is the CAP protocol adapter entry point. It has a module-level `let services`
   singleton that collects all served services and mounts ONE adapter at one path.
   Called automatically by CAP for each service annotated with `@graphql` protocol.

2. **`lib/GraphQLAdapter.js` — `GraphQLAdapter(options)` pure factory**
   A stateless Express Router factory. No module-level mutable state.
   Accepts `options.services` (plain object map `{ [name]: srvInstance }`) and
   `options.path`, returns an Express Router with graphiql + query handler.

### Key finding

`GraphQLAdapter(options)` can be called directly — bypassing the singleton in
`index.js` — inside a `cds.on('served', ...)` handler where `cds.services` is
fully populated. Calling it twice with two different service subsets produces two
independent Express Routers that can be mounted at two different paths.

### Live probe: `node scripts/spikes/mount-two.js`

The script loads the four target CDS files (`homepage-service.cds`,
`search-service.cds`, `knowledge-graph-service.cds`, `developer-service.cds`)
via `cds.load`, links the CSN, constructs real `cds.ApplicationService` instances
(same pattern as `@cap-js/graphql/lib/compile.js`), then calls `GraphQLAdapter`
twice — once with a public subset (A), once with all four services (B).

```
[spike] Loading CDS service definitions...
[spike] Services loaded: HomepageService, SearchService, KnowledgeGraphService, DeveloperService
[cds] - WARNING: custom function 'events()' conflicts with method in base class.

      Cannot add typed method for custom function 'events' to service impl of 'HomepageService',
      as this would shadow equally named method in service base class 'ApplicationService'.
      Consider choosing a different name for your custom function.
      Learn more at https://cap.cloud.sap/docs/guides/providing-services#actions-and-functions.
    
[spike] Subset A (public): HomepageService, SearchService, KnowledgeGraphService
[spike] Subset B (all):    HomepageService, SearchService, KnowledgeGraphService, DeveloperService
[graphql] - Service "HomepageService" has no fields and has therefore been excluded from the schema.
[graphql] - Service "HomepageService" has no fields and has therefore been excluded from the schema.
[spike] routerA typeof: function
[spike] routerB typeof: function
[spike] routerA own keys: length, name, prototype, caseSensitive, mergeParams, params, strict, stack
[spike] routerB own keys: length, name, prototype, caseSensitive, mergeParams, params, strict, stack
[spike] routerA.stack.length: 2
[spike] routerB.stack.length: 3
[spike] routerA === routerB: false
[spike] stack lengths differ (graphiql flag respected): true

DUAL_MOUNT: CONFIRMED
Both GraphQLAdapter(...) calls returned independent Express Router instances.
Subset A (public, no graphiql): stack.length = 2
Subset B (all,    graphiql on): stack.length = 3
```

Exit code: **0**

### Notable: HomepageService excluded from schema

`HomepageService` has no CDS entity projections — it exposes only custom functions
(`events()`, etc.). The GraphQL plugin warns `"Service has no fields and has therefore
been excluded from the schema."` This means the GraphQL schema will contain
`SearchService`, `KnowledgeGraphService`, and `DeveloperService` only. The spec
must be updated to reflect this — HomepageService cannot surface via GraphQL without
adding entity projections.

## Exact call signature for Task 6

Mount two adapters by calling `GraphQLAdapter` directly in `srv/graphql-config.js`:

```js
// srv/graphql-config.js  (Task 6 implementation target)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const GraphQLAdapter = require('@cap-js/graphql/lib/GraphQLAdapter');

const PUBLIC_SERVICES = ['KnowledgeGraphService', 'SearchService'];
// NOTE: HomepageService excluded — it has no entity fields, only custom functions,
// so GraphQLAdapter would warn and exclude it anyway.

cds.on('served', () => {
  const all = cds.services;

  // Public endpoint — unauthenticated, subset of services
  const publicServices = Object.fromEntries(
    Object.entries(all).filter(([name]) => PUBLIC_SERVICES.includes(name))
  );
  cds.app.use(
    '/graphql/public',
    cds.middlewares.before,
    GraphQLAdapter({ services: publicServices, path: '/graphql/public', graphiql: false }),
    cds.middlewares.after
  );

  // Authenticated endpoint — all application services
  const appServiceNames = ['KnowledgeGraphService', 'SearchService', 'DeveloperService'];
  const authServices = Object.fromEntries(
    Object.entries(all).filter(([name]) => appServiceNames.includes(name))
  );
  cds.app.use(
    '/graphql',
    cds.middlewares.before,
    GraphQLAdapter({ services: authServices, path: '/graphql', graphiql: true }),
    cds.middlewares.after
  );
});
```

### Caveats for Task 6

- Import `GraphQLAdapter` from `@cap-js/graphql/lib/GraphQLAdapter` — this is an
  internal path but stable across the `0.x` semver range. If the plugin upgrades
  and moves it, the import will fail at startup with a clear error (not silently).
- Do NOT use the default export (`collectServicesAndMountAdapter`) from `@cap-js/graphql`
  for either mount — it owns the `let services` singleton and will merge all services
  into whichever options object it holds, overwriting the filter.
- The `cds.services` object at `served` time contains all services including internal
  CAP framework services. Filter to the named application services explicitly.
- `cds.middlewares.before` / `cds.middlewares.after` must surround the adapter to
  ensure XSUAA JWT validation and context propagation run (same pattern as the plugin's
  own `cds-plugin.js`).
- `HomepageService` should be omitted from both subsets — it has no entity fields
  (only custom functions) and GraphQLAdapter silently excludes it anyway.

## Consequence

Proceed with the DUAL_MOUNT design from the spec (Section 2):
- Two AppRouter routes: `/graphql/public` (no auth) and `/graphql` (XSUAA-protected).
- Two `GraphQLAdapter(...)` calls in `srv/graphql-config.js` inside `cds.on('served', ...)`.
- `HomepageService` excluded from both GraphQL surfaces (no entity fields).
- Task 6 pastes the exact pattern above verbatim.
- Tasks 7, 10, 11 proceed as designed (two routes, public schema is a subset).
