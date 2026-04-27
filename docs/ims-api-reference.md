# IMS API Reference

> Information Management System — the backend for developers.sap.com tutorial progress tracking.
> Source: `D:\projects\com.sap.developers.ims`

## Overview

IMS is a **Spring Boot 2.5.7** (Java 17) application deployed on SAP BTP Cloud Foundry. It uses **Spring Data REST** (HATEOAS/HAL) to auto-expose JPA repositories as REST endpoints, plus custom `@RepositoryRestController` classes for business logic. Data is stored in **SAP HANA Cloud** (H2 for tests).

### Technology Stack

| Layer | Technology |
|---|---|
| Framework | Spring Boot 2.5.7, Spring Data REST |
| Language | Java 17 (SAP Machine JDK) |
| Database | SAP HANA Cloud (Liquibase migrations) |
| Auth | OAuth2 Resource Server, XSUAA JWT |
| Build | Maven multi-module, WAR packaging |
| Deployment | Cloud Foundry (manifest-based) |
| API Format | HAL+JSON (HATEOAS) |

### Module Structure

```
com.sap.developers.ims/
├── application/       # Core REST API, JPA entities, services, repositories
├── job/               # Spring Batch jobs (analytics, account merge, cleanup)
├── display-application/ # WebSocket-based real-time event displays
├── ui/                # Legacy React 15 admin frontend
├── display-ui/        # Pre-built display frontend
├── web/               # WAR packaging (combines all modules)
└── approuter/         # Node.js SAP Application Router (XSUAA auth)
```

### Domain Model Hierarchy

```
Group
  └── Mission
        └── Tutorial
              ├── Step
              └── Checkpoint
```

All four task types extend a common `Task` base entity with `id`, `title`, `status`, and `taskType` discriminator. `TaskRecord` tracks a user's completion status for any task.

---

## Authentication & Authorization

### Security Model

- **OAuth2 Resource Server** with JWT tokens via SAP XSUAA
- Basic Auth bypass available for technical users (local dev)
- Public endpoints: `/actuator/health`, `/actuator/info`, `/public/**`

### Roles

| Role Constant | Scope | Description |
|---|---|---|
| `ADMIN` | `SCOPE_Admin` | Full access to all endpoints |
| `DEVELOPER_APP` | `SCOPE_Developer` | AEM/frontend application calls |
| `MOBILE_APP` | `SCOPE_Mobile` | Mobile app calls |
| `DISPLAY_APP` | `SCOPE_Display` | Event display dashboard |
| `CONTENT_AUTHOR` | `SCOPE_ContentAuthor` | Tutorial metadata management |
| `CONSOLIDATION_SCOPE` | (custom) | Account merge operations |

---

## API Endpoints

### Tutorials

Base path: `/tutorials`

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/tutorials` | ADMIN, DEVELOPER_APP | `Pageable` | `CollectionModel<Tutorial>` | List all tutorials (paginated) |
| POST | `/tutorials` | ADMIN, DEVELOPER_APP | `EntityModel<Tutorial>` body | `ResponseEntity` | Create or update tutorial (synchronized) |
| GET | `/tutorials/{id}` | ADMIN, DEVELOPER_APP | — | `EntityModel<Tutorial>` | Get tutorial by ID (Spring Data REST) |
| GET | `/tutorials/{id}/steps/search` | ADMIN, DEVELOPER_APP | `title` (query) | `EntityModel<Step>` | Find step by title within tutorial |
| GET | `/tutorials/search/findByText` | ADMIN | `text`, `Pageable` | `CollectionModel` | Full-text search tutorials |
| GET | `/tutorials/findByTitle` | ADMIN, DEVELOPER_APP, MOBILE_APP | `tutorialTitle` (query) | `ResponseEntity` | Find tutorial by exact title |

**Tutorial Entity Fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | Long | Primary key |
| `title` | String | Inherited from Task |
| `status` | String | null = active, "DELETED" = soft-deleted |
| `mdFileUrl` | String | Markdown source file URL (required) |
| `primaryTag` | Tag | Many-to-one |
| `experienceTag` | Tag | Many-to-one (Beginner/Intermediate/Advanced) |
| `averageTimeToComplete` | Long | Minutes |
| `steps` | List\<Step\> | Ordered one-to-many via join table |
| `tags` | Set\<Tag\> | Many-to-many |
| `featuredOrder` | Integer | Homepage featured position |

---

### Missions

Base path: `/missions`

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/missions` | ADMIN, DEVELOPER_APP | `Pageable` | `CollectionModel<Mission>` | List all missions (paginated) |
| GET | `/missions/{missionId}/completion-graph` | ADMIN, DEVELOPER_APP, MOBILE_APP | `missionId` (path), `userId` (query) | `EntityModel<CompletionGraph>` | Get mission completion graph for user |
| GET | `/missions/{missionId}/export` | ADMIN, DEVELOPER_APP | `missionId` (path) | `EntityModel<MissionDTO>` | Export full mission data |
| GET | `/missions/search/findByText` | ADMIN | `text`, `Pageable` | `CollectionModel` | Full-text search missions |
| DELETE | `/missions/{id}` | ADMIN, DEVELOPER_APP | `id` (path), `deletionReason` (optional query) | void | Soft-delete mission |

**Mission Entity Fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | Long | Primary key |
| `title` | String | Inherited from Task |
| `description` | String (LOB) | Rich description |
| `paths` | List\<CompletionPath\> | Ordered groups within mission |
| `event` | Event | Many-to-one (optional event association) |
| `communityMissionId` | String | External ID for SAP Community |
| `taskValidationRule` | TaskValidationRule | Embedded completion rules |
| `averageTimeToComplete` | Long | Minutes |
| `primaryTag` | Tag | Many-to-one |
| `experienceTag` | Tag | Many-to-one |
| `tags` | Set\<Tag\> | Many-to-many |
| `featuredOrder` | Integer | Homepage featured position |

---

### Groups

Base path: `/groups`

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/groups` | ADMIN, DEVELOPER_APP | `Pageable` | `CollectionModel<Group>` | List all groups (paginated) |
| GET | `/groups/{groupId}/export` | ADMIN, DEVELOPER_APP | `groupId` (path) | `EntityModel<GroupDTO>` | Export full group data |
| GET | `/groups/search/findByText` | ADMIN | `text`, `Pageable` | `CollectionModel` | Full-text search groups |
| DELETE | `/groups/{id}` | ADMIN, DEVELOPER_APP | `id` (path), `deletionReason` (optional) | void | Soft-delete group |

**Group Entity Fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | Long | Primary key |
| `title` | String | Inherited from Task |
| `description` | String (LOB) | Rich description |
| `tutorials` | List\<Tutorial\> | Ordered one-to-many via join table |
| `primaryTag`, `experienceTag` | Tag | Many-to-one |
| `tags` | Set\<Tag\> | Many-to-many |
| `averageTimeToComplete` | Long | Minutes |
| `featuredOrder` | Integer | Homepage featured position |

---

### Task Records (Progress Tracking)

Base path: `/task-records`

This is the **core progress-tracking entity** — one record per user per task, recording completion status.

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| POST | `/task-records` | ADMIN, DEVELOPER_APP, MOBILE_APP | `EntityModel<TaskRecord>` body | `ResponseEntity` | Record task completion |
| GET | `/task-records/search/byUserAndTask` | (Spring Data REST) | `userId`, `taskId` | `TaskRecord` | Find record for specific user+task |
| GET | `/task-records/search/byUserAndTasks` | (Spring Data REST) | `userId`, `taskId...` | `List<TaskRecord>` | Find records for user + multiple tasks |
| GET | `/task-records/search/findTaskProgressByUserAndTasksIds` | ADMIN, DEVELOPER_APP | `userImsId`, `tasksIds` (Set), `tutorialId` | `List<UserProgressWithTutorialSteps>` | Detailed progress with step-level info |
| GET | `/task-records/search/countCompletedMissionsTotalById` | ADMIN | `missionId` | Count | Total users who completed mission |
| GET | `/task-records/search/countCompletedMissionsPercentById` | ADMIN | `missionId` | Percentage | Completion percentage |
| GET | `/task-records/search/findByAccountNumber` | ADMIN | `accountNumber`, `petNumber`, `dsrRequestNumber`, `Pageable` | `PagedModel` | Find by account (admin/GDPR) |
| GET | `/task-records/download/{fileName}.csv` | ADMIN | `accountNumber`, `petNumber`, `dsrRequestNumber` | CSV stream | Export records as CSV |
| GET | `/task-records/sendToNgds` | ADMIN, DEVELOPER_APP | `tasksId` | `Boolean` | Push record to NGDS analytics |

**TaskRecord Entity Fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | Long | Primary key |
| `user` | User | Many-to-one |
| `task` | Task | Many-to-one |
| `event` | Event | Many-to-one (optional) |
| `title` | String | Snapshot of task title |
| `status` | TaskRecordStatus | IN_PROGRESS, COMPLETED, etc. |
| `progress` | Integer | 0–100 |
| `progressNote` | String | Status notes |
| `completionTime` | Long | Time spent (seconds) |
| `completionDate` | LocalDateTime | When completed |
| `taskType` | TaskType | TUTORIAL, MISSION, GROUP, STEP |

**Event-driven cascading:** When a TaskRecord is saved, Spring application events trigger status recalculation up the hierarchy (Tutorial → Group → Mission) via `TutorialStatusCalculator`, `GroupStatusCalculator`, `MissionStatusCalculator`.

---

### Users

Base path: `/users`

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/users/resolve` | ADMIN, DEVELOPER_APP | `accountNumber` (query) | `PersistentEntityResource` | Resolve user by SAP account number |
| GET | `/users/{userId}/search/findUserProgress` | ADMIN, DEVELOPER_APP | `userId` (path) | `UserProgressModel` | Get user's overall progress summary |
| GET | `/users/anonymize` | ADMIN | `accountNumber` (query) | — | GDPR anonymization |
| GET | `/users/anonymizeByDsrRequest` | ADMIN | DSR request params | — | GDPR anonymization by DSR |

**User Entity Fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | Long | Primary key (= IMS ID) |
| `uuid` | String | Unique, immutable |
| `sapId` | String | SAP ID |
| `taskRecords` | List\<TaskRecord\> | One-to-many (sub-resource: `/users/{id}/task-records`) |
| `prizeRecords` | List\<PrizeRecord\> | One-to-many (sub-resource: `/users/{id}/prize-records`) |
| `accomplishments` | List\<AccomplishmentRecord\> | One-to-many |
| `profile` | Profile | Embedded |

**Projections:**
- `?projection=leaderBoardRankings` — includes `uuid`, `sapId`, `profile`, `accomplishments`, computed `leaderBoardRankings`

---

### Prizes & Prize Records

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/prizes` | (Spring Data REST) | `Pageable` | `CollectionModel<Prize>` | List prizes |
| DELETE | `/prizes/{prizeId}` | ADMIN | `prizeId` (path) | `ResponseEntity` | Delete prize |
| GET | `/prizes/search/findByText` | ADMIN | `text`, `Pageable` | `CollectionModel` | Search prizes |
| PATCH | `/prize-records/{id}` | ADMIN, DEVELOPER_APP, MOBILE_APP | `EntityModel<PrizeRecord>` body | `EntityModel<PrizeRecord>` | Update prize record status |
| GET | `/prize-records/findByUserAndPrizeIds` | ADMIN, DEVELOPER_APP | `userId`, `prizeIds` (List) | `List<PrizeRecordWithStatus>` | Get prize records for user |

---

### Accomplishments

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/accomplishments` | ADMIN, DEVELOPER_APP | `Pageable` | `CollectionModel<Accomplishment>` | List accomplishments |
| GET | `/accomplishments/search/findByText` | ADMIN | `text`, `Pageable` | `CollectionModel` | Search accomplishments |

---

### Events

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/events` | (Spring Data REST) | `Pageable` | `CollectionModel<Event>` | List events |
| DELETE | `/events/{eventId}` | ADMIN | `eventId` (path) | `ResponseEntity` | Delete event |
| GET | `/events/search/findByText` | ADMIN | `text`, `Pageable` | `CollectionModel` | Search events |

**Event Entity Fields:** `id`, `name` (required), `startDate`, `endDate`, `timeZone`

---

### Statistics

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/statistic` | ADMIN, DEVELOPER_APP, MOBILE_APP | — | `OverallStatistic` | Overall platform statistics |
| GET | `/eventStatistic` | ADMIN, DISPLAY_APP, MOBILE_APP | `eventId` | `EventStatistic` | Event-specific statistics |
| GET | `/tutorialComplBurnupByDay` | ADMIN, DISPLAY_APP | `eventId` | `List<TaskCountByDateModel>` | Completion burnup chart data |
| GET | `/tutorialComplStatsByTrack` | ADMIN, DISPLAY_APP | `eventId` | `EventStatisticWrapper` | Completion stats by learning track |
| GET | `/tutorialComplSpeed` | ADMIN, DISPLAY_APP | `eventId`, `period` | `Long` | Completion speed metric |
| GET | `/statistic/events/{eventId}/buckets` | ADMIN, DISPLAY_APP | `eventId` (path) | Bucket data | Event bucket/tier breakdown |

---

### Tutorial Metadata

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/tutorialMeta` | ADMIN, CONTENT_AUTHOR | `Pageable` | `CollectionModel` | List tutorial metadata |
| POST | `/tutorialMeta` | ADMIN, DEVELOPER_APP, CONTENT_AUTHOR | `TutorialMetaResource` body | `ResponseEntity` | Create metadata (synchronized) |
| PATCH | `/tutorialMeta` | ADMIN, DEVELOPER_APP, CONTENT_AUTHOR | `TutorialMetaResource` body | `ResponseEntity` | Update metadata (synchronized) |
| DELETE | `/tutorialMeta/{tutorialId}` | ADMIN, DEVELOPER_APP, CONTENT_AUTHOR | `tutorialId` (path) | void | Delete metadata |
| POST | `/tutorialMeta/search` | ADMIN, CONTENT_AUTHOR | `TutorialMetaSortParams` body, `Pageable` | `CollectionModel` | Search with custom sort |
| GET | `/tutorialMeta/tags` | ADMIN, CONTENT_AUTHOR, DEVELOPER_APP | `Pageable` | `CollectionModel` | Get metadata tags |
| POST | `/tutorialMeta/setMonitoredStatus` | ADMIN, CONTENT_AUTHOR | `status` (query), `List<Long>` body | `ResponseEntity` | Bulk set monitored flag |
| POST | `/tutorialMeta/setReviewedStatus` | ADMIN, CONTENT_AUTHOR | `status`, `id` (query) | `ResponseEntity` | Set reviewed flag |
| GET | `/tutorialMeta/infographics` | ADMIN, CONTENT_AUTHOR | — | `TutorialMetaInfographics` | Metadata dashboard stats |

---

### Tags

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/tags/search/findByText` | ADMIN, CONTENT_AUTHOR, DEVELOPER_APP | `text`, `Pageable` | `CollectionModel` | Search tags |
| POST | `/tags/updateDevelopersTags` | ADMIN, CONTENT_AUTHOR, DEVELOPER_APP | `Map<String, Boolean>` body | `ResponseEntity` | Bulk update tags |
| DELETE | `/tags/deleteUnusedTags` | ADMIN, CONTENT_AUTHOR, DEVELOPER_APP | — | void | Clean up unused tags |
| POST | `/tags/interestItems` | ADMIN, CONTENT_AUTHOR, DEVELOPER_APP | `List<String>` body | `ResponseEntity` | Update items of interest |

---

### Featured Tasks

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/findAllFeaturedTasks` | ADMIN, DEVELOPER_APP | — | List | Get all featured tasks |
| GET | `/getAllFeaturedIdsList` | ADMIN, DEVELOPER_APP | — | List\<Long\> | Featured task IDs |
| GET | `/getAllFeaturedIdsMap` | ADMIN, DEVELOPER_APP | — | Map\<Long, Integer\> | Featured IDs with order |
| POST | `/setFeaturedOrder/{ids}` | ADMIN | `ids` (path, comma-separated) | — | Mark tasks as featured |
| DELETE | `/deleteFeaturedOrder/{ids}` | ADMIN | `ids` (path, comma-separated) | — | Unmark featured tasks |

---

### Utility Endpoints

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/tasks/findRelated` | ADMIN, DEVELOPER_APP, MOBILE_APP | `tutorialId` or `tutorialTitle` | `ResponseEntity` | Find parent mission/group for a tutorial |
| GET | `/__debug/headers` | Authenticated | — | Request headers | Debug helper |
| GET | `/__debug/principal` | Authenticated | — | Principal info | Auth debug |
| GET | `/application/configuration` | ADMIN | — | `List<ApplicationConfiguration>` | App config entries |

---

### Account Merge

Base path: `/api/v1/user-merge`

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| POST | `/api/v1/user-merge/{uuid}` | CONSOLIDATION_SCOPE | `AccountMergeRequest` body | `ResponseEntity` | Register secondary accounts |
| POST | `/api/v1/user-merge/{uuid}/{sapID}/{target}` | CONSOLIDATION_SCOPE | Path vars | `ResponseEntity` | Trigger account merge |
| GET | `/api/v1/user-merge/status` | CONSOLIDATION_SCOPE | Optional path vars | `ResponseEntity` | Check merge status |

---

### Tutorial Repositories

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/tutorialRepository/sortedRepositories` | ADMIN, CONTENT_AUTHOR | `Pageable` | `CollectionModel` | List GitHub repos sorted |
| PATCH | `/tutorialRepository/updateTutorialRepositoryOwner/{repositoryName}` | ADMIN, DEVELOPER_APP | `TutorialContributorDTO` body | `ResponseEntity<RepositoryModel>` | Update repo owner |

---

### Developer Environment Tabs

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/developerEnvironmentTabs/user/{userId}` | ADMIN, DEVELOPER_APP | `userId` (path) | `List<TabModel>` | Get user's environment tabs |
| POST | `/developerEnvironmentTabs/user/{userId}` | ADMIN, DEVELOPER_APP | `TabModel` body | `TabModel` | Create new tab |
| PATCH | `.../user/{userId}/update` | ADMIN, DEVELOPER_APP | `TabModel` body | `TabModel` | Update tab |
| PATCH | `.../user/{userId}/reorder` | ADMIN, DEVELOPER_APP | `List<Long>` body (IDs) | `List<TabModel>` | Reorder tabs |
| DELETE | `.../user/{userId}/tab/{tabId}` | ADMIN, DEVELOPER_APP | Path vars | `ResponseEntity` | Delete tab |

---

### Notification System

| Method | Path | Auth | Parameters | Returns | Description |
|---|---|---|---|---|---|
| GET | `/getRecipientList` | ADMIN | — | Email list | Notification recipients |
| GET | `/sendNotification` | ADMIN | — | — | Send outdated tutorial alerts |
| GET | `/sendTutorialNotification` | ADMIN | Tutorial ID | — | Send notification for one tutorial |
| POST | `/updateRecipientList` | ADMIN | Updated list body | — | Update recipient emails |

---

## External Integrations

| System | Purpose | Transport |
|---|---|---|
| Adobe Analytics | Tutorial completion events | HTTPS to `sap.d1.sc.omtrdc.net` |
| NGDS | SAP internal tracking | BTP Destination Service |
| SCI | Cross-domain identity | BTP Destination Service |
| AEM | Content management (frontend) | AEM calls IMS as backend |
| Mail | Contributor notifications | `javax.mail` via destination |

---

## Spring Profiles

| Profile | Purpose |
|---|---|
| `cloud` | Cloud Foundry deployment (default) |
| `local` | Local dev (debug logging, analytics disabled) |
| `imstest` | Test environment |
| `imsprod` | Production |

---

## Key Source Locations

| What | Path |
|---|---|
| Controllers | `application/src/main/java/com/sap/developers/ims/controller/` |
| Repositories | `application/src/main/java/com/sap/developers/ims/repository/` |
| Models | `application/src/main/java/com/sap/developers/ims/model/` |
| Services | `application/src/main/java/com/sap/developers/ims/service/` |
| Configuration | `application/src/main/java/com/sap/developers/ims/configuration/` |
| DB Migrations | `application/src/main/resources/db/changelog/` |
| Security | `WebSecurityConfiguration.java`, `ServiceSecurityConfiguration.java` |
