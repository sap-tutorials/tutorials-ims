using { com.sap.developers.ims as ims } from '../db/schema';

// srv-mcp: minimal DeveloperService surface for the 7 MCP read/write tools.
// Object-form @protocol: mcp at /mcp/api (odata at /api for CAP service-level
// OData adapter — required so @cap-js/mcp auto-mounts correctly).
// @requires: 'authenticated-user' on the service + every entity/function/action
// ensures CAP enforces auth before the @cap-js/mcp adapter dispatches.
// (#1105 Task 11 — srv-mcp dedicated authenticated MCP module)
@requires: 'authenticated-user'
@protocol: [{ kind: 'odata', path: '/api' }, { kind: 'mcp', path: '/mcp/api' }]
service DeveloperService {

  // Minimal entity projections for the 5 read tools.
  // @readonly: write operations go to the remote MainDeveloperService.

  @(requires: 'authenticated-user')
  @readonly entity Tutorials as projection on ims.Tutorials {
    ID, slug, title, legacyId, status, stepCount
  };

  @(requires: 'authenticated-user')
  @readonly entity TaskRecords as projection on ims.TaskRecords;

  @(requires: 'authenticated-user')
  @readonly entity Events as projection on ims.Events {
    ID, legacyId, name, startDate, endDate, timeZone, eventType
  };
}
