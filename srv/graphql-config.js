// srv/graphql-config.js
// Dual-mount @cap-js/graphql. Registered as a second GraphQL mount at
// /graphql/public exposing only the anonymous-readable services
// (KnowledgeGraphService public projections, SearchService). The primary
// /graphql mount is registered by @cap-js/graphql's cds-plugin.js served
// hook and sees all @graphql-annotated services including DeveloperService's
// Tutorial.API-scoped entities.
//
// Mount pattern validated by the Task 1 spike — see
// scripts/spikes/graphql-mount-spike.md (commit 6a25a3ee). We call
// GraphQLAdapter directly (bypassing the singleton in the plugin's index.js)
// so we can pass a filtered service map for the public endpoint.

const cds = require('@sap/cds');
const GraphQLAdapter = require('@cap-js/graphql/lib/GraphQLAdapter');
// ^^ INTERNAL import path — no `exports` map entry. Stable across @cap-js/graphql
//    0.x. If the plugin upgrades and moves this file, the require throws at
//    boot with a clear "Cannot find module" — not silent behavioural drift.

const PUBLIC_SERVICES = ['KnowledgeGraphService', 'SearchService'];
// HomepageService intentionally excluded — dropped from v1 after the Task 1
// spike observed it exposes only CDS function/action declarations, which
// @cap-js/graphql v0.14 does not project.

cds.on('served', () => {
  const app = cds.app;
  if (!app) return;

  const publicServices = Object.fromEntries(
    Object.entries(cds.services).filter(([name]) => PUBLIC_SERVICES.includes(name))
  );

  app.use(
    '/graphql/public',
    cds.middlewares.before,
    GraphQLAdapter({ services: publicServices, path: '/graphql/public', graphiql: false }),
    cds.middlewares.after
  );
  cds.log('graphql').info('mounted /graphql/public with services:', PUBLIC_SERVICES);
});

module.exports = {};
