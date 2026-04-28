# IMS CAP Node.js Rewrite — Design Spec

**Date**: 2026-04-28
**Status**: Approved
**Scope**: Full system parity rewrite of IMS Spring Boot/Java as CAP Node.js

## Overview

Rewrite the IMS (Internal Management System) at `D:\projects\com.sap.developers.ims` as a CAP Node.js service within the tutorials-poc project. The IMS is a Spring Boot application with 35 JPA entities, 26 REST controllers, 50+ service classes, scheduled jobs, and integrations with NGDS, Adobe Analytics, SCI, and AEM.

### Goals

- Full endpoint and data model parity with the existing Java system
- New HDI container (clean isolation from existing HANA schema)
- Shared XSUAA instance (same JWT tokens work against both systems)
- Parallel operation for migration testing
- Local hybrid testing via `cds bind` to remote BTP service instances
- AEM integration replaced with native GitHub-sourced metadata from this project's build pipeline
- Frontend UI rewrite deferred to a later phase

## Architecture Decision: Root-Level CAP

The CAP project lives at the repository root (`db/`, `srv/`) alongside the existing `site/` and `approuter/`. This follows SAP's standard full-stack CAP project structure:

```
tutorials-poc/
├── db/
│   ├── schema.cds              # CDS data model
│   └── sequences.hdbsequence   # HANA sequences for integer keys
├── srv/
│   ├── developer-service.cds   # Frontend-facing API
│   ├── developer-service.js    # Custom handlers
│   ├── admin-service.cds       # Admin API
│   ├── admin-service.js
│   ├── display-service.cds     # Dashboard/display API
│   ├── display-service.js
│   ├── consolidation-service.cds  # Account merge (SCI-triggered)
│   ├── consolidation-service.js
│   ├── lib/                    # Integration clients
│   │   ├── ngds-client.js
│   │   ├── sci-client.js
│   │   ├── adobe-analytics.js
│   │   ├── status-calculator.js
│   │   ├── accomplishment-evaluator.js
│   │   ├── account-merge.js
│   │   └── tutorial-sync.js    # Replaces AEM integration
│   ├── jobs/                   # Scheduled tasks
│   │   ├── scheduler.js
│   │   ├── job-lock.js         # Distributed lock via DB
│   │   ├── cleanup.js
│   │   ├── analytics.js
│   │   └── account-merge-job.js
│   └── middleware/
│       └── websocket.js        # STOMP-over-WebSocket adapter
├── site/                       # Existing VitePress frontend
├── approuter/                  # Existing AppRouter
├── display-app/                # Existing display UI
├── package.json                # Updated: CAP + VitePress
├── mta.yaml                    # Updated: CAP srv + HDI deployer modules
└── .cdsrc.json                 # CAP configuration
```

## Data Model

### Design Philosophy

The Java app uses single-table JPA inheritance (`ims_task` with `task_type` discriminator). In CDS, we use separate entities with a shared aspect. This maps more cleanly to HANA, avoids the "god table" pattern, and gives each entity type its own table with only relevant columns.

### Integer Key Strategy

The IMS uses HANA sequences for all entity IDs. Since CAP has no built-in auto-increment for Integer keys, we handle this explicitly:

1. **HANA deployment**: Custom `.hdbsequence` files in `db/src/` define sequences (e.g., `IMS_USER_SEQ`, `IMS_TASK_SEQ`, `IMS_TASK_RECORD_SEQ`). Service handlers call `SELECT <seq>.NEXTVAL FROM DUMMY` before inserts.
2. **SQLite (local dev)**: A helper function simulates sequences using a `Sequences` config table with current values. This is only for local development — production always uses HANA sequences.
3. **Migration safety**: Sequences start at a high offset (e.g., 10,000,000) so that migrated IDs from the old system (which uses lower ranges) never collide with newly generated IDs.

### Core Task Hierarchy

```cds
namespace com.sap.developers.ims;
using { managed } from '@sap/cds/common';

aspect TaskBase : managed {
  key ID                    : Integer;
  title                     : String(255) @mandatory;
  description               : LargeString;
  status                    : String(50);
  deletionReason            : String(500);
  primaryTag                : String(255);
  experienceTag             : String(255);
  averageTimeToComplete     : Integer;
}

entity Tutorials : TaskBase {
  slug                      : String(255) @mandatory;  // URL-friendly identifier, unique
  mdFileUrl                 : String(1000);
  featuredOrder             : Integer;
  steps                     : Composition of many Steps on steps.tutorial = $self;
  tags                      : Association to many TutorialTags on tags.tutorial = $self;
  meta                      : Composition of many TutorialMeta on meta.tutorial = $self;
  contributors              : Composition of many TutorialContributors on contributors.tutorial = $self;
  repositories              : Composition of many TutorialRepositories on repositories.tutorial = $self;
}

entity Missions : TaskBase {
  communityMissionId        : String(255);
  completionPaths           : Composition of many CompletionPaths on completionPaths.mission = $self;
}

entity Groups : TaskBase {
  missions                  : Association to many Missions;
}

entity Steps : TaskBase {
  tutorial                  : Association to Tutorials;
  stepOrder                 : Integer;
}

entity Checkpoints : TaskBase { }
```

### User & Progress

```cds
entity Users {
  key ID                    : Integer;
  uuid                      : String(36) @mandatory;  // unique, immutable
  sapId                     : String(255);            // unique, optional
  // Profile (flattened from Java's @Embedded Profile)
  firstName                 : String(255);
  lastName                  : String(255);
  email                     : String(255);
  displayName               : String(255);
  avatarUrl                 : String(1000);
  // Relationships
  taskRecords               : Composition of many TaskRecords on taskRecords.user = $self;
  prizeRecords              : Composition of many PrizeRecords on prizeRecords.user = $self;
  accomplishments           : Composition of many AccomplishmentRecords on accomplishments.user = $self;
  metadata                  : Composition of many UserMetaData on metadata.user = $self;
  environmentTabs           : Composition of many DeveloperEnvironmentTabs on environmentTabs.user = $self;
}

entity TaskRecords {
  key ID                    : Integer;
  user                      : Association to Users @mandatory;
  // Polymorphic FK: taskId + taskType together identify the target entity.
  // CAP cannot enforce referential integrity on polymorphic references,
  // so validation is handled in service handlers. OData consumers cannot
  // $expand to the task — they must use taskType to determine which entity
  // to query separately. This mirrors the Java system's JPA @NotFound(IGNORE).
  taskId                    : Integer;
  taskType                  : String enum { TUTORIAL; MISSION; GROUP; STEP; CHECKPOINT; };
  status                    : String enum { COMPLETED; IN_PROGRESS; };
  progress                  : Integer default 0;  // 0-100
  completionTime            : Int64;
  completionDate            : Timestamp;
  contentLanguage           : String(10);
  siteLanguage              : String(10);
  submissionIdStarted       : UUID;
  submissionIdCompleted     : UUID;
  titleSnapshot             : String(255);  // Task title at time of record creation
  progressNote              : String(1000);
  event                     : Association to Events;
}

entity UserMetaData {
  key ID                    : Integer;
  user                      : Association to Users;
  key_                      : String(255);  // metadata key
  value                     : String(2000);
}

entity DeveloperEnvironmentTabs {
  key ID                    : Integer;
  user                      : Association to Users;
  tabName                   : String(255);
  tabOrder                  : Integer;
  links                     : Composition of many DeveloperEnvironmentLinks on links.tab = $self;
}

entity DeveloperEnvironmentLinks {
  key ID                    : Integer;
  tab                       : Association to DeveloperEnvironmentTabs;
  title                     : String(255);
  url                       : String(1000);
  linkOrder                 : Integer;
}
```

### Events, Prizes & Accomplishments

```cds
entity Events {
  key ID                    : Integer;
  name                      : String(255);
  startDate                 : Timestamp;
  endDate                   : Timestamp;
  timeZone                  : String(50);
  taskRecords               : Association to many TaskRecords on taskRecords.event = $self;
  prizes                    : Composition of many Prizes on prizes.event = $self;
}

entity Prizes {
  key ID                    : Integer;
  name                      : String(255);
  event                     : Association to Events;
}

entity PrizeRecords {
  key ID                    : Integer;
  user                      : Association to Users;
  event                     : Association to Events;
  prize                     : Association to Prizes;
  completionPathItem        : Association to CompletionPathItems;
  status                    : String(50);
}

entity Tags {
  key ID                    : Integer;
  name                      : String(255);
}

entity TutorialTags {
  key tutorial              : Association to Tutorials;
  key tag                   : Association to Tags;
}

entity Accomplishments {
  key ID                    : Integer;
  name                      : String(255);
  rule                      : String(2000);  // SQL pattern for evaluation
  description               : String(1000);
}

entity AccomplishmentRecords {
  key ID                    : Integer;
  user                      : Association to Users;
  accomplishment            : Association to Accomplishments;
  awardedAt                 : Timestamp;
}

entity CompletionPaths {
  key ID                    : Integer;
  mission                   : Association to Missions;
  name                      : String(255);
  items                     : Composition of many CompletionPathItems on items.path = $self;
}

entity CompletionPathItems {
  key ID                    : Integer;
  path                      : Association to CompletionPaths;
  taskId                    : Integer;
  taskType                  : String(20);
  itemOrder                 : Integer;
}
```

### Tutorial Metadata & Content Management

```cds
entity TutorialMeta {
  key ID                    : Integer;
  tutorial                  : Association to Tutorials;
  reviewedDate              : Timestamp;
  owner                     : String(255);
  monitoredStatus           : String(50);    // ACTIVE, WARNING, CRITICAL, ARCHIVED
  notificationNumber        : Integer default 0;
  lastNotificationDate      : Timestamp;
}

entity TutorialContributors {
  key ID                    : Integer;
  tutorial                  : Association to Tutorials;
  name                      : String(255);
  email                     : String(255);
  role                      : String(50);    // AUTHOR, REVIEWER, MAINTAINER
}

entity TutorialRepositories {
  key ID                    : Integer;
  tutorial                  : Association to Tutorials;
  repoUrl                   : String(1000);
  branch                    : String(255);
  owner                     : String(255);
}
```

### Analytics, Jobs & System

```cds
entity ActiveLearnerRecords {
  key ID                    : Integer;
  recordDate                : Date;
  count                     : Integer;
}

entity DashboardMonitoredRecords {
  key ID                    : Integer;
  event                     : Association to Events;
  metric                    : String(255);
  value                     : Integer;
  recordedAt                : Timestamp;
}

entity StepFailures {
  key ID                    : Integer;
  taskRecord                : Association to TaskRecords;
  stepNumber                : Integer;
  failureDate               : Timestamp;
  errorMessage              : String(2000);
}

entity NGDSFailedMessages {
  key ID                    : Integer;
  payload                   : LargeString;
  errorMessage              : String(2000);
  createdAt                 : Timestamp;
  retryCount                : Integer default 0;
  maxRetries                : Integer default 10;
  status                    : String enum { PENDING; FAILED_PERMANENTLY; };
}

// Application configuration (key-value store)
entity ImsConfig {
  key ID                    : Integer;
  ![key]                    : String(255);  // CDS quoted identifier for reserved word
  value                     : String(2000);
}

// Job execution lock for single-instance enforcement
entity JobLocks {
  key jobName               : String(100);
  lockedBy                  : String(255);
  lockedAt                  : Timestamp;
  expiresAt                 : Timestamp;
}

// Account merge workflow tracking
entity PrimaryAccounts {
  key ID                    : Integer;
  uuid                      : String(36);
  status                    : String(50);
}

entity SecondaryAccounts {
  key ID                    : Integer;
  uuid                      : String(36);
  primaryAccount            : Association to PrimaryAccounts;
  status                    : String(50);
  mergedAt                  : Timestamp;
}

// Privacy/GDPR
entity PrivacyProtectionActions {
  key ID                    : Integer;
  userUuid                  : String(36);
  actionType                : String(50);
  requestedAt               : Timestamp;
  completedAt               : Timestamp;
  status                    : String(50);
}

// Featured tasks ordering
entity FeaturedTasks {
  key ID                    : Integer;
  taskId                    : Integer;
  taskType                  : String(20);
  featuredOrder             : Integer;
}
```

## Service Layer

### DeveloperService (Frontend-facing)

Scope: `DeveloperApp`

Serves the tutorials-poc frontend and provides backward-compatible endpoints for existing IMS consumers.

**Path strategy**: The VitePress dev proxy sends `/api/*` to `localhost:4004`. CAP serves at root, so we use `@path: '/'` and prefix endpoints with `/api` in the custom handler. In production, the AppRouter routes `/api/*` to the CAP service with path rewriting.

```cds
@path: '/api'
@requires: 'DeveloperApp'
service DeveloperService {
  entity TaskRecords as projection on ims.TaskRecords;

  // tutorials-poc frontend endpoints (slug-based)
  action completeStep(slug: String, stepNumber: Integer) returns {
    completedSteps: array of Integer; points: Integer;
  };
  function getProgress(slug: String) returns {
    completedSteps: array of Integer; points: Integer;
    badges: many { name: String; icon: String; };
  };

  // IMS-compatible endpoints (ID-based)
  action createTaskRecord(taskId: Integer, taskType: String, eventId: Integer) returns TaskRecords;
  function findTaskProgressByUserAndTasksIds(userId: Integer, taskIds: array of Integer) returns many TaskRecords;
  function countCompletedMissionsTotal(userId: Integer) returns Integer;
  function countCompletedMissionsPercent(userId: Integer) returns Decimal;
}
```

### AdminService (Admin operations)

Scope: `Admin`

Full CRUD on all entities plus admin-only operations:

```cds
@path: '/admin'
@requires: 'Admin'
service AdminService {
  entity Users as projection on ims.Users;
  entity Tutorials as projection on ims.Tutorials;
  entity Missions as projection on ims.Missions;
  entity Groups as projection on ims.Groups;
  entity Events as projection on ims.Events;
  entity Prizes as projection on ims.Prizes;
  entity PrizeRecords as projection on ims.PrizeRecords;
  entity Tags as projection on ims.Tags;
  entity Accomplishments as projection on ims.Accomplishments;
  entity AccomplishmentRecords as projection on ims.AccomplishmentRecords;
  entity TaskRecords as projection on ims.TaskRecords;
  entity TutorialMeta as projection on ims.TutorialMeta;
  entity TutorialContributors as projection on ims.TutorialContributors;
  entity TutorialRepositories as projection on ims.TutorialRepositories;
  entity ImsConfig as projection on ims.ImsConfig;
  entity StepFailures as projection on ims.StepFailures;
  entity NGDSFailedMessages as projection on ims.NGDSFailedMessages;
  entity DeveloperEnvironmentTabs as projection on ims.DeveloperEnvironmentTabs;
  entity FeaturedTasks as projection on ims.FeaturedTasks;
  entity PrimaryAccounts as projection on ims.PrimaryAccounts;
  entity SecondaryAccounts as projection on ims.SecondaryAccounts;
  entity PrivacyProtectionActions as projection on ims.PrivacyProtectionActions;
  entity ActiveLearnerRecords as projection on ims.ActiveLearnerRecords;

  // Admin actions
  action anonymizeUser(uuid: String);
  action anonymizeByDsrRequest(requestId: String);
  action sendToNgds(taskRecordId: Integer);
  action cleanupStepFailures();
  action cleanupUnusedTags();
  action syncTutorialMetadata();
  action setFeaturedOrder(taskId: Integer, taskType: String, order: Integer);
  action sendContributorNotifications();

  // Statistics & export
  function getEventStatistics(eventId: Integer) returns {
    totalCompletions: Integer; uniqueLearners: Integer;
    completionRate: Decimal; activeTutorials: Integer;
  };
  function getEventBurnup(eventId: Integer) returns many {
    date: Date; completions: Integer; cumulative: Integer;
  };
  function getEventTrackStats(eventId: Integer) returns many {
    trackName: String; completions: Integer; learners: Integer;
  };
  function getCompletionSpeed(eventId: Integer) returns many {
    tutorialTitle: String; avgMinutes: Decimal; completions: Integer;
  };
  function exportTaskRecords(eventId: Integer, format: String) returns LargeString;
  function exportAwardMissions(eventId: Integer) returns LargeString;
  function getAccountMergeStatus(uuid: String) returns {
    primaryUuid: String; status: String; mergedAt: Timestamp;
    secondaryCount: Integer;
  };
  function findByAccountNumber(accountNumber: String) returns many TaskRecords;
}
```

### DisplayService (Dashboard)

Scope: `DisplayApp`

Read-only event dashboard with real-time updates:

```cds
@path: '/display'
@requires: 'DisplayApp'
service DisplayService {
  @readonly entity Events as projection on ims.Events;
  @readonly entity DashboardMonitoredRecords as projection on ims.DashboardMonitoredRecords;

  function getEventBuckets(eventId: Integer) returns many {
    bucketName: String; count: Integer; percentage: Decimal;
  };
  function getEventBurnup(eventId: Integer) returns many {
    date: Date; completions: Integer; cumulative: Integer;
  };
  function getEventTrackStats(eventId: Integer) returns many {
    trackName: String; completions: Integer; learners: Integer;
  };
  function getCompletionSpeed(eventId: Integer) returns many {
    tutorialTitle: String; avgMinutes: Decimal; completions: Integer;
  };
  function getLeaderboard(eventId: Integer, top: Integer) returns many {
    userId: Integer; displayName: String; completions: Integer; points: Integer;
  };
}
```

### ConsolidationService (Account Merge — SCI-triggered)

Scope: `ConsolidationScope` (separate from Admin)

```cds
@path: '/api/v1'
@requires: 'ConsolidationScope'
service ConsolidationService {
  action userMerge(uuid: String);
  function getMergeStatus(uuid: String) returns {
    primaryUuid: String; status: String; mergedAt: Timestamp;
  };
}
```

## WebSocket Strategy

### The Problem

The existing `display-ui/` frontend uses STOMP-over-WebSocket (via SockJS) subscribing to `/topic/events/{eventId}/tutorials`. The `@cap-js/websocket` plugin supports only native WebSocket and Socket.IO — no STOMP, no SockJS.

### Decision

During parallel operation, the display WebSocket remains served by the existing Java IMS `display-application` module. The CAP rewrite implements a STOMP-compatible WebSocket adapter using `stompjs` server-side (custom Express middleware on the CAP server). This is phased:

1. **Phase 1 (parallel)**: Display module stays on Java IMS. CAP has no WebSocket.
2. **Phase 2 (post-cutover)**: Implement STOMP adapter in `srv/middleware/websocket.js` using the `ws` package + a minimal STOMP frame parser. The display-ui connects to the CAP server.
3. **Phase 3 (UI rewrite)**: When display-ui is rewritten, switch to `@cap-js/websocket` or Socket.IO. Drop STOMP compatibility.

The middleware registers via `cds.on('bootstrap')` and shares the HTTP server:

```js
// srv/middleware/websocket.js
const { WebSocketServer } = require('ws');
const { parseStompFrame, buildStompFrame } = require('./stomp-parser');

module.exports = (app, server) => {
  const wss = new WebSocketServer({ server, path: '/display/websocket' });
  // Handle STOMP CONNECT, SUBSCRIBE, publish to /topic/events/{id}/tutorials
};
```

## Custom Handler Architecture

### Event-Driven Status Calculation

Maps Java's `TaskRecordEventListener` + `TaskStatusCalculator` hierarchy:

```js
// srv/developer-service.js
module.exports = class DeveloperService extends cds.ApplicationService {
  async init() {
    this.after('CREATE', 'TaskRecords', async (data, req) => {
      // 1. Recalculate parent status (step → tutorial → group → mission)
      await this.calculateParentStatus(data);
      // 2. Fire analytics (NGDS + Adobe)
      await this.sendAnalytics(data);
      // 3. Evaluate accomplishments
      await this.evaluateAccomplishments(data);
      // 4. Store title snapshot
      data.titleSnapshot = await this.getTaskTitle(data.taskId, data.taskType);
    });
  }
}
```

### Integration Clients

| Client | Java Equivalent | CAP Implementation |
|--------|----------------|-------------------|
| `ngds-client.js` | `NGDSSenderServiceImpl` | `@sap-cloud-sdk/http-client` via BTP Destination |
| `sci-client.js` | `DestinationServiceImpl` (SCI) | `@sap-cloud-sdk/http-client` via BTP Destination |
| `adobe-analytics.js` | `AdobeAnalyticsSenderServiceImpl` | Direct `fetch()` to `sap.d1.sc.omtrdc.net` |
| `tutorial-sync.js` | AEM HTTP calls | Reads from this project's GitHub fetch pipeline |

### Scheduled Jobs

#### Single-Instance Enforcement

CAP on Cloud Foundry may run multiple instances. Jobs must execute exactly once per interval. Strategy: **database-based distributed lock** via the `JobLocks` entity.

Before executing, each job attempts to acquire a lock (upsert pattern to handle first-run):

```js
// srv/jobs/job-lock.js
async function acquireLock(jobName, instanceId, durationMs) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  // Try INSERT first (handles first-ever run for this jobName)
  try {
    await INSERT.into(JobLocks).entries({
      jobName, lockedBy: instanceId, lockedAt: now, expiresAt
    });
    return true; // Lock acquired (new row)
  } catch (e) {
    // Unique constraint violation = row already exists, try UPDATE on expired
  }

  // UPDATE only if existing lock has expired
  const result = await UPDATE(JobLocks)
    .where({ jobName, expiresAt: { '<': now } })
    .set({ lockedBy: instanceId, lockedAt: now, expiresAt });
  return result > 0; // true if lock acquired (expired row updated)
}
```

#### Job Schedule

| Job | Java Equivalent | Schedule | Lock Duration |
|-----|-----------------|----------|---------------|
| Cleanup step failures | `ScheduledCleanupServiceImpl` | Daily 00:00 | 1 hour |
| Tag cleanup | `TagsCleanUpScheduler` | Jan 2, Jul 2 | 1 hour |
| Active learner analytics | `ActiveLearnerAnalyticsService` | Daily 00:00 | 30 min |
| Account merge batch | `AccountMergeScheduler` | Daily 00:00 | 2 hours |
| NGDS retry | `NGDSRetryService` | Every 2 hours | 30 min |
| Tutorial metadata review | `TutorialMetaReviewedScheduler` | Weekly Sun 02:00 | 1 hour |
| Contributor notifications | `TutorialContributorsNotificationScheduler` | Weekly Mon 09:00 | 30 min |

Jobs register in a bootstrap handler:

```js
// srv/jobs/scheduler.js
const cron = require('node-cron');
const { acquireLock } = require('./job-lock');

module.exports = (srv) => {
  const instanceId = process.env.CF_INSTANCE_INDEX || '0';

  cron.schedule('0 0 * * *', async () => {
    if (await acquireLock('cleanup-step-failures', instanceId, 3600000)) {
      await cleanup.stepFailures();
    }
  });

  cron.schedule('0 */2 * * *', async () => {
    if (await acquireLock('ngds-retry', instanceId, 1800000)) {
      await ngds.retryFailed();
    }
  });
  // etc.
}
```

## Deployment & Parallel Operation

### Updated MTA

```yaml
_schema-version: "3.1"
ID: tutorials
version: 1.0.0

modules:
  - name: tutorials-srv
    type: nodejs
    path: gen/srv
    parameters:
      memory: 1024M
      disk-quota: 1024M
      buildpack: nodejs_buildpack
      instances: 1  # Single instance during initial deployment; scale after lock mechanism verified
    build-parameters:
      builder: npm
    requires:
      - name: tutorials-hana
      - name: tutorials-xsuaa
      - name: tutorials-destination
    provides:
      - name: srv-api
        properties:
          srv-url: ${default-url}

  - name: tutorials-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: tutorials-hana

  - name: tutorials-approuter
    type: approuter.njs
    path: approuter
    parameters:
      memory: 512M
      disk-quota: 2048M
    requires:
      - name: tutorials-xsuaa
      - name: srv-api
        group: destinations
        properties:
          name: srv-api
          url: ~{srv-url}
          forwardAuthToken: true

resources:
  - name: tutorials-hana
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared

  - name: tutorials-xsuaa
    type: org.cloudfoundry.existing-service
    parameters:
      service-name: xsuaa-imsdev

  - name: tutorials-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
```

### Parallel Operation

During migration both systems run:

1. **Same XSUAA**: JWT tokens from the shared XSUAA instance are valid against both Java IMS and CAP rewrite
2. **Routing control**: AppRouter `xs-app.json` can route specific paths to either system (old IMS via external destination, new CAP via `srv-api`)
3. **Data isolation**: Separate HDI container — no risk of data corruption
4. **Comparison testing**: Script makes identical API calls to both, diffs responses
5. **Display module**: Remains served by the Java IMS during parallel operation (STOMP WebSocket)

### Cutover Plan

1. Deploy CAP alongside existing IMS (both running)
2. Migrate reference data (tutorials, events, tags, accomplishments)
3. Run parallel comparison tests
4. **Migrate user progress data** (while old system still active, dual-write new completions to both)
5. **Switch AppRouter routes** from old IMS destination to new CAP `srv-api`
6. Verify all endpoints work, run full regression
7. Activate STOMP WebSocket on CAP (Phase 2)
8. Decommission Java IMS

Note: Steps 4-5 are ordered so that user progress is already in the new system before traffic switches. During step 4, a dual-write middleware sends new task completions to both systems to prevent data gaps.

## Local Hybrid Testing

### Setup

```bash
# Login to CF
cf login -a https://api.cf.us30.hana.ondemand.com

# Bind to remote services
cds bind -2 xsuaa-imsdev           # Shared XSUAA
cds bind -2 tutorials-hana         # HDI container (after first deploy)
cds bind -2 tutorials-destination  # Destination service

# Run with real remote services
cds watch --profile hybrid
```

### What This Gives You

- **Real JWT validation**: Tokens from XSUAA are validated against the actual JWKS endpoint
- **Real HANA queries**: CQL queries execute against the deployed HDI container
- **Real Destination routing**: NGDS/SCI calls go through BTP Destination service with proper auth
- **Hot reload**: File changes restart the service immediately
- **Full security testing**: Test scope-based access control with real tokens

### Development Profiles

| Profile | DB | Auth | Integrations | Use Case |
|---------|-----|------|-------------|----------|
| (default) | SQLite in-memory | Mocked | Mocked | Fast unit dev |
| `hybrid` | Remote HANA | Remote XSUAA | Remote Destinations | Integration testing |
| `production` | HDI container | XSUAA | Destinations | CF deployment |

Configuration in `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sqlite",
        "[hybrid]": { "kind": "hana" },
        "[production]": { "kind": "hana" }
      },
      "auth": {
        "kind": "mocked",
        "[hybrid]": { "kind": "xsuaa" },
        "[production]": { "kind": "xsuaa" }
      }
    }
  }
}
```

### VitePress Dev Proxy Integration

The existing VitePress config proxies `/api/*` → `localhost:4004`. CAP serves at `localhost:4004` by default. With `@path: '/api'` on DeveloperService, the full path from the browser is `/api/completeStep` which the Vite proxy forwards as-is to `localhost:4004/api/completeStep`. This works correctly — no path rewriting needed.

In production, the AppRouter `xs-app.json` routes `/api/(.*)` to the `srv-api` destination which resolves to the CAP service URL. The CAP service receives `/api/completeStep` and matches it to `DeveloperService`.

## Security Model

### XSUAA Scopes (existing, shared)

| Scope | CAP Annotation | Purpose |
|-------|---------------|---------|
| `Admin` | `@requires: 'Admin'` | Full admin access |
| `ContentAuthor` | `@requires: 'ContentAuthor'` | Create/edit content |
| `DeveloperApp` | `@requires: 'DeveloperApp'` | Frontend progress tracking |
| `MobileApp` | `@requires: 'MobileApp'` | Mobile app features |
| `DisplayApp` | `@requires: 'DisplayApp'` | Read-only dashboard |
| `ConsolidationScope` | `@requires: 'ConsolidationScope'` | Account merge (SCI-triggered) |
| `Everyone` | `@requires: 'authenticated-user'` | Baseline access |

### Service-to-Service Authentication (Tech Users)

The Java app uses HTTP Basic Auth for tech users (scheduled jobs calling the API). This pattern is architecturally unsound in CAP because CAP's XSUAA middleware rejects non-JWT requests before custom middleware runs.

**CAP approach**: Use XSUAA client credentials grant. The calling service (or job) obtains a JWT via client credentials flow using the shared XSUAA instance's client ID/secret. This JWT contains the required scopes and is validated by CAP's standard auth middleware.

For local development with mocked auth, the mocked user configuration in `.cdsrc.json` provides the same scopes without needing actual tokens.

## AEM Replacement Strategy

The Java app calls AEM for tutorial content metadata. In the CAP rewrite:

1. **Source of truth**: The `sap-tutorials` GitHub organization (already fetched by this project)
2. **Sync mechanism**: `srv/lib/tutorial-sync.js` reads from the VitePress build pipeline output (`site/tutorials/_nav.json`) or directly from GitHub API
3. **Storage**: Tutorial/Step/Tag entities in the HDI container
4. **Trigger**: Admin action `syncTutorialMetadata()` or automatic on `cds.on('served')`
5. **Slug mapping**: The `Tutorials.slug` field (e.g., `cp100-1-setup-btp-account`) is populated from GitHub repo names and matched against frontend requests

This eliminates the AEM dependency entirely while maintaining the same data available to consumers.

## Testing Strategy

1. **Unit tests** (Vitest): Service handler logic with mocked DB
2. **Integration tests** (`cds.test()`): Full request/response testing with SQLite
3. **Hybrid tests**: Manual testing against real HANA/XSUAA via `cds watch --profile hybrid`
4. **Parallel comparison**: Automated script comparing old IMS vs new CAP responses
5. **Existing frontend tests**: The tutorials-poc frontend already calls `/api/*` — just point it at the CAP service

## Data Migration

### Approach

- **Schema**: CDS → HDI deployer (no Liquibase). `.hdbsequence` files for integer key generation.
- **Reference data**: REST-based migration script reads from old IMS API, writes to new CAP API
- **User progress**: Migrated before route cutover (step 4 in cutover plan). Dual-write during transition window.
- **Sequences**: HANA sequences start at offset 10,000,000. Migrated records retain original IDs (all < 10M).

### Migration Script Design

```typescript
// scripts/migrate-from-ims.ts
// 1. Authenticate against old IMS (admin JWT from shared XSUAA)
// 2. Authenticate against new CAP (same JWT)
// 3. For each entity type (tutorials, events, tags, etc.):
//    a. Paginate through old IMS API (page size 500)
//    b. Transform to CAP format (field mapping)
//    c. Batch-insert via CAP API (POST with array)
//    d. Verify count matches
// 4. For user progress (large dataset):
//    a. Stream via cursor-based pagination
//    b. Write in batches of 1000
//    c. Track progress in a checkpoint file for resume capability
//    d. Verify total count + sample spot checks
// 5. Output: summary report with counts per entity, any failures
```

The script is idempotent — re-running it skips already-migrated records (checked by ID existence).

## Out of Scope (Deferred)

- Frontend UI rewrite (existing React 15 admin UI, display UI)
- Fiori Elements integration (not needed — custom Vue frontend)
- Multi-tenancy (IMS is dedicated tenant mode)
- CAP Java (explicitly Node.js only per project requirements)
- WebSocket STOMP adapter (Phase 2, after initial cutover)
