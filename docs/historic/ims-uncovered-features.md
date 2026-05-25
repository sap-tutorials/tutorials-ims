# IMS Features Not Covered by tutorials-frontend POC

> Admin tools, real-time displays, batch jobs, and other IMS features that exist in the legacy system but are not yet part of the tutorials-frontend POC.

## Overview

The IMS application includes a legacy **React 15 admin frontend** (`ui/` module) with 11 distinct pages, a **WebSocket-based real-time display** (`display-application/` + `display-ui/` modules), and **Spring Batch jobs** (`job/` module). The tutorials-frontend POC currently covers only the learner-facing tutorial navigation, progress tracking, and App Space event view.

This document catalogs everything else.

---

## 1. Content Admin UI (Legacy React 15)

The admin UI is a full CRUD management interface for all IMS entities. It runs as part of the IMS WAR deployment and is accessed by content authors and administrators.

**Tech stack:** React 15, Redux, Redux-Saga, Webpack 2, HATEOAS/HAL client.

### 1.1 Tutorials Management (`/tutorials`)

**Type:** Read-only table (tutorials are created via AEM/GitHub, not the admin UI)

| Column | Source |
|---|---|
| Title | Linked to external tutorial page |
| Primary Tag | `primaryTag.name` |
| Experience | `experienceTag.name` |
| Time to Complete | Formatted hours/minutes |
| Deletion Reason | Soft-delete reason if applicable |

**API:** `GET /tutorials` with pagination, sorting, search, tag/repository filtering.

**POC gap:** The POC has no admin view of tutorials. Tutorial content is managed via GitHub repos, but there's no equivalent of this read-only overview table.

---

### 1.2 Groups Management (`/groups`, `/groups/new`, `/groups/:id/edit`)

**Type:** Full CRUD with table list + create/edit forms

**Create/Edit fields:**
- Title (required)
- Description
- Primary Tag (searchable dropdown, required)
- Tags (multi-select, required)
- Experience Tag (filtered dropdown, required)
- Tutorials (ordered multi-select — defines which tutorials belong to the group)
- Reset Update Date checkbox (edit only)

**API:** `GET/POST/PATCH/DELETE /groups`, with HATEOAS discovery for related `tags` and `tutorials`.

**POC gap:** No group management UI. The POC displays groups within missions but has no way to create, edit, or delete them.

---

### 1.3 Missions Management (`/missions`, `/missions/new`, `/missions/:id/edit`)

**Type:** Full CRUD with complex nested form

**Create/Edit fields:**
- Title, Description, Primary Tag, Tags, Experience Tag (same pattern as Groups)
- Community Mission ID (external SAP Community reference)
- Event association (optional dropdown — links mission to a timed event)
- **Mission Type** (radio): Sequential or Set
  - Sequential: multiple completion paths, full validation rules
  - Set: single path, simplified validation with completion criteria count
- **Completion Paths** (nested list):
  - Each path has: Title, Description
  - Each path contains ordered steps, each step has:
    - Type dropdown: Tutorial, Group, or Checkpoint
    - Tutorial/Group selector (conditional on type)
    - Prize selector (optional)

**API:** `GET/POST/PATCH/DELETE /missions`, with HATEOAS discovery for `tags`, `events`, `prizes`, `tutorials`, `groups`.

**POC gap:** No mission management UI. This is the most complex admin form — the nested completion-path editor with conditional step types is a significant piece of functionality.

---

### 1.4 Events Management (`/events`, `/events/new`, `/events/:id/edit`)

**Type:** Full CRUD

**Create/Edit fields:**
- Name (required)
- Start Date (datetime picker with timezone handling)
- End Date (datetime picker)
- Time Zone (dropdown with UTC offset display)

**API:** `GET/POST/PATCH/DELETE /events`

**POC gap:** No event management. The POC's App Space hardcodes `MISSION_ID = 24609` and `eventId=38`. There's no way to create or configure events.

---

### 1.5 Prizes Management (`/prizes`, `/prizes/new`, `/prizes/:id/edit`)

**Type:** Full CRUD (simple — name field only)

**API:** `GET/POST/PATCH/DELETE /prizes`

**POC gap:** No prize management. Prizes appear in App Space progress series responses but can't be created or edited.

---

### 1.6 Accomplishments Management (`/accomplishments`, `/accomplishments/new`, `/accomplishments/:id/edit`)

**Type:** Full CRUD

**Create/Edit fields:**
- Name (required)
- Description
- Rule (required textarea — SQL/business logic rule that defines when the accomplishment is awarded)

**API:** `GET/POST/PATCH/DELETE /accomplishments`

**POC gap:** No accomplishment/badge management. The `TutorialLayout.vue` displays badges from the progress response but there's no admin UI to define them.

---

### 1.7 Tags (`/tags`)

**Type:** Read-only table

| Column | Description |
|---|---|
| Title | Tag name |
| MD format | Markdown representation |
| Full path | Hierarchical tag path |

**API:** `GET /tags`

**POC gap:** No tag management view. Tags are used for filtering in the Tutorial Navigator but managed elsewhere.

---

### 1.8 Board / Analytics Dashboard (`/board`)

**Type:** Read-only dashboard with charts and KPI tiles

**Metrics displayed:**
- **Pie chart:** Tutorials up-to-date vs. requiring review (from `tutorialMeta/infographics`)
- **KPI tiles:**
  - Total users
  - Total tutorials
  - Total groups
  - Total missions
  - Average tutorial completion %
  - Average group completion %
  - Average mission completion %

**API:**
- `GET /statistic` — overall counts
- `GET /task-records/search/avgProgressByTaskType?taskType=TUTORIAL` (and GROUP, MISSION)
- `GET /tutorialMeta/infographics` — tutorial freshness counts

**POC gap:** No analytics dashboard at all.

---

### 1.9 Tutorial Dashboard (`/tutorialDashboard`)

**Type:** Advanced table with bulk actions — the primary content author tool

This is the **most operationally important admin page** — it's how content authors track tutorial freshness, ownership, and review status.

| Column | Description |
|---|---|
| Tutorial | Linked title |
| Owner | Contributor name |
| First Author | Creator name |
| Primary Tag | Category |
| Last Updated | Date |
| Last Reviewed | Date |
| Repository Owner | Name |
| Repository | Name |
| Monitored | Checkbox (bulk-toggleable) |
| Reviewed | Checkbox (individually toggleable) |
| Last Reminder Email | Notification stage info |

**Features:**
- **Monitored status toggle** — bulk action to mark tutorials as "monitored by me"
- **Reviewed status toggle** — mark individual tutorial as reviewed (resets the outdated timer)
- Filter by: tags, repository, "monitored by me", outdated status
- Sort by any column
- Search by text

**API:**
- `POST /tutorialMeta/search` — complex search with sort params
- `POST /tutorialMeta/setMonitoredStatus?status={bool}` — bulk update (body: list of IDs)
- `POST /tutorialMeta/setReviewedStatus?status={bool}&id={id}` — individual update
- `GET /tutorialMeta/tags?size=100000` — all tags for filtering
- `GET /tutorialRepository/sortedRepositories?size=100000` — all repos for filtering

**POC gap:** No tutorial metadata management. This is critical for content operations — without it, there's no way to track which tutorials need review or who owns them.

---

### 1.10 Statistics Export (`/statistics`)

**Type:** Form + CSV download

**Fields:**
- Start Date (required datetime)
- End Date (required datetime)
- Mission ID (optional, numeric)

**Output:** CSV file named `CONFIDENTIAL_DD_MMM_YYYY_DD_MMM_YYYY_MISSIONID`

**API:** `GET /awardMissions/download.csv?startDate={ts}&endDate={ts}&missionID={id}`

**POC gap:** No statistics export functionality.

---

### 1.11 Privacy Protection (`/privacy`)

**Type:** User lookup + data operations (GDPR compliance tool)

**Search form:**
- PET Number (required)
- DSR Request Number (required)
- User ID / C-Number (required)

**Operations:**
- **View history** — table of user's task records (date, type, title, time spent)
- **Download history** — export as CSV
- **Anonymize** — irreversibly remove user identity and anonymize progress data (with confirmation dialog)

**API:**
- `GET /task-records/search/findByAccountNumber?accountNumber={c}&petNumber={p}&dsrRequestNumber={d}`
- `GET /task-records/download/{filename}.csv?...`
- `GET /users/anonymize?accountNumber={c}`

**POC gap:** No GDPR/privacy tooling. This is a compliance requirement that will need to be addressed.

---

## 2. Real-Time Event Display (WebSocket)

The `display-application/` and `display-ui/` modules provide a **live dashboard** for events (e.g., SAP TechEd, Sapphire). It shows real-time tutorial completion updates grouped into "buckets" (categories by primary tag).

### Architecture

```
Tutorial completed
  → TaskRecord saved
    → Spring ApplicationEvent: AfterUpdateOrSaveTaskRecordEvent
      → BucketUpdateTaskRecordEventHandler
        → BucketUpdateClient.sendBucketUpdate()
          → STOMP message to /topic/events/{eventId}/tutorials
            → All WebSocket subscribers receive BucketUpdateMessage
```

### Endpoints

| Type | Path | Description |
|---|---|---|
| REST | `GET /statistic/events/{eventId}/buckets` | Initial bucket data (tag-grouped completion counts) |
| WebSocket | STOMP endpoint: `/display` (SockJS fallback) | Connection endpoint |
| WebSocket | Subscribe: `/topic/events/{eventId}/tutorials` | Real-time completion updates |

### Bucket Model

A "bucket" groups completed tutorials by their primary tag within an event's time window. The count is computed via native SQL in `BucketRepositoryImpl`:

```
SELECT tag, COUNT(completed tutorials)
FROM task_records
WHERE event_id = ? AND status = 'COMPLETED' AND task_type = 'TUTORIAL'
GROUP BY primary_tag
```

### Display UI

Separate React frontend (`display-ui/` module) — pre-built, read-only. Consumes WebSocket messages and renders live completion dashboards. Distinct from the admin UI.

**Auth:** WebSocket endpoint is public. REST bucket retrieval requires DisplayApp scope.

**POC gap:** The App Space component (`AppSpace.vue`) shows event progress but is **not real-time** — it fetches once on mount. There's no WebSocket integration for live updates.

---

## 3. Notification System (Outdated Tutorials)

Automated email notification system that alerts tutorial contributors when their tutorials become outdated (not reviewed within a configurable period).

### 4-Stage Escalation

| Stage | Recipients | Template |
|---|---|---|
| 0 (First) | Tutorial owner | `FIRST_OUTDATED_TUTORIAL_NOTIFICATION` |
| 1 (Second) | Owner + CC: repository owner | `SECOND_OUTDATED_TUTORIAL_NOTIFICATION` |
| 2 (Third) | Owner + CC: admin list + repository owner | `THIRD_OUTDATED_TUTORIAL_NOTIFICATION` |
| 3 (Final) | Admin list only | `FINAL_OUTDATED_TUTORIAL_NOTIFICATION` |

### Scheduler

- Cron: `0 0 9 * * ?` (daily at 9:00 AM)
- Resend interval: 1 month between stages
- Runs with SYSTEM security context

### Configuration

```yaml
tutorial-meta:
  notification:
    months-to-resend: 1
    email-config-name: emailListForOutdated
    notifications-allowed: isNotificationSendingAllowed
    cron: 0 0 9 * * ?
```

### Admin Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/getRecipientList` | Get configured email recipients |
| POST | `/updateRecipientList` | Update recipient list |
| GET | `/sendNotification` | Manually trigger all pending notifications |
| GET | `/sendTutorialNotification?tutorialId={id}` | Trigger notification for specific tutorial |
| POST | `/updateNotificationsSendingStatus` | Enable/disable automatic sending |

**POC gap:** No notification management. The Tutorial Dashboard's "Last Reminder Email" column and the notification scheduler have no equivalent.

---

## 4. Featured Tasks

Admin-curated list of promoted tutorials, groups, or missions for homepage display.

### How It Works

The `Task` entity has a `featuredOrder` integer field. When a task is marked as featured, `FeaturedTaskServiceImpl` sets this field to an incrementing counter (starting from the current max + 1). Unmarking resets it to 0.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/findAllFeaturedTasks` | Admin, DeveloperApp | Get all featured tasks |
| GET | `/getAllFeaturedIdsList` | Admin, DeveloperApp | Get featured task IDs |
| GET | `/getAllFeaturedIdsMap` | Admin, DeveloperApp | Get featured IDs with display order |
| POST | `/setFeaturedOrder/{ids}` | Admin | Mark tasks as featured (comma-separated IDs) |
| DELETE | `/deleteFeaturedOrder/{ids}` | Admin | Unmark tasks as featured |

**POC gap:** The Tutorial Navigator has no "featured" section or curation capability.

---

## 5. Leaderboard & Rankings

User-facing feature showing rankings by task type completion.

### Implementation

Exposed as a Spring Data REST **projection** on the User entity:

```
GET /users/{id}?projection=leaderBoardRankings
```

Returns: `uuid`, `sapId`, `profile`, `accomplishments`, and computed `leaderBoardRankings` (rankings by GROUP, MISSION, TUTORIAL task types).

- Cache: `eventId` cache with 600-second TTL
- Implementation: `LeaderBoardRankingsRepositoryImpl` with native SQL queries

**POC gap:** No leaderboard or ranking display anywhere in the POC.

---

## 6. Spring Batch Jobs

Background processing jobs that run on schedule. All execute with SYSTEM authority.

| Job | Schedule | Purpose |
|---|---|---|
| Task Record State Calculation | On task-record save (event-driven) | Cascade status up the hierarchy (Tutorial → Group → Mission) |
| Analytics (Adobe) | On task-record save | Send completion events to Adobe Analytics (`sap.d1.sc.omtrdc.net`) |
| NGDS Sync | Every 2 hours (`0 0 */2 * * *`) | Push task records to SAP internal tracking |
| Accomplishment Processing | On task-record save | Evaluate accomplishment rules, create records |
| Account Merge | Daily at midnight | Process pending account consolidation requests |
| Active Learner Stats | Daily at midnight | Compute daily active learner counts |
| Tags Cleanup | Every 6 months | Remove unused tags |
| Step Failure Cleanup | Daily at midnight | Remove stale step records older than 30 days |
| General Cleanup | Every hour | Clean up orphaned/stale data |
| Batch Metadata Cleanup | Every hour at :15 | Purge old Spring Batch execution metadata |

**Thread pool:** 20 threads, with 50% capacity (10 threads) reserved for analytics jobs via `PriorityJobLauncher`.

**POC gap:** The POC has no batch processing. If the CAP backend takes over step completion, it will need to handle (or delegate to IMS) the cascading status calculation, analytics, accomplishment evaluation, and NGDS sync that these jobs perform.

---

## 7. Tutorial Repository & Contributor Tracking

Tracks GitHub repository ownership and tutorial contributor information. Used by the notification system for email routing.

### Data Model

```
RepositoryModel (ims_tutorial_repository)
  ├── name (String)
  └── owner → TutorialContributor

TutorialContributor (ims_tutorial_author)
  ├── name (String)
  └── email (String)

TutorialMeta (ims_tutorial_meta)
  ├── tutorial → Tutorial
  ├── repository → RepositoryModel
  ├── notificationNumber (short) — current escalation stage
  └── lastNotificationDate
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/tutorialRepository/sortedRepositories` | List repos sorted (used by Tutorial Dashboard filter) |
| PATCH | `/tutorialRepository/updateTutorialRepositoryOwner/{name}` | Update repo owner |

**POC gap:** No repository or contributor management. The POC fetches tutorials from GitHub but doesn't track ownership metadata.

---

## 8. Account Merge

Consolidates multiple SAP user accounts into one, merging all task records and progress.

### Flow

1. External system (SCI) calls `POST /api/v1/user-merge/{uuid}` with secondary accounts
2. IMS stores the merge request
3. Daily batch job processes pending merges via `AccountMergeProcessor`
4. Status queryable via `GET /api/v1/user-merge/{uuid}/status`

**Auth:** Requires `CONSOLIDATION_SCOPE` — not accessible from the admin UI or frontend. Called by SAP's identity consolidation service.

**POC gap:** Out of scope for the frontend, but the CAP backend would need to be aware of merged users if it maintains its own user table.

---

## Summary: POC Coverage Gap

| Feature | IMS Module | Priority | Notes |
|---|---|---|---|
| Tutorial Dashboard (freshness/ownership) | Admin UI | **High** | Core content operations tool |
| Mission Management (nested path editor) | Admin UI | **High** | Complex form, no alternative exists |
| Groups Management | Admin UI | **High** | Required for mission path composition |
| Board / Analytics Dashboard | Admin UI | **Medium** | Operational visibility |
| Events Management | Admin UI | **Medium** | Required for App Space configuration |
| Privacy/GDPR Tools | Admin UI | **Medium** | Compliance requirement |
| Notification System | Backend | **Medium** | Automated, but needs admin config UI |
| Featured Tasks Curation | Admin UI | **Medium** | Homepage curation |
| Real-Time Event Display (WebSocket) | Display modules | **Medium** | Live event dashboards |
| Prizes Management | Admin UI | **Low** | Simple CRUD, event-specific |
| Accomplishments Management | Admin UI | **Low** | Rule-based badges |
| Statistics Export | Admin UI | **Low** | CSV download |
| Leaderboard | User-facing | **Low** | Rankings display |
| Tags (read-only) | Admin UI | **Low** | Reference table |
| Batch Jobs | Backend | **N/A** | Backend concern, not UI |
| Account Merge | Backend | **N/A** | External system integration |
| Repository/Contributor Tracking | Backend | **N/A** | Backend data model, feeds notifications |
