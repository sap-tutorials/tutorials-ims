// srv/graphql-config.js
// Dual-mount @cap-js/graphql. Installs two service-filtered GraphQL endpoints:
//
//   /graphql        → KnowledgeGraphService + SearchService + DeveloperService
//                     (requires Tutorial.API or KnowledgeGraph.Admin scope where
//                      the underlying service enforces it)
//   /graphql/public → KnowledgeGraphService + SearchService only
//                     (anonymous-readable; no DeveloperService)
//
// Design: cds.protocols.graphql.path (package.json) redirects the plugin's
// default "collect-all-@graphql-services" mount to /graphql/_plugin so it
// doesn't collide with our two explicit mounts below. We install /graphql/public
// BEFORE /graphql so Express's prefix-match logic serves the more-specific path
// without falling through to the broader handler.
//
// Mount pattern validated by the Task 1 spike — see
// scripts/spikes/graphql-mount-spike.md (commit 6a25a3ee). We call
// GraphQLAdapter directly (bypassing the singleton in the plugin's index.js)
// so we can pass a filtered service map per endpoint.
//
// NOTE: This file uses createRequire because @cap-js/graphql is CJS-only and
// GraphQLAdapter must come from the same graphql-js instance as the schema
// generator. server.js is ESM (package.json "type":"module"); we bridge via
// createRequire so this module stays ESM-compatible.

import cds from '@sap/cds';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const GraphQLAdapter = _require('@cap-js/graphql/lib/GraphQLAdapter');
// ^^ INTERNAL import path — no `exports` map entry. Stable across @cap-js/graphql
//    0.x. If the plugin upgrades and moves this file, the require throws at
//    boot with a clear "Cannot find module" — not silent behavioural drift.

const PUBLIC_SERVICES = ['KnowledgeGraphService', 'SearchService'];
// HomepageService intentionally excluded — dropped from v1 after the Task 1
// spike observed it exposes only CDS function/action declarations, which
// @cap-js/graphql v0.14 does not project.

const AUTH_SERVICES = ['KnowledgeGraphService', 'SearchService', 'DeveloperService'];

cds.on('served', () => {
  const app = cds.app;
  if (!app) return;

  const pick = (names) => Object.fromEntries(
    Object.entries(cds.services).filter(([name]) => names.includes(name))
  );

  // /graphql/public MUST be mounted before /graphql — Express's longest-prefix
  // rule does NOT apply to app.use(); it uses insertion order. Without this
  // ordering, a request to /graphql/public would match the /graphql handler first.
  app.use(
    '/graphql/public',
    cds.middlewares.before,
    GraphQLAdapter({ services: pick(PUBLIC_SERVICES), path: '/graphql/public', graphiql: false }),
    cds.middlewares.after
  );

  app.use(
    '/graphql',
    cds.middlewares.before,
    GraphQLAdapter({ services: pick(AUTH_SERVICES), path: '/graphql', graphiql: true }),
    cds.middlewares.after
  );

  cds.log('graphql').info('mounted /graphql/public with services:', PUBLIC_SERVICES);
  cds.log('graphql').info('mounted /graphql with services:', AUTH_SERVICES);
});

export {};
