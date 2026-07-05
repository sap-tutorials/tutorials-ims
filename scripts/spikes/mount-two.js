// Spike: Prove GraphQLAdapter can be mounted twice with two service subsets.
// Run: node scripts/spikes/mount-two.js
//      npx tsx scripts/spikes/mount-two.js
//
// Goal: confirm DUAL_MOUNT is feasible by actually instantiating GraphQLAdapter
// with two real CDS service instances (built from a loaded CSN) and verifying
// both returned handlers are independent Express Routers.
//
// Exit 0 = DUAL_MOUNT confirmed. Exit 1 = SINGLE_MOUNT or instantiation failure.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cds = require('@sap/cds');
const GraphQLAdapter = require('@cap-js/graphql/lib/GraphQLAdapter');

// Use in-memory SQLite so no HANA binding is needed.
cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };

const SRV_DIR = path.join(__dirname, '../../srv');
const PUBLIC_NAMES = ['HomepageService', 'KnowledgeGraphService', 'SearchService'];

async function run() {
  // --- Step 1: Load four CDS service definitions and compile to CSN ---
  console.log('[spike] Loading CDS service definitions...');
  const csn = await cds.load([
    path.join(SRV_DIR, 'homepage-service.cds'),
    path.join(SRV_DIR, 'search-service.cds'),
    path.join(SRV_DIR, 'knowledge-graph-service.cds'),
    path.join(SRV_DIR, 'developer-service.cds'),
  ]);
  const model = cds.linked(csn);
  const serviceNames = model.services.map(s => s.name);
  console.log('[spike] Services loaded:', serviceNames.join(', '));

  // --- Step 2: Build real ApplicationService instances for each service ---
  // Same pattern used internally by @cap-js/graphql/lib/compile.js.
  const allServices = Object.fromEntries(
    model.services.map(s => [s.name, new cds.ApplicationService(s.name, model)])
  );
  const publicServices = Object.fromEntries(
    Object.entries(allServices).filter(([n]) => PUBLIC_NAMES.includes(n))
  );
  console.log('[spike] Subset A (public):', Object.keys(publicServices).join(', '));
  console.log('[spike] Subset B (all):   ', Object.keys(allServices).join(', '));

  // --- Step 3: Instantiate GraphQLAdapter TWICE with different service subsets ---
  const routerA = GraphQLAdapter({ services: publicServices, path: '/graphql/public', graphiql: false });
  const routerB = GraphQLAdapter({ services: allServices, path: '/graphql', graphiql: true });

  // --- Step 4: Assert both are independent function/handler instances ---
  const aIsFunction = typeof routerA === 'function';
  const bIsFunction = typeof routerB === 'function';
  const areDistinct = routerA !== routerB;
  // Express Router returns a function; check its own-property keys as shape proof.
  const aKeys = Object.getOwnPropertyNames(routerA).join(', ');
  const bKeys = Object.getOwnPropertyNames(routerB).join(', ');
  // routerB has one extra stack entry (graphiql middleware) vs routerA
  const aDifferentStack = routerA.stack.length !== routerB.stack.length;

  console.log('[spike] routerA typeof:', typeof routerA);
  console.log('[spike] routerB typeof:', typeof routerB);
  console.log('[spike] routerA own keys:', aKeys);
  console.log('[spike] routerB own keys:', bKeys);
  console.log('[spike] routerA.stack.length:', routerA.stack.length);
  console.log('[spike] routerB.stack.length:', routerB.stack.length);
  console.log('[spike] routerA === routerB:', routerA === routerB);
  console.log('[spike] stack lengths differ (graphiql flag respected):', aDifferentStack);

  if (!aIsFunction || !bIsFunction) {
    console.log('\nSINGLE_MOUNT: GraphQLAdapter did not return callable handlers');
    process.exit(1);
  }
  if (!areDistinct) {
    console.log('\nSINGLE_MOUNT: both adapters are the same instance (singleton leak)');
    process.exit(1);
  }

  console.log('\nDUAL_MOUNT: CONFIRMED');
  console.log('Both GraphQLAdapter(...) calls returned independent Express Router instances.');
  console.log('Subset A (public, no graphiql): stack.length =', routerA.stack.length);
  console.log('Subset B (all,    graphiql on): stack.length =', routerB.stack.length);
  process.exit(0);
}

run().catch(err => {
  console.error('[spike] Unexpected error:', err.message);
  console.error(err.stack);
  console.log('\nSINGLE_MOUNT: instantiation failed — see error above');
  process.exit(1);
});
