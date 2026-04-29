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

### Custom audit events

- **SecurityEvent: AnonymizeUser** — emitted when `anonymizeUser` or `anonymizeByDsrRequest` admin actions execute

## Architecture

### File structure

```
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
  firstName   @PersonalData.IsPotentiallyPersonal;
  lastName    @PersonalData.IsPotentiallyPersonal;
  email       @PersonalData.IsPotentiallyPersonal;
  displayName @PersonalData.IsPotentiallyPersonal;
  avatarUrl   @PersonalData.IsPotentiallyPersonal;
  sapId       @PersonalData.IsPotentiallyPersonal;
}

// UserMetaData — arbitrary personal metadata linked to a user
annotate ims.UserMetaData with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

// TaskRecords — behavioral/progress data tied to a user
annotate ims.TaskRecords with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
```

### Plugin configuration

The plugin auto-configures via CDS profile presets:
- **Development** (`[development]`): `audit-log-to-console` — prints to stdout
- **Production** (`[production]`): `audit-log-to-restv2` — SAP Audit Log Service via REST v2 API
- **Outbox**: enabled by default for resilience (transactional outbox)

No explicit `cds.requires` entry needed — the plugin provides sensible defaults.

### Custom handler for anonymization

In `srv/admin-service.js`, after the existing anonymization logic:

```js
const audit = await cds.connect.to('audit-log')
await audit.log('SecurityEvent', {
  action: 'AnonymizeUser',
  data: { sapId, dsrRequestNumber: dsrRequestNumber || null },
  user: req.user.id
})
```

### MTA deployment (`mta.yaml`)

Add resource:
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
