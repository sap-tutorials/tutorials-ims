# ORD Plugin Integration Design

**Date:** 2026-05-01
**Status:** Approved
**Scope:** Add `@cap-js/ord` plugin to expose Open Resource Discovery documents for all CDS services

## Context

The tutorial platform exposes 6 CDS services: DeveloperService, AdminService, DisplayService, ConsolidationService, SearchService, and EventStreamService. These are currently undiscoverable by external systems — consumers must know the endpoints exist and manually inspect `$metadata`.

ORD (Open Resource Discovery) is an SAP standard that provides a machine-readable catalog of all APIs and services exposed by an application. BTP integration tools, API Management, and other landscape systems can auto-discover resources via a well-known endpoint.

This is an SAP-owned service (developers.sap.com platform), hence the `sap:core:v1` policy level is appropriate.

## Decision

Install `@cap-js/ord` as a CAP plugin. It auto-activates and serves ORD documents at runtime. All services are publicly visible in the ORD catalog (authentication is still required to *use* each service — ORD only describes them).

## Configuration

### package.json (`cds.ord` section)

The configuration must be nested under the existing `"cds"` key in `package.json` (alongside `requires`, `hana`, `websocket`, etc.):

```json
{
  "cds": {
    "ord": {
      "namespace": "sap.tutorials",
      "description": "SAP Developer Tutorial Platform — progress tracking, mission management, and real-time event dashboards for developers.sap.com",
      "policyLevels": ["sap:core:v1"],
      "defaultVisibility": "public"
    }
  }
}
```

### ORD Annotations (`srv/ord-annotations.cds`)

Separate CDS file with `@ORD.Extensions` annotations enriching each service's ORD entry:

| Service | Title | Line of Business |
|---------|-------|-----------------|
| DeveloperService | Developer Tutorial Progress API | Platform Engineering |
| AdminService | Tutorial Administration API | Platform Engineering |
| DisplayService | Event Display Dashboard API | Platform Engineering |
| ConsolidationService | Account Consolidation API | Platform Engineering |
| SearchService | Tutorial Search API | Platform Engineering |
| EventStreamService | Real-time Event Stream | Platform Engineering |

Each annotation includes `extensible: { supported: 'no' }` since these are internal platform APIs.

**Note on EventStreamService:** This service uses `@protocol: ['websocket', 'rest']` (no OData). The ORD plugin should still catalog it, but the generated entry will differ from OData services — verify the generated ORD document for correct resource URLs.

### AppRouter Routes (`approuter/xs-app.json`)

Add unauthenticated pass-through for `/.well-known/` and `/ord/` paths. Insert these **after** the `/health` route and **before** the catch-all `^(.*)$` route (alongside other unauthenticated backend routes like `/search`, `/build`, `/health`):

```json
{
  "source": "^/.well-known/(.*)$",
  "target": "/.well-known/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
},
{
  "source": "^/ord/(.*)$",
  "target": "/ord/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

These do NOT conflict with existing routes since no existing route matches `/.well-known/` or `/ord/`.

## Endpoints Exposed

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/open-resource-discovery` | Standard discovery entry point (JSON pointer to ORD document) |
| `/ord/v1/documents/ord-document` | Full ORD document with all API resources |

## Build Integration

The plugin serves ORD documents dynamically at **runtime** — no build step needed for the deployed app. The optional `cds build --for ord` generates static files into `gen/ord/` for offline inspection or CI validation, but is NOT required in the MTA build pipeline.

No changes to `mta.yaml` are needed. The plugin auto-activates when installed as a dependency.

## What Does NOT Change

- No new XSUAA scopes or role collections
- No database schema changes
- No changes to existing service handlers or logic
- No changes to mta.yaml build commands
- No changes to existing tests

## Testing

**Local verification:**

- `cds watch` serves `/.well-known/open-resource-discovery` returning valid JSON
- `/ord/v1/documents/ord-document` contains entries for all 6 services
- `cds build --for ord` produces output in `gen/ord/`

**Smoke test addition (`test/smoke/public-endpoints.test.js`):**

- `/.well-known/open-resource-discovery` responds 200 with JSON through AppRouter (no auth)
- `/ord/v1/documents/ord-document` responds 200 with JSON through AppRouter (no auth)

This ensures the AppRouter route config is correct in the deployed environment.
