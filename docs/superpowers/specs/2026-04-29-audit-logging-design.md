# Audit Logging Design

**Date:** 2026-04-29
**Status:** Approved
**Plugin:** `@cap-js/audit-logging`

## Goal

Add declarative audit logging for personal data entities to satisfy GDPR compliance requirements and provide admin visibility into data access. Logs to console in development, routes to SAP Audit Log Service in production via transactional outbox.

Complements the existing `@cap-js/change-tracking` (which records *what* changed) by recording *who accessed* personal data and *who triggered* GDPR actions.

## Scope

### Entities annotated with `@PersonalData`

| Entity | EntitySemantics | Rationale |
|--------|----------------|-----------|
| `Users` | `DataSubject` | The person whose data is processed. Contains name, email, avatar. |
| `UserMetaData` | `DataSubjectDetails` | Arbitrary key-value personal metadata linked to a user. |
| `TaskRecords` | `DataSubjectDetails` | Behavioral/progress data tied to a user (tutorial completions). |

### Operations logged

- **READ** — who accessed personal data (via AdminService or DeveloperService)
- **WRITE** — who modified personal data (updates, deletions)

### READ volume consideration

`DeveloperService` exposes `TaskRecords` to end users (every developer on every page load). Without mitigation, annotating `TaskRecords` at the `db/` level would generate audit READ events for every progress check — potentially hundreds per minute at scale.

**Mitigation strategy:**

- The plugin only logs READ events when personal data fields are actually projected in the response. Since `DeveloperService.TaskRecords` projects progress/status fields (not the `user` association details), READ events should only fire when the `user` expand is requested.
- If volume proves excessive in production, set `cds.requires.audit-log.handle: ["WRITE"]` to suppress READ logging globally, or move `@PersonalData` annotations to service-level projections on `AdminService` only (instead of `db/` level) so DeveloperService never triggers audit events.
- Monitor audit log volume after initial deployment and tune as needed.

### Custom audit events

- **SecurityEvent: AnonymizeUser** — emitted when `anonymizeUser` or `anonymizeByDsrRequest` admin actions execute

## Architecture

### File structure

```text
db/audit-logging.cds          # @PersonalData annotations (new file)
srv/admin-service.js           # Add audit.log() call in anonymization handlers (modify)
package.json                   # Add @cap-js/audit-logging dependency (modify)
mta.yaml                       # Add auditlog service resource + binding (modify)
test/unit/audit-logging.test.js # Annotation + handler tests (new file)
```

### Data model annotations (`db/audit-logging.cds`)

```cds
using { com.sap.developers.ims as ims } from './schema';

// Users is the Data Subject — the person whose data is processed
annotate ims.Users with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubject'
} {
  ID          @PersonalData.FieldSemantics: 'DataSubjectID';
  uuid        @PersonalData.IsPotentiallyPersonal;
  firstName   @PersonalData.IsPotentiallyPersonal;
  lastName    @PersonalData.IsPotentiallyPersonal;
  email       @PersonalData.IsPotentiallyPersonal;
  displayName @PersonalData.IsPotentiallyPersonal;
  avatarUrl   @PersonalData.IsPotentiallyPersonal;
  sapId       @PersonalData.IsPotentiallyPersonal;
}

// UserMetaData — arbitrary personal metadata linked to a user
annotate ims.UserMetaData with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

// TaskRecords — behavioral/progress data tied to a user
annotate ims.TaskRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
```

### Plugin configuration

The plugin auto-configures via CDS profile presets:
- **Development** (`[development]`): `audit-log-to-console` — prints to stdout
- **Hybrid** (`[hybrid]`): `audit-log-to-restv2` — routes to real SAP Audit Log Service
- **Production** (`[production]`): `audit-log-to-restv2` — SAP Audit Log Service via REST v2 API
- **Outbox**: enabled by default for resilience (transactional outbox)

No explicit `cds.requires` entry needed — the plugin provides sensible defaults.

> **Hybrid profile note:** In `[hybrid]` mode the plugin attempts to reach the real Audit Log Service. Since `tutorials-audit-log` is not typically bound locally, hybrid test runs (`npm run test:hybrid`) will use the development profile override via `cds bind`. If audit log binding is needed for hybrid testing, add it to the `cds bind` setup in `scripts/setup-hybrid-env.js`.

### Custom handler for anonymization

In `srv/admin-service.js`, after the existing anonymization logic:

```js
const audit = await cds.connect.to('audit-log')
await audit.log('SecurityEvent', {
  data: {
    action: 'AnonymizeUser',
    sapId,
    dsrRequestNumber: dsrRequestNumber || null
  }
})
```

> **Note:** The `SecurityEvent` type extends `LogEntry` which auto-populates `uuid`, `tenant`, `user`, and `time` from the request context. The `data` field is a free-form object for event-specific details. Do NOT pass `user` explicitly — it is derived from `req.user` automatically.

### MTA deployment (`mta.yaml`)

Add resource (using `managed-service` type since this is a new service the MTA should create, consistent with how `tutorials-destination` and `tutorials-html5-repo-*` are defined):

```yaml
resources:
  - name: tutorials-audit-log
    type: org.cloudfoundry.managed-service
    parameters:
      service: auditlog
      service-plan: premium
```

Add binding to `tutorials-srv` module:

```yaml
modules:
  - name: tutorials-srv
    requires:
      - name: tutorials-audit-log
```

> **Note:** The project uses `existing-service` for pre-provisioned shared services (HANA, XSUAA, mail) and `managed-service` for services the MTA creates and owns. Since the audit log service is new and application-specific, `managed-service` is correct.

## Testing

### Unit tests (`test/unit/audit-logging.test.js`)

1. **Annotation verification**: Load CDS model, assert `@PersonalData` annotations present on `Users`, `UserMetaData`, `TaskRecords` with correct semantics
2. **Handler verification**: Call `anonymizeUser` action, assert `audit.log` was invoked with expected SecurityEvent payload

### Manual dev verification

1. `cds watch` → GET `/admin/Users` → confirm audit READ entry in console
2. POST `/admin/anonymizeUser` → confirm SecurityEvent entry in console

### No hybrid test changes

Annotations don't affect DB schema. The audit log service is external (mocked in unit tests, console in dev).

## Relationship to existing features

| Feature | What it tracks | Format |
|---------|---------------|--------|
| Change Tracking (`@cap-js/change-tracking`) | What data changed, when, by whom | CDS ChangeView entity |
| **Audit Logging (`@cap-js/audit-logging`)** | **Who accessed/modified personal data** | **SAP Audit Log Service events** |
| PrivacyProtectionActions entity | GDPR request lifecycle (requested → completed) | Application table |
| Anonymization library | Execution of data erasure | Inline operation |

## Decisions

- **DataSubjectRole = 'Developer'**: All users of this platform are developers following tutorials. Single role simplifies the model.
- **No annotation on DeveloperService projections**: The plugin resolves annotations from the underlying entity regardless of which service exposes it. Annotating at `db/` level covers all services.
- **Premium plan for auditlog**: Required for REST v2 API access. Standard plan only supports older APIs.
- **Transactional outbox**: Left at default (enabled). Ensures audit entries are committed atomically with the business transaction.
- **`uuid` field annotated as personal**: The SAP-issued user identifier (`uuid`) is personally attributable and included in `@PersonalData.IsPotentiallyPersonal` alongside display fields.
- **SecurityEvent uses `data` envelope only**: The `SecurityEvent` type extends `LogEntry` which auto-fills `user`, `tenant`, `time`, `uuid`. Custom fields go inside the `data: {}` free-form object — never pass `user` explicitly.
- **DeveloperService READ logging deferred**: Start with annotations at `db/` level. If production volume is excessive, either set `handle: ["WRITE"]` globally or move annotations to service-level projections on AdminService only.
- **`DataSubjectRole` only on DataSubject entity**: Per CAP conventions, `DataSubjectRole` belongs only on `Users` (EntitySemantics: DataSubject). Detail entities (`UserMetaData`, `TaskRecords`) inherit the role relationship through their `DataSubjectID` field semantics.
