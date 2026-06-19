using from './developer-service';
using from './admin-service';
using from './display-service';
using from './consolidation-service';
using from './search-service';
using from './event-stream-service';
using from './knowledge-graph-service';

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
