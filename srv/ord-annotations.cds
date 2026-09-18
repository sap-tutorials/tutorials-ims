using from './developer-service';
using from './admin-service';
using from './display-service';
using from './consolidation-service';
using from './search-service';
using from './event-stream-service';
using from './knowledge-graph-service';
using from './a2a-service';

// Fold the @cap-js/ord runtime service into this project's own srv model so it
// compiles into the production CSN (gen/srv). Without this, `cds build --production`
// treats the plugin-provided model in node_modules as an external required service,
// omits it from the served CSN, and the runtime never registers the ORD routes
// (/.well-known/open-resource-discovery, /ord/v1/documents/ord-document) → 404 (#2307).
using from '@cap-js/ord/lib/services/ord-service';

annotate DeveloperService with @ORD.Extensions: {
    title: 'Developer Tutorial Progress API',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};

annotate AdminService with @ORD.Extensions: {
    title: 'Tutorial Administration API',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};

annotate DisplayService with @ORD.Extensions: {
    title: 'Event Display Dashboard API',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};

annotate ConsolidationService with @ORD.Extensions: {
    title: 'Account Consolidation API',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};

annotate SearchService with @ORD.Extensions: {
    title: 'Tutorial Search API',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};

annotate EventStreamService with @ORD.Extensions: {
    title: 'Real-time Event Stream',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};

annotate KnowledgeGraphService with @ORD.Extensions: {
    title: 'Tutorial Knowledge Graph API',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};

annotate A2aService with @ORD.Extensions: {
    title: 'Agent-to-Agent (A2A) Endpoint',
    lineOfBusiness: ['Platform Engineering'],
    extensible: { supported: 'no' }
};
