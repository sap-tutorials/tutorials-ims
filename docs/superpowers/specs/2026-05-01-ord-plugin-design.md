# ORD Plugin Integration Design

**Date:** 2026-05-01
**Status:** Approved
**Scope:** Add `@cap-js/ord` plugin to expose Open Resource Discovery documents for all CDS services

## Context

The tutorial platform exposes 4 primary CDS services (DeveloperService, AdminService, DisplayService, ConsolidationService) plus 2 secondary services (SearchService, EventStreamService). These are currently undiscoverable by external systems — consumers must know the endpoints exist and manually inspect `$metadata`.

ORD (Open Resource Discovery) is an SAP standard that provides a machine-readable catalog of all APIs and services exposed by an application. BTP integration tools, API Management, and other landscape systems can auto-discover resources via a well-known endpoint.

## Decision

Install `@cap-js/ord` as a CAP plugin. It auto-activates and serves ORD documents at runtime. All services are publicly visible in the ORD catalog (authentication is still required to *use* each service — ORD only describes them).

## Configuration

### package.json (`cds.ord` section)

```json
{
  "ord": {
    "namespace": "sap.tutorials",
    "description": "SAP Developer Tutorial Platform — progress tracking, mission management, and real-time event dashboards for developers.sap.com",
    "policyLevels": ["sap:core:v1"],
    "defaultVisibility": "public"
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

### AppRouter Route

Add unauthenticated pass-through for `/.well-known/` and `/ord/` paths in `approuter/xs-app.json`:

```json
{
  "source": "^/.well-known/(.*)$",
  "target": "/.well-known/$1",
  "destination": "srv-api",
  "authenticationType": "none"
}
```

```json
{
  "source": "^/ord/(.*)$",
  "target": "/ord/$1",
  "destination": "srv-api",
  "authenticationType": "none"
}
```

These must be placed before the catch-all route.

## Endpoints Exposed

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/open-resource-discovery` | Standard discovery entry point (JSON pointer to ORD document) |
| `/ord/v1/documents/ord-document` | Full ORD document with all API resources |

## Build Integration

`cds build --for ord` generates static ORD + OpenAPI + EDMX files into `gen/ord/`. This is additive — no changes to existing build tasks.

## What Does NOT Change

- No new XSUAA scopes or role collections
- No database schema changes
- No changes to existing service handlers or logic
- No changes to mta.yaml modules (plugin auto-activates)
- No changes to existing tests (ORD is additive metadata)

## Testing

- Verify `cds watch` serves `/.well-known/open-resource-discovery` returning valid JSON
- Verify `/ord/v1/documents/ord-document` contains entries for all 6 services
- Verify `cds build --for ord` produces output in `gen/ord/`
- Verify AppRouter routes pass through to ORD endpoints without auth
