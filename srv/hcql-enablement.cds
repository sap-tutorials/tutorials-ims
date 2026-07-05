// #995 — enable CAP 10 HCQL protocol adapter on read-heavy services.
// Beta feature. Reference: docs/developers/reference/hcql-support.md
// Kill switch: delete this file, run `cds build --production`, redeploy.

using AdminService         from './admin-service';
using AuthorService        from './author-service';
using AnalyticsService     from './analytics-service';
using ExportsService       from './exports-service';
using ConsolidationService from './consolidation-service';
using KnowledgeGraphService from './knowledge-graph-service';
using HomepageService      from './homepage-service';
using SearchService        from './search-service';
using DeveloperService     from './developer-service';

annotate AdminService          with @hcql;
annotate AuthorService         with @hcql;
annotate AnalyticsService      with @hcql;
annotate ExportsService        with @hcql;
annotate ConsolidationService  with @hcql;
annotate KnowledgeGraphService with @hcql;
annotate HomepageService       with @hcql;
annotate SearchService         with @hcql;
annotate DeveloperService      with @hcql;
