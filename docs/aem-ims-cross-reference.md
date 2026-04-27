# AEM ↔ IMS Cross-Reference

> How the tutorials-frontend calls AEM, how AEM calls IMS, and how to replace the AEM layer.

## Architecture: Three-Layer Proxy Chain

```
┌─────────────────────────────────────────────────────────────────────┐
│  tutorials-frontend (VitePress + Vue 3)                             │
│                                                                     │
│  /bin/sapdx/*  ──Vite proxy──►  developers.sap.com (AEM)           │
│  /api/*        ──Vite proxy──►  localhost:4004 (CAP backend)        │
│  /tutorials/_nav.json           static file (build-time generated)  │
└─────────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────┐    ┌─────────────────────────────────┐
│  AEM Layer           │    │  CAP Backend (localhost:4004)    │
│  (developers.sap.com)│    │  (new — replaces AEM over time) │
│                      │    │                                 │
│  Custom Sling        │    │  /tutorials/:slug/progress      │
│  servlets under      │    │  /tutorials/:slug/steps/:n/     │
│  /bin/sapdx/         │    │    complete                     │
│       │              │    │  /missions/:id/navigation       │
│       ▼              │    └─────────────────────────────────┘
│  Calls IMS REST API  │
│  with DEVELOPER_APP  │
│  OAuth scope         │
└──────────┬───────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│  IMS (Spring Boot + HANA)               │
│  com.sap.developers.ims                 │
│                                         │
│  /task-records       /users             │
│  /tutorials          /missions          │
│  /groups             /prizes            │
│  /events             /statistic         │
│  (Spring Data REST — HAL+JSON)          │
└─────────────────────────────────────────┘
```

### Key Insight

The `/bin/sapdx/*` paths are **AEM Sling servlets**, not IMS endpoints. AEM acts as an aggregation/proxy layer: it receives a single frontend request, makes one or more calls to IMS's Spring Data REST API (authenticated with `SCOPE_Developer`), reshapes the responses, and returns them. The frontend never calls IMS directly.

The `/api/*` paths go to the **CAP backend** — a separate Node.js service that is the planned replacement for the AEM proxy layer.

---

## Endpoint-by-Endpoint Cross-Reference

### 1. miniNavigator — Mission Structure with Progress

| Layer | Detail |
|---|---|
| **Frontend call** | `GET /bin/sapdx/v2/tutorial/miniNavigator.{missionId}.json` |
| **File** | `site/.vitepress/theme/composables/useAemEnrichment.ts:90` |
| **Vite proxy** | → `https://developers.sap.com/bin/sapdx/v2/tutorial/miniNavigator.{missionId}.json` |
| **AEM servlet** | Custom Sling servlet at `/bin/sapdx/v2/tutorial/miniNavigator` |
| **IMS endpoints called by AEM** | `GET /missions/{missionId}/completion-graph?userId={userId}` → `CompletionGraph` |
| | `GET /task-records/search/findTaskProgressByUserAndTasksIds?userImsId={id}&tasksIds={ids}&tutorialId={id}` |
| **IMS auth scope** | `SCOPE_Developer` (DEVELOPER_APP role) |

**Frontend response shape:**
```json
{
  "context": [{
    "title": "Mission Title",
    "description": "...",
    "imsId": 12345,
    "progress": 75,
    "taskType": "Mission",
    "includes": [{
      "title": "Group Title",
      "taskType": "Group",
      "progress": 50,
      "includes": [{
        "title": "Tutorial Title",
        "taskType": "Tutorial",
        "url": "/tutorials/tutorial-slug",
        "progress": 100,
        "timeToComplete": 1800
      }]
    }]
  }]
}
```

**AEM aggregation logic:** AEM fetches the mission's completion graph from IMS (which includes the full Group → Tutorial hierarchy), merges in the user's progress from task records, and flattens it into the nested `context[].includes[].includes[]` shape. The `timeToComplete` is in **seconds** (frontend divides by 60).

**CAP replacement path:** `GET /api/missions/{missionId}/navigation` (see entry #6 below).

---

### 2. Progress Series — Mission Progress with Tracks

| Layer | Detail |
|---|---|
| **Frontend call** | `GET /bin/sapdx/tutorials/v3/progress/series?missionId={missionId}` |
| **Files** | `useAemEnrichment.ts:102` (fallback), `AppSpace.vue:54` (primary for App Space) |
| **Vite proxy** | → `https://developers.sap.com/bin/sapdx/tutorials/v3/progress/series?missionId={id}` |
| **AEM servlet** | Custom Sling servlet for progress series |
| **IMS endpoints called by AEM** | `GET /missions/{missionId}/completion-graph?userId={userId}` |
| | `GET /task-records/search/byUserAndTasks?userId={id}&taskId={ids}` |
| | `GET /users/resolve?accountNumber={account}` (to get IMS userId from session) |
| **IMS auth scope** | `SCOPE_Developer` |

**Frontend response shape:**
```json
{
  "eventId": 38,
  "type": "MISSION",
  "paths": [{
    "id": 1001,
    "title": "Track 1",
    "description": "...",
    "items": [{
      "imsId": 5001,
      "title": "Tutorial Title",
      "type": "TUTORIAL",
      "status": "COMPLETED",
      "progress": 100,
      "experience": "Beginner",
      "timeToComplete": 900,
      "url": "/tutorials/tutorial-slug",
      "description": "...",
      "recordId": 99999
    }, {
      "imsId": 5002,
      "type": "CHECKPOINT",
      "status": "LOCKED"
    }, {
      "imsId": 5003,
      "type": "PRIZE",
      "status": "AVAILABLE"
    }]
  }]
}
```

**AEM aggregation logic:** AEM resolves the user from their IDP session, looks up their IMS userId, fetches the mission's completion paths (Group → Tutorial hierarchy), joins with the user's task records for progress/status, and adds event-specific items (checkpoints, prizes). The `paths` array maps to IMS `CompletionPath` entities within the Mission.

**Used by App Space:** `AppSpace.vue` calls this with hardcoded `MISSION_ID = 24609`. Falls back to static `/app-space-data.json` when the user is not authenticated (AEM returns error).

---

### 3. Solr Search — Mission Icon Lookup

| Layer | Detail |
|---|---|
| **Frontend call** | `GET /bin/sapdx/v3/solr/search?json={encoded_query}` |
| **File** | `useAemEnrichment.ts:115` |
| **Vite proxy** | → `https://developers.sap.com/bin/sapdx/v3/solr/search?json={query}` |
| **AEM layer** | **AEM's own Solr index** — NOT an IMS endpoint |
| **IMS involvement** | None. Solr indexes AEM content pages, not IMS data. |

**Query payload:**
```json
{ "searchterm": "", "taskTypes": ["mission"], "additionalIds": [missionId] }
```

**Response:** `{ "result": [{ "icon": "https://...", ... }] }`

**Key insight:** This endpoint queries AEM's **content search engine** (Apache Solr), not IMS. It's used solely to fetch the mission's icon image URL, which is stored as AEM content metadata. IMS has no icon field on the Mission entity.

**Replacement strategy:** Store mission icons as part of the build-time tutorial metadata, or add an `icon` field to the mission data in the CAP backend. This is the one AEM call with no IMS equivalent.

---

### 4. QR Code Generation

| Layer | Detail |
|---|---|
| **Frontend URL** | `/bin/sapdx/github/qrcode?imsId={id}&type={type}&eventId=38&recordId={recordId}` |
| **File** | `AppSpace.vue:156` (URL construction, rendered as `<img src>`) |
| **Vite proxy** | → `https://developers.sap.com/bin/sapdx/github/qrcode?...` |
| **AEM servlet** | QR code image generator |
| **IMS endpoints called by AEM** | `PATCH /prize-records/{recordId}` (to validate/update prize claim) |
| | `GET /prize-records/findByUserAndPrizeIds?userId={id}&prizeIds={ids}` |
| **IMS auth scope** | `SCOPE_Developer` |

**Note:** This generates a QR code **image** (not JSON). The `imsId` parameter is the IMS task ID. `eventId=38` is hardcoded for the current event. The QR code encodes a URL that, when scanned, triggers prize fulfillment on the AEM side, which then updates the IMS prize record.

---

### 5. Tutorial Progress — CAP Backend (New)

| Layer | Detail |
|---|---|
| **Frontend call** | `GET /api/tutorials/{slug}/progress` |
| **File** | `TutorialLayout.vue:95-96` via `useApi().get()` |
| **Vite proxy** | → `http://localhost:4004/tutorials/{slug}/progress` (strips `/api` prefix) |
| **Backend** | **CAP backend** (not AEM, not IMS directly) |
| **IMS equivalent** | `GET /task-records/search/findTaskProgressByUserAndTasksIds?userImsId={id}&tasksIds={ids}&tutorialId={id}` |
| | `GET /users/{userId}/search/findUserProgress` |

**Frontend response shape:**
```json
{
  "completedSteps": [1, 2, 3],
  "points": 150,
  "badges": [{ "name": "Quick Start", "icon": "..." }]
}
```

**This is a CAP endpoint** — part of the new architecture replacing AEM. The CAP backend likely calls IMS internally (or will replace IMS's progress tracking for tutorials). The `slug`-based lookup is a key difference: IMS uses numeric `id` values, while the frontend uses URL slugs.

---

### 6. Mark Step Complete — CAP Backend (New)

| Layer | Detail |
|---|---|
| **Frontend call** | `POST /api/tutorials/{slug}/steps/{stepNumber}/complete` |
| **File** | `TutorialStep.vue:46` via `useApi().post()` |
| **Vite proxy** | → `http://localhost:4004/tutorials/{slug}/steps/{stepNumber}/complete` |
| **Backend** | **CAP backend** |
| **IMS equivalent** | `POST /task-records` with body: `{ "user": "/users/{id}", "task": "/tutorials/{taskId}", "status": "COMPLETED", "progress": 100, "taskType": "STEP" }` |

**The IMS pattern:** AEM currently calls `POST /task-records` to create a TaskRecord entity. This triggers IMS's event-driven cascading: `TutorialStatusCalculator` recalculates the tutorial's progress, then `GroupStatusCalculator` and `MissionStatusCalculator` cascade up the hierarchy. AEM also sends an Adobe Analytics event.

**CAP replacement:** The CAP backend should either call IMS's `/task-records` endpoint or implement equivalent cascade logic.

---

### 7. Mission Navigation Tree — CAP Backend (New)

| Layer | Detail |
|---|---|
| **Frontend call** | `GET /api/missions/{missionId}/navigation` |
| **File** | `MiniNavigator.vue:27` via `useApi().get()` |
| **Vite proxy** | → `http://localhost:4004/missions/{missionId}/navigation` |
| **Backend** | **CAP backend** |
| **IMS equivalent** | `GET /missions/{missionId}/completion-graph?userId={userId}` |
| | `GET /missions/{missionId}/export` |

**Frontend response shape:**
```json
{
  "context": [{
    "title": "Mission Title",
    "type": "mission",
    "progress": 75,
    "children": [{
      "title": "Group Title",
      "type": "group",
      "progress": 50,
      "children": [{
        "title": "Tutorial Title",
        "type": "tutorial",
        "slug": "tutorial-slug",
        "progress": 100,
        "url": "/tutorials/tutorial-slug"
      }]
    }]
  }]
}
```

**This replaces the miniNavigator AEM servlet.** The CAP backend serves the same hierarchical navigation data (Mission → Group → Tutorial) but is called via `/api/` rather than `/bin/sapdx/`.

---

### 8. Tutorial Catalog — Static Build Artifact

| Layer | Detail |
|---|---|
| **Frontend call** | `GET /tutorials/_nav.json` |
| **Files** | `TutorialNavigator.vue:64`, `TutorialNavigatorDropdown.vue:50`, `TutorialList.vue:18` |
| **Backend** | **None** — static file generated at build time |
| **IMS equivalent** | `GET /tutorials` (paginated list) |
| | `GET /groups` + `GET /missions` |

**This is entirely build-time.** The `fetch-tutorials.ts` script generates `_nav.json` from GitHub tutorial repos (not from IMS). IMS is not involved in the tutorial catalog at all in the new architecture — content comes from GitHub, not AEM/IMS.

---

## Summary: Migration Status

| # | Frontend Endpoint | Current Backend | IMS Dependency | Migration Status |
|---|---|---|---|---|
| 1 | `/bin/sapdx/v2/tutorial/miniNavigator.{id}.json` | AEM → IMS | Yes: completion-graph, task-records | **Replaced** by CAP `/api/missions/{id}/navigation` |
| 2 | `/bin/sapdx/tutorials/v3/progress/series?missionId={id}` | AEM → IMS | Yes: completion-graph, task-records, users | **Still AEM** — used by AppSpace.vue |
| 3 | `/bin/sapdx/v3/solr/search?json=...` | AEM Solr only | **No** — AEM content index | **Still AEM** — icon lookup, no IMS equivalent |
| 4 | `/bin/sapdx/github/qrcode?...` | AEM → IMS | Yes: prize-records | **Still AEM** — event-specific |
| 5 | `/api/tutorials/{slug}/progress` | CAP backend | TBD | **New** — CAP replaces AEM |
| 6 | `/api/tutorials/{slug}/steps/{n}/complete` | CAP backend | TBD | **New** — CAP replaces AEM |
| 7 | `/api/missions/{id}/navigation` | CAP backend | TBD | **New** — CAP replaces AEM |
| 8 | `/tutorials/_nav.json` | Static file | **No** | **New** — GitHub-sourced |

### IMS Endpoints Used by AEM (Summary)

These are the IMS REST endpoints that AEM's Sling servlets call internally:

| IMS Endpoint | Used By (AEM Servlet) | Purpose |
|---|---|---|
| `GET /missions/{id}/completion-graph?userId={id}` | miniNavigator, progressSeries | Mission hierarchy + user progress |
| `GET /task-records/search/findTaskProgressByUserAndTasksIds` | miniNavigator | Step-level progress |
| `GET /task-records/search/byUserAndTasks` | progressSeries | Bulk progress lookup |
| `POST /task-records` | Step completion flow | Record task done |
| `GET /users/resolve?accountNumber={acct}` | All authenticated calls | Map IDP session → IMS userId |
| `PATCH /prize-records/{id}` | QR code / prize claim | Update prize status |
| `GET /prize-records/findByUserAndPrizeIds` | Prize display | Check prize eligibility |

### What the CAP Backend Must Handle

For the CAP backend (localhost:4004) to fully replace AEM:

1. **User resolution** — Map authenticated user (XSUAA JWT) to IMS userId (or maintain its own user table)
2. **Progress reads** — `/tutorials/{slug}/progress` must resolve slug → IMS tutorial ID, then query task records
3. **Step completion** — `/tutorials/{slug}/steps/{n}/complete` must create IMS TaskRecord (or equivalent) and trigger cascading status updates
4. **Mission navigation** — `/missions/{id}/navigation` must build the Group → Tutorial tree with per-user progress
5. **Icon/metadata** — Mission icons currently from AEM Solr; need a new source (build-time metadata or a new field)
6. **Event features** — Progress series, QR codes, and prizes for App Space events still go through AEM

---

## ID Mapping: Slugs vs IMS IDs

A critical difference between the old and new architecture:

| System | Identifier | Example |
|---|---|---|
| IMS | Numeric `id` (Long) | `12345` |
| AEM | IMS ID passed through | `12345` |
| tutorials-frontend | URL `slug` (String) | `cp100-1-setup-btp-account` |

The frontend uses **slugs** derived from tutorial filenames/URLs. IMS uses **numeric IDs**. The CAP backend or a mapping table must bridge these. AEM had this mapping internally. The `imsId` field in the AEM responses is the IMS numeric ID — the frontend stores it in `AppSpaceItem.imsId` for use in QR code URLs and task-record calls.
