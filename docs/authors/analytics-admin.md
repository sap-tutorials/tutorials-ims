# Analytics Admin

Operational run-book for the analytics administrator — the role responsible for querying platform data, monitoring live events, and exporting compliance or business-intelligence datasets from the tutorial system.

## Persona summary

- **Role:** Analytics operator with read-only query access to platform data and export authority over the progress dataset.
- **Tools and access:**
  - `Tutorials Admin` or `Tutorials SuperAdmin` role collection in your BTP subaccount (scope: `Admin`) — required for all tasks in this guide.
  - Access to `/analytics-ui/` on the deployed app (Analytics Explorer Vue SPA).
  - Access to `/admin-ui/` on the deployed app (standard admin panel).
  - `GET /admin/exports/exportLegacyData?format=<csv|xlsx>` via browser or `curl` with a valid XSUAA bearer token.

---

### Task: Browse exposed entities

**Interval:** On demand

**Status:** Active

**Purpose and Objective:** Inspect the columns, data types, and a paged sample of any entity surfaced by `AnalyticsService`. Useful for understanding the data shape before writing an ad-hoc query or preparing an export request.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/analytics-ui/` on the deployed app

**Steps:**

1. Open `<approuter-url>/analytics-ui/` in your browser.
2. The **Explore** tab is selected by default. Click the **entity picker** (labelled "Select data source") at the top-left.
3. The picker lists every entity annotated with `@analytics : { exposed: true }` in `db/schema-ext.cds`. Frequently used starting points:

   | Entity | Label | Description |
   |---|---|---|
   | `CompletionAnalytics` | Completion analytics | Denormalized view of mission completions per user — one row per user per mission with task-level drill-down columns. Good for completion-rate queries. |
   | `ActiveLearnersDaily` | Active learners (daily) | Daily counts of users who completed at least one task — use for trend charts and event-day dashboards. |
   | `TaskRecords` | Task records | Raw completion log — one row per user per task with `status`, `completedAt`, and `eventId`. Use for participant-level queries; treat as PII-bearing. |

   Other exposed entities: `Tasks`, `NavigatorCatalog`, `SearchableItems`, `Users`, `Missions`, `Groups`, `Tutorials`, `Events`, `PrizeRecords`, `AccomplishmentRecords`.

4. Select an entity. The column list appears on the left. Drag a column to **Dimensions** or **Measures** to build a chart; the grid below updates automatically.
5. To inspect raw rows without aggregation, open the **SQL** tab and run `SELECT * FROM <EntityName> LIMIT 50` (see next task).

**Related:** [center-admin.md](center-admin.md) § Monitor a live event — for real-time views during an event day.

---

### Task: Run an ad-hoc SQL query

**Interval:** On demand

**Status:** Active

**Purpose and Objective:** Execute a hand-written SELECT against any exposed entity using the Monaco-powered SQL editor. Useful for one-off investigations, data-quality checks, and building example queries to share with the wider team.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/analytics-ui/` on the deployed app

**Steps:**

1. Open `<approuter-url>/analytics-ui/` and click the **SQL** tab.
2. The editor pre-fills `SELECT id, status FROM TaskRecords LIMIT 100`. Replace with your query.
3. The query is validated by `srv/lib/analytics-sql-validator.cjs` before execution. Constraints enforced server-side:
   - **SELECT only** — any DDL, DML (INSERT / UPDATE / DELETE), or stored-procedure call is rejected.
   - **Single statement** — semicolons and multi-statement payloads are rejected.
   - **No SQL comments** — `--` and `/*` are rejected.
   - **Table allowlist** — only tables listed in `@analytics.exposed` are permitted as FROM targets.
   - **Maximum length** — queries longer than 4 096 characters are rejected.
   - **Auto-wrapped LIMIT** — the server appends `LIMIT 5001` to your query (via a wrapping subquery). If 5 001 rows are returned, the result is truncated and the status bar shows "(truncated)".
4. Press **Run**. The status bar shows row count and duration. Results render in a scrollable table below the editor (first 200 rows are displayed; all 5 000 are available for charting).
5. To visualize results as a chart, press **Visualize** (appears after a successful run). The chart panel opens below; use the chart-type switcher to change the visualization.
6. There is no Save or CSV-export button in the SQL tab. To persist results, copy the query and re-run it via `curl` with `Content-Type: application/json` against `POST /admin/analytics/runSelectQuery`, then process the JSON response locally.

   Example `curl` export:
   ```bash
   curl -s -X POST \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"sql":"SELECT missionId, COUNT(*) AS completions FROM TaskRecords WHERE status='"'"'DONE'"'"' GROUP BY missionId ORDER BY completions DESC"}' \
     "https://<srv-url>/admin/analytics/runSelectQuery" \
     | jq -r '["missionId","completions"], (.value.rows[] | [.[0], .[1]]) | @csv'
   ```

**Related:** [center-admin.md](center-admin.md) § Review analytics views — for pre-built operational queries.

---

### Task: Export data via ExportsService

**Interval:** On demand (compliance requests, business reporting, data migration)

**Status:** Active

**Purpose and Objective:** Download the full progress dataset — tasks, task records, mission definitions, and step-failure logs — as a structured archive. Two formats are available: a ZIP of CSV files (one per table) and a single multi-sheet XLSX workbook.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- A valid XSUAA bearer token (obtainable via `cf oauth-token` or the BTP subaccount service key)

**Steps:**

1. Obtain a bearer token for the deployed approuter:
   ```bash
   TOKEN=$(cf oauth-token | sed 's/^bearer //i')
   ```

2. Download as CSV ZIP (streaming; suitable for large datasets and scripted processing):
   ```bash
   curl -o "export-csv-$(date +%Y%m%d).zip" \
     -H "Authorization: Bearer $TOKEN" \
     "https://<approuter-url>/admin/exports/exportLegacyData?format=csv"
   ```

   The server sets `Content-Disposition` automatically with a timestamped filename. The ZIP contains six CSV files:

   | Sheet / file | Contents |
   |---|---|
   | `TASK` | Tutorial / task catalog — titles, slugs, metadata |
   | `TASK_RECORD` | Per-user completion records — **PII-bearing** (user IDs + timestamps) |
   | `TASK_TO_PARENT` | Tutorial-to-mission membership mapping |
   | `COMPLETION_PATH` | Mission / completion-path definitions |
   | `COMPLETION_PATH_TO_TASK` | Mission-to-tutorial membership mapping |
   | `STEP_FAILURE` | Step-level quiz failure log |

3. Download as XLSX (single workbook, same six tables as sheets — convenient for manual review):
   ```bash
   curl -o "export-$(date +%Y%m%d).xlsx" \
     -H "Authorization: Bearer $TOKEN" \
     "https://<approuter-url>/admin/exports/exportLegacyData?format=xlsx"
   ```

4. **GDPR / data-handling notice:** The `TASK_RECORD` and `STEP_FAILURE` files contain user identifiers linked to tutorial completion history. Treat the downloaded archive as confidential personal data. Do not store it outside an approved secure channel and delete it once the purpose is served. If a data-subject erasure request arrives, see [center-admin.md](center-admin.md) § Anonymize a user before re-exporting.

5. The `ExportsService.exportLegacyData` OData action is deliberately disabled (returns HTTP 501). Use the GET bridge shown above — it is the sole supported download path.

**Related:** [center-admin.md](center-admin.md) § Anonymize a user — for GDPR erasure flow before or after an export.

---

### Task: Monitor a live event

**Interval:** During developer events (CodeJam, TechEd, Devtoberfest, etc.)

**Status:** Active

**Purpose and Objective:** Track real-time completion activity, prize-claim rate, and system health during a live event where attendees are actively working through tutorials. Data updates continuously via WebSocket without polling.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/analytics-ui/` on the deployed app
- Event created and activated in `/admin-ui/` (see [center-admin.md](center-admin.md) § Create and activate an Event)

**Steps:**

1. Open `<approuter-url>/analytics-ui/` and navigate to the **Explore** tab.
2. Select `ActiveLearnersDaily` to see a running count of participants who have completed at least one task today. Switch **Chart type** to **Line** for a trend view.
3. For completions-per-minute, run the following in the **SQL** tab (replace `<eventId>` with the active event's ID from `/admin-ui/` → Events):
   ```sql
   SELECT
     strftime('%H:%M', completedAt) AS minute,
     COUNT(*) AS completions
   FROM TaskRecords
   WHERE eventId = '<eventId>' AND status = 'DONE'
   GROUP BY minute
   ORDER BY minute DESC
   ```
4. Key real-time metrics to watch:

   | Metric | Entity / query | Notes |
   |---|---|---|
   | Active users today | `ActiveLearnersDaily` | Increments as each new user completes their first task |
   | Completions (total) | `TaskRecords WHERE status='DONE'` | All-time; filter by `eventId` for event scope |
   | Prize claim rate | `PrizeRecords WHERE status='CLAIMED'` | Compare to `PrizeRecords` total for unclaimed prizes |
   | Step failures | `TaskRecords WHERE status='FAILED'` | Spikes may indicate a broken tutorial step |

5. For the dedicated large-monitor display dashboard (rotating Board / Statistics / Leaderboard views), open `<approuter-url>/display-app/`. This app connects via Socket.IO on the `/ws/display` namespace (`DisplayService`) and receives push updates on every completion event. It does not require the `Admin` scope — it uses the `DisplayApp` scope.
6. The `EventStreamService` WebSocket namespace (`/ws/event-stream`) broadcasts raw CDS events to any subscriber and can be used for custom integrations. Both namespaces are `authenticationType: none` at the AppRouter level; scope enforcement happens at Socket.IO namespace join. See [testing-endpoints.md](../testing-endpoints.md) for the full route table.
7. If the display app shows stale data or the WebSocket disconnects, check `cf logs tutorials-srv --recent` for Socket.IO errors. A rolling restart (`cf restart tutorials-srv`) re-establishes the WebSocket bridge without requiring a redeploy.

**Related:** [center-admin.md](center-admin.md) § Create and activate an Event — for pre-event setup and post-event deactivation.

---

## Known gaps

| Gap | Status | Notes |
|---|---|---|
| Author-facing PowerBI / SAC views | Not available | No direct Power BI or SAP Analytics Cloud connector exists. Use `exportLegacyData` + local tooling as a workaround. |
| Streaming dashboards beyond DisplayService | Not built | `DisplayService` covers the event-monitor use case. General-purpose streaming analytics (e.g., Apache Kafka, live OData delta links) are not implemented. |
| Saved / named queries in the SQL tab | Not built | Queries are not persisted between sessions. Keep a local notepad or a shared team repo of frequently used SQL snippets. |

---

## See also

- [../historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md) — tasks from the previous run-book that have been retired or replaced
- [center-admin.md](center-admin.md) — operator-side coordination: event lifecycle, user anonymization, catalog management
- [../testing-endpoints.md](../testing-endpoints.md) — canonical endpoint reference including DisplayService dashboard routes and auth scopes
