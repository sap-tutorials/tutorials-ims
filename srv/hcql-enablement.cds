// srv/hcql-enablement.cds
// #2247 — HCQL ("CQL over HTTP", CAP 10 beta) re-land, authenticated services only.
//
// Each service gets an explicit object-form @protocol list mounting HCQL on a
// distinct /hcql/<svc> path. The odata entry's `path` MUST equal the service's
// current @path exactly, or the OData URL moves and breaks every client.
// AdminService is handled separately in srv/admin-service-mcp.cds (it already
// carries an @protocol list with MCP). Requires @sap/cds >= 10.1.0.
// KILL SWITCH: delete this file + drop the hcql entry from AdminService, then
// `cds build --production` + redeploy.
using from './author-service';
using from './analytics-service';
using from './exports-service';
using from './consolidation-service';

annotate AuthorService        with @protocol: [{ kind: 'odata', path: '/author' },          { kind: 'hcql', path: '/hcql/author' }];
annotate AnalyticsService     with @protocol: [{ kind: 'odata', path: '/admin/analytics' }, { kind: 'hcql', path: '/hcql/analytics' }];
annotate ExportsService       with @protocol: [{ kind: 'odata', path: '/admin/exports' },   { kind: 'hcql', path: '/hcql/exports' }];
annotate ConsolidationService with @protocol: [{ kind: 'odata', path: '/api/v1' },          { kind: 'hcql', path: '/hcql/consolidation' }];
