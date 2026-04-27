# AEM API Reference

This document catalogs every AEM (Adobe Experience Manager) endpoint called by the tutorial platform, where each call is made, what data is consumed, and how it maps to the future CAP/IMS backend. Use this as the requirements specification when building the CAP replacement layer.

**Base URL**: `https://developers.sap.com`
**Dev proxy**: VitePress dev server proxies `/bin/sapdx/*` to `https://developers.sap.com` (configured in `site/.vitepress/config.ts:26-31`)

---

## Table of Contents

1. [Solr Search API](#1-solr-search-api)
2. [miniNavigator API](#2-mininavigator-api)
3. [Progress Series API](#3-progress-series-api)
4. [Progress Update API](#4-progress-update-api)
5. [Auth API](#5-auth-api)
6. [Page Properties API](#6-page-properties-api)
7. [QR Code API](#7-qr-code-api)
8. [Endpoint Summary Matrix](#endpoint-summary-matrix)
9. [Data Flow Diagrams](#data-flow-diagrams)
10. [CAP Migration Notes](#cap-migration-notes)

---

## 1. Solr Search API

### Endpoint

```
GET /bin/sapdx/v3/solr/search?json={encoded_json}
```

### Callers

| File | Context | Purpose |
|------|---------|---------|
| `scripts/parsers/aem.ts:92` | Build time | Discover all missions (and groups) for static page generation |
| `site/.vitepress/theme/composables/useAemEnrichment.ts:115` | Client runtime | Fetch mission icon SVG for enrichment display |

### Request Format

The `json` query parameter is a URL-encoded JSON object. Two distinct calling patterns exist:

#### Pattern A: Full Discovery (build pipeline)

Used to fetch all missions/groups/tutorials in a single request. The `pagePath` parameter is critical — it scopes results to the tutorial navigator page and enables returning large result sets.

```json
{
  "rows": "300",
  "start": 0,
  "searchField": "",
  "pagePath": "/content/developers/website/languages/en/tutorial-navigator",
  "language": "en_us",
  "addDefaultLanguage": true,
  "filters": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `rows` | string | Max results to return. AEM accepts up to ~500. Use `"300"` to get all ~87 missions + ~194 groups in one call. |
| `start` | number | Offset for pagination (0-indexed). Not needed with high `rows`. |
| `searchField` | string | Free-text search query. Empty string returns all. |
| `pagePath` | string | **Critical.** Scopes results to a specific AEM page context. Without this, the API returns a different response shape with pagination limited to 20 results and mixed type ordering. With it, results are sorted by type (missions first, then groups, then tutorials). |
| `language` | string | Locale code. Always `"en_us"`. |
| `addDefaultLanguage` | boolean | Include default language fallback content. Always `true`. |
| `filters` | array | Facet filter selections. Empty array returns unfiltered results. |

**Important discovery**: Without `pagePath`, the API behaves like a paginated search (max 20 per page, mixed types). The `taskTypes` filter in the request does NOT actually filter — it only promotes that type to page 1. The `pagePath` approach is what developers.sap.com's own tutorial navigator uses.

#### Pattern B: Mission Icon Lookup (client-side enrichment)

```json
{
  "searchterm": "",
  "taskTypes": ["mission"],
  "additionalIds": [14094]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `searchterm` | string | Empty to match all. |
| `taskTypes` | string[] | Promotes mission type to first page of results. Does NOT filter exclusively. |
| `additionalIds` | number[] | Ensures specific IMS IDs appear in results regardless of pagination. |

### Response Format

```json
{
  "numFound": 1664,
  "countGroups": 194,
  "countMissions": 87,
  "countTutorials": 1383,
  "tags": {
    "c1a376dd-...:4625ac99-...": {
      "title": "Advanced",
      "tagTitle": "tutorial:experience/advanced",
      "tagAlternativeTitles": ["advanced"]
    },
    "197f4ec4-...:tech/73554900100700003316/...": {
      "title": "SAP BTP SDK for Android",
      "tagTitle": "software-product:technology-platform/sap-btp-sdk/sap-btp-sdk-for-android",
      "tagAlternativeTitles": ["Android SDK for SAP BTP"]
    }
  },
  "facets": {
    "Topic": { /* UUID → count mappings */ },
    "Software Product": { /* UUID → count mappings */ }
  },
  "result": [
    {
      "imsId": 14094,
      "title": "Combine CAP with SAP HANA Cloud to Create Full-Stack Applications",
      "description": "Complete this mission to build full-stack applications...",
      "publicUrl": "/mission.hana-cloud-cap.html",
      "experience": "c1a376dd-ebd0-4787-804e-a23fef23ba06:4625ac99-...",
      "time": "7500",
      "icon": "<svg>...</svg>",
      "tasksCount": 7,
      "taskType": "mission",
      "primaryTag": "software-product:technology-platform/sap-hana-cloud",
      "itemsType": "mixed",
      "statusTask": "intact",
      "taskProgress": 0,
      "isRequiredLicense": false,
      "featured": false,
      "featuredOrder": 0
    }
  ]
}
```

### Fields Consumed

| Field | Used By | Mapped To |
|-------|---------|-----------|
| `result[].imsId` | Build pipeline | `AemMission.imsId` — primary key for miniNavigator lookup |
| `result[].title` | Build pipeline | `AemMission.title` — mission page title |
| `result[].description` | Build pipeline | `AemMission.description` — mission page description |
| `result[].publicUrl` | Build pipeline | Slug extracted via regex `/mission\.([^/.]+)/` → `AemMission.slug` |
| `result[].experience` | Build pipeline | UUID looked up in `tags` map → `AemMission.level` ("beginner"/"intermediate"/"advanced") |
| `result[].time` | Build pipeline | String of seconds, divided by 60 → `AemMission.time` (minutes) |
| `result[].icon` | Build pipeline, client enrichment | SVG string for mission badge display |
| `result[].tasksCount` | Build pipeline | `AemMission.tasksCount` — total tutorials in mission |
| `tags` | Build pipeline | Experience UUID → human-readable level mapping. Only entries where `tagTitle` contains `"experience/"` are used. There are exactly 3: Beginner, Intermediate, Advanced. |
| `countMissions`, `countGroups`, `countTutorials` | Not directly consumed | Useful for build summary validation |

### Slug Extraction

Mission slugs are extracted from `publicUrl`:

```
/mission.hana-cloud-cap.html  →  "hana-cloud-cap"
/group.hana-cloud-cap-setup.html  →  "hana-cloud-cap-setup"
/tutorials/hana-cloud-deploying.html  →  "hana-cloud-deploying"
```

Regex patterns used in `scripts/parsers/aem.ts`:

```typescript
publicUrl.match(/\/mission\.([^/.]+)/)   // missions
url.match(/\/group\.([^/.]+)/)           // groups
url.match(/\/tutorials\/([^/.]+)/)       // tutorials
```

---

## 2. miniNavigator API

### Endpoint

```
GET /bin/sapdx/v2/tutorial/miniNavigator.{imsId}.json
```

**Important**: The URL format is `.{imsId}.json` — NOT `.0.{imsId}.json`. The `.0.` prefix was a bug in the original composable (now fixed). The `{imsId}` is the mission's numeric IMS ID from the search API.

### Callers

| File | Context | Purpose |
|------|---------|---------|
| `scripts/parsers/aem.ts:121` | Build time | Fetch full mission→group→tutorial hierarchy for page generation |
| `site/.vitepress/theme/composables/useAemEnrichment.ts:90` | Client runtime | Fetch live hierarchy with progress data for logged-in users |

### Request

Simple GET with no query parameters. The `{imsId}` is embedded in the URL path as an AEM Sling selector.

```
GET /bin/sapdx/v2/tutorial/miniNavigator.14094.json
```

### Response Format

```json
{
  "context": [
    {
      "title": "Combine CAP with SAP HANA Cloud to Create Full-Stack Applications",
      "description": "Deploy and configure SAP HANA Cloud...",
      "imsId": 14094,
      "progress": 0,
      "taskType": "Mission",
      "url": "/mission.hana-cloud-cap.html",
      "tutorialCount": 7,
      "tutorialCompleted": 0,
      "isSelected": false,
      "includes": [
        {
          "title": "Set Up SAP HANA Cloud and CAP Project",
          "description": "Create an instance of SAP HANA Cloud...",
          "imsId": 14091,
          "progress": 0,
          "taskType": "Group",
          "url": "/group.hana-cloud-cap-setup.html",
          "tutorialCount": 3,
          "tutorialCompleted": 0,
          "includes": [
            {
              "title": "Deploy SAP HANA Cloud",
              "description": "Create an instance of the SAP HANA Cloud...",
              "imsId": 52837,
              "progress": 0,
              "taskType": "Tutorial",
              "url": "/tutorials/hana-cloud-deploying.html",
              "timeToComplete": 900,
              "isSelected": false
            }
          ]
        }
      ]
    }
  ]
}
```

### Hierarchy Structure

There are two mission shapes:

#### Structured missions (with groups)

```
context[0] (Mission)
  └─ includes[] (Groups)
       └─ includes[] (Tutorials)
```

Most missions follow this pattern. Groups are intermediate containers.

#### Flat missions (no groups)

```
context[0] (Mission)
  └─ includes[] (Tutorials directly)
```

Some missions contain tutorials directly without groups. The build pipeline creates a synthetic group for these to normalize the data model.

### Fields Consumed

| Field | Used By | Mapped To |
|-------|---------|-----------|
| `context[0].includes[]` | Build pipeline | Iterated to build group and tutorial lists |
| `includes[].taskType` | Build pipeline | `"Group"` or `"Tutorial"` — determines hierarchy level |
| `includes[].title` | Build pipeline | `AemHierarchyGroup.title` |
| `includes[].description` | Build pipeline | `AemHierarchyGroup.description` |
| `includes[].imsId` | Build pipeline | `AemHierarchyGroup.imsId` — group identifier |
| `includes[].url` | Build pipeline | Group/tutorial slug extracted via regex |
| `includes[].includes[]` | Build pipeline | Nested tutorials within a group |
| `includes[].progress` | Client enrichment | 0-100 progress percentage for logged-in users |
| `includes[].tutorialCount` | Client enrichment | Total tutorials in group |
| `includes[].tutorialCompleted` | Client enrichment | Completed tutorials in group |
| Tutorial `.timeToComplete` | Client enrichment | Seconds — divided by 60 for display |

### Concurrency

At build time, the pipeline fetches hierarchies for all 87 missions with a concurrency limit of 5 (`CONCURRENCY = 5` in `aem.ts`). Progress is logged every 20 missions.

---

## 3. Progress Series API

### Endpoint

```
GET /bin/sapdx/tutorials/v3/progress/series?missionId={missionId}
```

### Callers

| File | Context | Purpose |
|------|---------|---------|
| `site/.vitepress/theme/components/AppSpace.vue:54` | Client runtime | Load tracks with progress for App Space event page |
| `site/.vitepress/theme/composables/useAemEnrichment.ts:102` | Client runtime | Fallback when miniNavigator returns no usable data |

### Request

Simple GET with mission ID query parameter. **Requires authentication** — returns progress data specific to the logged-in user.

```
GET /bin/sapdx/tutorials/v3/progress/series?missionId=24609
```

### Response Format

```json
{
  "eventId": 38,
  "type": "COMPLEX",
  "paths": [
    {
      "id": 974,
      "title": "ABAP Cloud",
      "description": "Get started with ABAP Cloud development on SAP BTP...",
      "items": [
        {
          "imsId": 1,
          "title": "Get an SAP BTP Trial Account",
          "type": "TUTORIAL",
          "status": "COMPLETED",
          "progress": 100,
          "experience": "Beginner",
          "timeToComplete": 900,
          "url": "https://developers.sap.com/tutorials/hcp-create-trial-account.html",
          "description": "Sign up for a free trial account..."
        },
        {
          "imsId": 10,
          "title": "ABAP Cloud Track Prize",
          "type": "PRIZE",
          "status": "",
          "progress": 0,
          "experience": "",
          "timeToComplete": 0,
          "url": "",
          "description": "Complete all tutorials to earn this badge.",
          "recordId": 0
        }
      ]
    }
  ]
}
```

### Fields Consumed

| Field | Used By | Mapped To |
|-------|---------|-----------|
| `paths[]` | AppSpace.vue | Rendered as "tracks" — each track is a learning path |
| `paths[].id` | AppSpace.vue | Track identifier |
| `paths[].title` | AppSpace.vue, useAemEnrichment | Track/group display name |
| `paths[].description` | AppSpace.vue, useAemEnrichment | Track/group description |
| `paths[].items[]` | AppSpace.vue | Iterated to render tutorial timeline |
| `items[].type` | AppSpace.vue | `"TUTORIAL"`, `"CHECKPOINT"`, or `"PRIZE"` — controls rendering and unlock logic |
| `items[].status` | AppSpace.vue | `"COMPLETED"`, `"IN_PROGRESS"`, `"EARNED"`, or `""` |
| `items[].progress` | AppSpace.vue | 0-100 percentage |
| `items[].timeToComplete` | AppSpace.vue, useAemEnrichment | Seconds — divided by 60 for display |
| `items[].url` | AppSpace.vue, useAemEnrichment | Full URL to tutorial on developers.sap.com. Slug extracted via `/tutorials/([^/.]+)/` |
| `items[].imsId` | AppSpace.vue | Used in QR code URL generation |
| `items[].recordId` | AppSpace.vue | Used in QR code URL generation (event-specific) |
| `items[].experience` | AppSpace.vue | Difficulty level string |
| `eventId` | AppSpace.vue | Event identifier for QR code generation |

### Notes

- This is the **only authenticated endpoint** used at runtime (the build pipeline uses only unauthenticated AEM calls)
- When the user is not logged in, this endpoint returns an error/empty response, and the AppSpace falls back to loading static data from `/app-space-data.json`
- The `useAemEnrichment.ts` composable uses this as a fallback when miniNavigator doesn't return usable group data

---

## 4. Progress Update API

### Endpoint

```
POST /bin/sapdx/tutorials/progress
```

### Callers

| File | Context | Purpose |
|------|---------|---------|
| Referenced in design spec | Client runtime (future) | Mark a tutorial step as complete |

### Request Format

```
POST /bin/sapdx/tutorials/progress
Content-Type: application/x-www-form-urlencoded

pagePath=/content/developers/website/languages/en/tutorials/hana-cloud-deploying
```

| Field | Type | Description |
|-------|------|-------------|
| `pagePath` | string | AEM content path to the tutorial. Format: `/content/developers/website/languages/en/tutorials/{slug}` |

### Response

- **201 Created** on success (no response body)

### Notes

- This endpoint uses AEM content paths as identifiers, not tutorial slugs. The CAP replacement should use tutorial slug + step number instead.
- Not yet implemented in the POC — currently step completion uses only client-side state (localStorage).

---

## 5. Auth API

### Endpoint

```
GET /bin/sapdx/auth.json/...
```

### Callers

| File | Context | Purpose |
|------|---------|---------|
| Referenced in design spec | Client runtime (future) | Check user authentication state and profile |

### Response Format

```json
{
  "isUserLoggedIn": true,
  "firstName": "Thomas",
  "lastName": "Jung",
  "email": "thomas.jung@sap.com",
  "userId": "I809764",
  "avatarLink": "https://...",
  "universalId": "thomas.jung@sap.com",
  "identityProvider": "IDS",
  "company": "SAP SE",
  "type": "employee"
}
```

### Fields Consumed

| Field | Type | Description |
|-------|------|-------------|
| `isUserLoggedIn` | boolean | Whether user has an active session |
| `firstName`, `lastName` | string | Display name |
| `email` | string | User email |
| `userId` | string | SAP user ID (e.g., "I809764") |
| `avatarLink` | string | Profile picture URL |
| `universalId` | string | Cross-system identifier |
| `identityProvider` | string | Auth provider ("IDS" = SAP Identity Service) |
| `type` | string | "employee" or "external" |

### Notes

- Not yet implemented in the POC. The AppRouter/XSUAA handles authentication directly, and user info will come from the XSUAA JWT token via the CAP backend (`GET /api/me`).

---

## 6. Page Properties API

### Endpoint

```
GET /bin/sapdxc/v2/tutorials/pageProperties.json/...
```

**Note**: This uses `/bin/sapdxc/` (with a `c`), not `/bin/sapdx/`.

### Callers

| File | Context | Purpose |
|------|---------|---------|
| Referenced in design spec | Not currently called | Tutorial metadata lookup |

### Response Format

```json
{
  "contentId": "hana-cloud-deploying",
  "tags": ["sap-hana-cloud", "beginner"],
  "damPath": "/content/dam/...",
  "bookmarkApiUrl": "https://people-api.services.sap.com/...",
  "tutorialNavigatorPath": "/tutorial-navigator.html"
}
```

### Notes

- Not currently called by the POC. Tutorial metadata (tags, content ID) is now derived from GitHub frontmatter at build time.
- The `bookmarkApiUrl` points to SAP's people API for bookmark/favorite functionality — a separate integration concern.

---

## 7. QR Code API

### Endpoint

```
GET /bin/sapdx/github/qrcode?imsId={imsId}&type={type}&eventId={eventId}&recordId={recordId}
```

### Callers

| File | Context | Purpose |
|------|---------|---------|
| `site/.vitepress/theme/components/AppSpace.vue:156` | Client runtime | Generate QR codes for event badge scanning |

### Request Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `imsId` | number | Tutorial/checkpoint/prize IMS ID |
| `type` | string | Item type: `"TUTORIAL"`, `"CHECKPOINT"`, or `"PRIZE"` |
| `eventId` | number | Event identifier (e.g., `38` for current event) |
| `recordId` | number | Event-specific record ID (defaults to `0`) |

### Response

Returns a QR code image (PNG or SVG). Used as an `<img>` src in the App Space component.

### Notes

- Event-specific functionality for in-person SAP events (TechEd, Sapphire)
- The QR code links back to AEM for badge/prize redemption
- May not need a CAP replacement if events move to a different system

---

## Endpoint Summary Matrix

| # | Endpoint | Method | Auth Required | Build Time | Client Runtime | Current Status |
|---|----------|--------|---------------|------------|----------------|----------------|
| 1 | `/bin/sapdx/v3/solr/search` | GET | No | Yes | Yes | Actively used |
| 2 | `/bin/sapdx/v2/tutorial/miniNavigator.{id}.json` | GET | No* | Yes | Yes | Actively used |
| 3 | `/bin/sapdx/tutorials/v3/progress/series` | GET | Yes | No | Yes | Actively used |
| 4 | `/bin/sapdx/tutorials/progress` | POST | Yes | No | No | Not yet implemented |
| 5 | `/bin/sapdx/auth.json` | GET | No | No | No | Not yet implemented |
| 6 | `/bin/sapdxc/v2/tutorials/pageProperties.json` | GET | No | No | No | Not needed (data from GitHub) |
| 7 | `/bin/sapdx/github/qrcode` | GET | No | No | Yes | App Space only |

\* miniNavigator returns `progress: 0` for unauthenticated requests but still returns the hierarchy structure.

---

## Data Flow Diagrams

### Build Time (Phase 4 of fetch-tutorials.ts)

```
                    ┌─────────────────────────┐
                    │  Solr Search API         │
                    │  (single request,        │
                    │   rows=300)              │
                    └────────┬────────────────┘
                             │
                    87 AemMission objects
                    (imsId, title, slug,
                     level, time, icon)
                             │
                             ▼
              ┌──────────────────────────────┐
              │  miniNavigator API           │
              │  (87 concurrent requests,    │
              │   concurrency limit = 5)     │
              └────────┬─────────────────────┘
                       │
              87 AemHierarchy objects
              (groups[], tutorialSlugs[])
                       │
                       ▼
         ┌─────────────────────────────────┐
         │  Cross-reference with           │
         │  GitHub-discovered tutorials    │
         │  (1370 tutorials from           │
         │   sap-tutorials org)            │
         └────────┬────────────────────────┘
                  │
       ┌──────────┼──────────────┐
       ▼          ▼              ▼
  mission-*.md  group-*.md   tutorial patches
  (87 files)    (70 files)   (491 files patched
                              with mission/group
                              + prev/next)
                  │
                  ▼
            _nav.json
            (missions[], groups[],
             tutorials[] enriched)
```

### Client Runtime (logged-in user)

```
  MissionLayout.vue              GroupLayout.vue
       │                              │
       │  (data from frontmatter,     │  (data from frontmatter,
       │   generated at build time)   │   generated at build time)
       │                              │
       ▼                              │
  useAemEnrichment                    │
       │                              │
       ├─► miniNavigator API ─────────┘
       │   (live progress data)
       │
       └─► Solr Search API
           (mission icon SVG)
       │
       └─► Progress Series API
           (fallback for progress)

  AppSpace.vue
       │
       └─► Progress Series API
           (tracks with completion state)
       │
       └─► QR Code API
           (badge scanning images)
```

---

## CAP Migration Notes

### What CAP replaces

The AEM proxy (`/bin/sapdx/*` → `https://developers.sap.com`) should be replaced with CAP service endpoints (`/api/*` → CAP backend). The mapping:

| AEM Endpoint | CAP Replacement | Data Source |
|---|---|---|
| Solr Search (discovery) | **Not needed at runtime** — discovery happens at build time now. The `_nav.json` file contains all missions/groups/tutorials for client-side filtering. | Build-time only |
| Solr Search (icon lookup) | `GET /api/missions/{id}` | IMS or cached in CAP DB |
| miniNavigator (hierarchy) | **Not needed at runtime for structure** — hierarchy is baked into mission/group page frontmatter at build time. Only needed for live progress. | Build-time only for structure |
| miniNavigator (progress) | `GET /api/missions/{id}/progress` | IMS user progress data |
| Progress Series | `GET /api/events/{eventId}/progress` | IMS event/series progress |
| Progress Update | `POST /api/tutorials/{slug}/steps/{n}/complete` | IMS progress write |
| Auth | `GET /api/me` | XSUAA JWT token (no AEM auth needed) |
| Page Properties | **Not needed** — metadata comes from GitHub at build time | N/A |
| QR Code | `GET /api/events/{eventId}/qrcode?...` or keep as-is | Event system |

### IMS ID as the bridge

The `imsId` field is the IMS (Information Management System) identifier that links AEM content to the backend progress/gamification system. Every mission, group, and tutorial has an `imsId`. When building the CAP layer:

- **Missions**: `imsId` from search API → stored in mission page frontmatter as `missionId`
- **Groups**: `imsId` from miniNavigator → stored in group page frontmatter as `groupId`
- **Tutorials**: `imsId` from miniNavigator → not currently stored (tutorial pages use slug as primary key)

The CAP model should maintain an `imsId` column on all entities for backward compatibility with the IMS progress system.

### Build-time vs runtime split

The current architecture minimizes runtime AEM dependencies by doing heavy lifting at build time:

- **Build time (no auth needed)**: Solr Search + miniNavigator → generates static pages with full hierarchy baked in
- **Runtime (auth needed)**: Only progress/completion data needs live API calls

This means the CAP backend primarily needs to serve **user-specific progress data**, not structural data. The structure (which tutorials are in which groups, which groups are in which missions) is static content generated at build time.

### Experience level mapping

AEM uses UUIDs for experience levels, mapped via the `tags` object in the search response. There are exactly 3:

| UUID Pattern | Level |
|---|---|
| `tagTitle` contains `experience/beginner` | beginner |
| `tagTitle` contains `experience/intermediate` | intermediate |
| `tagTitle` contains `experience/advanced` | advanced |

The CAP model can use a simple enum instead of UUID-based tag lookups.

### Time format differences

| Source | Format | Unit |
|---|---|---|
| Solr Search `time` | String | Seconds (e.g., `"7500"`) |
| miniNavigator `timeToComplete` | Number | Seconds (e.g., `900`) |
| Progress Series `timeToComplete` | Number | Seconds (e.g., `900`) |
| Build pipeline output | Number | **Minutes** (converted during build) |
| Frontend display | String | Formatted (e.g., "2 hr. 5 min.") |

The CAP model should store time in minutes to match the build pipeline output, or seconds to match the source — pick one and document it.
