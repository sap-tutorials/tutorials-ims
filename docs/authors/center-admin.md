# Center Admin

Operational manual for the developer center administrator — the operator role responsible for the catalog (groups, missions, events), content publishing, taxonomy, BTP user access, and pipeline health for the tutorial system.

## Persona summary

- **Role:** Day-to-day operator of the tutorial platform.
- **Tools and access:**
  - BTP subaccount admin (community-tools subaccount)
  - CF Space Developer in the prod space
  - GitHub admin in the `sap-tutorials` organization (granted via SAP OSPO)
  - "Tutorials Admin" role collection (scopes: `Admin`, `DisplayApp`, `DeveloperApp`, `Everyone`) — sufficient for day-to-day operations.
  - "Tutorials SuperAdmin" role collection (adds `SuperAdmin` scope) — required for destructive operations such as DB schema changes.
  - `CONTENT_API_KEY` env var value (held by the Center Admin team; required for `POST /content/publish` and `POST /content/rollback`)
  - Local clone of `tutorials-poc` for emergency operations and rebuilds

## Layout of this guide

The tasks below are grouped by concern:

- [Content & catalog ops](#content--catalog-ops)
- [Pipeline & operations](#pipeline--operations)
- [Access & identity](#access--identity)
- [Author support & coordination](#author-support--coordination)

A short [decommissioned-tasks.md](../historic/decommissioned-tasks.md) appendix maps tasks from the old run-book to their replacements.

---

## Content & catalog ops

### Task: Add / revise / delete a Group

- **Interval:** On demand
- **Status:** Active
- **Purpose and Objective:** Groups are thematic collections of tutorials that do not carry completion tracking. They appear as filtered views in the Tutorial Navigator. Every group needs a slug for the build pipeline to generate a page at `/group.<slug>`.

**Prerequisites:**
- `Tutorials Admin` role collection in BTP cockpit (scope: `Admin`)
- Access to `/admin-ui/` in the deployed app

**Steps:**

1. Navigate to `<approuter-url>/admin-ui/` and open the **Groups** tile.
2. To add: press **+** (Create). To revise: select the row and press **Edit**. To delete: select the row and press **Delete**.
3. Fill in or update:
   - **Title** — display name shown in the navigator.
   - **Description** — short paragraph surfaced on the group landing page.
   - **Slug** — URL segment used at `/group.<slug>`. Use only lowercase letters, digits, and `-` as word separators. Choose a prefix based on the primary product topic:

     | Primary topic | Prefix |
     |---|---|
     | Business Technology Platform | `btp` |
     | Integration Suite | `integration` |
     | ABAP | `abap` |
     | CAP | `cap` |
     | Kyma | `kyma` |
     | AI Business Suite | `ai` |
     | Joule Studio | `joule` |
     | SAP Build | `build` |

     Example: `btp-security-best-practices`.

   - **Tags** — link to taxonomy tags that have been imported (see [Task: Import a new tag from the SAP taxonomy](#task-import-a-new-tag-from-the-sap-taxonomy)).
   - **Tutorials** — ordered list of tutorial slugs belonging to the group.

4. Save. The change is now in HANA.
5. Trigger a content rebuild so Hugo regenerates the group page and the navigator catalog picks up the change:
   - GitHub → `tutorials-poc` → **Actions** → **Rebuild Content** → **Run workflow** → leave **slug** blank → choose environment → **Run workflow**.
6. Verify: `GET /build/catalog` returns the group with the new slug. The navigator at `/tutorial-navigator.html` reflects the update after the rebuild completes.

**Slug population check:** If after a fresh environment deploy group slugs are missing (the navigator shows numeric IDs), run:

```bash
cf login   # DEV space
npx cds bind --exec -- node scripts/setup-dev-data.cjs
```

**Related:**
- [repo-group-owners.md](repo-group-owners.md)
- [writing-tutorials.md](writing-tutorials.md)

---

### Task: Add / revise / delete a Mission

- **Interval:** On demand
- **Status:** Active
- **Purpose and Objective:** Missions are structured learning paths with completion tracking and badge/prize awards. A mission contains one or more **Completion Paths** (ordered sequences of tutorials). The build pipeline generates a page at `/mission/<slug>`.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/admin-ui/` — **Missions** tile

**Steps:**

1. Navigate to `/admin-ui/` → **Missions** tile.
2. To add: press **+** (Create). To revise: select the row and press **Edit**. To delete: select the row and press **Delete**.
3. Fill in:
   - **Title** and **Description** — shown on the mission landing page and in the navigator.
   - **Slug** — follows the same conventions as group slugs above.
   - **Completion Paths** — a mission may have multiple completion paths (e.g., one for Node.js, one for Java). Each path is an ordered list of tutorial slugs. Add paths via the **Completion Paths** sub-section.
   - **Tags** — taxonomy tags (same pool as groups).
   - **Accomplishments** — optional: link to an accomplishment record for badge awards on completion.

4. Save. Trigger a full rebuild (leave **slug** blank) so the navigator catalog and mission page are regenerated.
5. Verify: `GET /build/catalog` returns the mission with the correct slug and all paths populated.

**Slug population check:** Same as for groups — run `setup-dev-data.cjs` if slugs are blank after a fresh deploy.

**Related:**
- [repo-group-owners.md](repo-group-owners.md)

---

### Task: Define an App Space event

- **Interval:** Per-event
- **Status:** Active
- **Purpose and Objective:** App Space events configure the event-themed tutorial space (Joule/Sapphire/default visual themes, QR-code registration, real-time display dashboard). An event record links an event display to a mission and controls what is shown on the event monitor.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/admin-ui/` — **Events** tile
- Optional: `DisplayApp` scope to view the display dashboard at `/display-app/`

**Steps:**

1. Navigate to `/admin-ui/` → **Events** tile → **+** (Create).
2. Fill in:
   - **Event name**, **Start/End dates**, **Location**.
   - **Mission** — link the mission whose completion paths constitute the event curriculum.
   - **Theme** — choose `horizon` (default SAP Fundamental), `joule`, or `sapphire`. The display dashboard at `/display-app/?eventId=<id>&theme=<theme>` applies the corresponding palette.
   - **Active** — toggle on when the event goes live. Only one event should be active at a time for the AppSpace to display the correct theme.

3. **QR code generation:** After creating the event, retrieve the registration QR code:

   ```bash
   curl -s "<approuter-url>/api/qrcode?eventId=<event-id>" -o event-qr.png
   ```

   The `/api/qrcode` endpoint is unauthenticated and returns a PNG suitable for printing on name badges and banners.

4. **Event display (big monitors):** Open the display dashboard on the event monitor browser:

   ```
   <approuter-url>/display-app/?eventId=<id>&chartCount=6&theme=joule
   ```

   The dashboard connects via Socket.IO to `EventStreamService` on the `/ws/event-stream` namespace (anonymous WebSocket). It rotates through views (Board, Statistics, Leaderboard) automatically.

5. **Switching the live event:** To change which event is active mid-conference, update the **Active** flag in the admin UI. The display dashboard and AppSpace pick up the change in real-time via WebSocket without a page reload.

**Related:**
- [docs/developers/reference/theme-variants.md](../developers/reference/theme-variants.md) — detailed palette variables for Joule, Sapphire, and TechEd

---

### Task: Retire a tutorial (admin side)

- **Interval:** On demand
- **Status:** Active
- **Purpose and Objective:** Source-side retirement (removing the Markdown file from the `sap-tutorials` repo) is handled by the tutorial author. See [repo-group-owners.md#task-retire-a-tutorial](repo-group-owners.md#task-retire-a-tutorial). The admin's residual responsibility is to set up a redirect if the retired slug had meaningful production traffic.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/admin-ui/` — **Operations** tile and optionally the Analytics Explorer at `/analytics-ui/`

**Steps:**

1. Confirm whether the slug had production traffic. Check `/analytics-ui/` → SQL tab → query `CompletionAnalytics` or `Tasks` filtered by tutorial slug, or check with the Analytics Admin (see [analytics-admin.md](analytics-admin.md)).
2. If the slug had significant traffic:
   1. Navigate to `/admin-ui/` → **Operations** tile.
   2. Create a redirect rule mapping the old slug path to the successor tutorial or a relevant landing page.
   3. Save and verify the redirect resolves correctly in the deployed environment.
3. Confirm the publish pipeline has run since the Markdown was deleted. After the next rebuild, `GET /content/hashes` will no longer include the retired slug, and `/tutorials/<slug>` will return 404.

**Related:**
- [repo-group-owners.md#task-retire-a-tutorial](repo-group-owners.md#task-retire-a-tutorial)

---

### Task: Import a new tag from the SAP taxonomy

- **Interval:** On demand
- **Status:** Active
- **Purpose and Objective:** Tutorial authors reference taxonomy tags in frontmatter (`primary_tag`, `tags`). Tags not yet in the platform database will cause validation warnings during fetch. Adding a tag makes it available to the next build.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/admin-ui/` — **Tags** tile

**Steps:**

1. Obtain the tag details from the product owner making the request:
   - **ID** — machine-readable identifier (e.g., `software-product>sap-btp-build-code`).
   - **Name** — display label (e.g., `SAP BTP Build Code`).
   - **Parent tag** — the parent in the taxonomy hierarchy (e.g., `software-product`).
   - **Taxonomy URL** — link to the tag definition in the SAP taxonomy system (for reference).

2. Navigate to `/admin-ui/` → **Tags** tile → **+** (Create).
3. Enter the ID, name, parent, and taxonomy URL. Save.
4. The tag is immediately available in the HANA catalog. On the next `npm run fetch-tutorials` (or full rebuild), the fetch script reads the catalog feed and resolves the tag against the database — authors' tutorials referencing it will validate without warnings.
5. Notify the requesting author that the tag is live.

**Related:**

- [writing-tutorials.md](writing-tutorials.md) — frontmatter field reference for `primary_tag` and `tags`

---

### Task: Force-rebuild content

- **Interval:** On demand (after catalog changes, emergency refreshes, single-tutorial fixes)
- **Status:** Active
- **Purpose and Objective:** Trigger the CI pipeline to re-fetch tutorial Markdown from GitHub, rebuild Hugo, and publish updated HTML BLOBs to HANA. Use a full rebuild for catalog changes; use a single-slug rebuild for isolated tutorial fixes.

**Prerequisites:**
- Write access to the `tutorials-poc` GitHub repository
- CI secrets already configured (`CONTENT_API_KEY`, `TUTORIALS_APP_ID` / `TUTORIALS_APP_PRIVATE_KEY` or `TUTORIALS_GITHUB_TOKEN`)

**Steps — full rebuild:**

1. GitHub → `tutorials-poc` → **Actions** → **Rebuild Content** → **Run workflow**.
2. Choose **environment** (`dev`, `qa`, or `prod`).
3. Leave **slug** blank.
4. Press **Run workflow**.

The pipeline: fetches all tutorials from GitHub → generates Hugo pages → builds Hugo → publishes all changed HTML BLOBs to HANA via `POST /content/publish --force`.

**Steps — single-tutorial refresh:**

1. Same as above, but fill in the **slug** field (e.g., `abap-cloud-ui-from-interface`).
2. The fetch step busts only that slug's markdown cache and regenerates from cache for the rest.

> **Important:** Single-slug runs skip the HANA `RepoCatalog` upload (the discovery baseline is a production artifact). Do **not** use a single-slug run when group or mission metadata has also changed — use a full rebuild in that case.

**Related:**
- [build.md](../developers/architecture/build.md)

---

### Task: Content rollback

- **Interval:** On demand (after a bad publish; before a corrective PR is merged)
- **Status:** Active
- **Purpose and Objective:** Revert the active content manifest to the previous version. This does not undo the source Markdown — it only moves the manifest pointer so `/tutorials/*` serves the prior HANA BLOB set. A corrective PR to the source repo should follow.

**Prerequisites:**
- `CONTENT_API_KEY` value
- `curl` or equivalent HTTP client
- Deployed CAP srv URL

**Steps:**

1. Confirm the manifest is in a bad state:

   ```bash
   # Check active manifest status
   curl -s "$CAP_BASE_URL/content/hashes" | python3 -c \
     "import sys,json; d=json.load(sys.stdin); print(f'{len(d)} slugs in active manifest')"
   ```

2. Trigger rollback:

   ```bash
   curl -s -X POST "$CAP_BASE_URL/content/rollback" \
     -H "Authorization: Bearer $CONTENT_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

   Expected response: `{ "rolledBackTo": <version>, "status": "ACTIVE" }`.

   If the response is `404 No rollback target found`, there is no prior `ACTIVE` or `SUPERSEDED` manifest to revert to — escalate to a full rebuild.

3. Verify: `/tutorials/<affected-slug>` now serves the previous version.
4. Open a corrective PR in the relevant `sap-tutorials` repo to fix the source Markdown. After it merges, the `repository_dispatch` trigger fires `rebuild-content.yml` automatically.

> **What rollback does not do:** It does not touch source Markdown. It moves the manifest pointer in HANA — the next full rebuild overwrites it again. If the bad content is in the source, fix the source first.

**Related:**
- [build.md](../developers/architecture/build.md)
- [testing-endpoints.md](../testing-endpoints.md)

---

## Pipeline & operations

### Task: Monitor the publish pipeline

- **Interval:** Daily / after deploys
- **Status:** Active
- **Purpose and Objective:** Catch failed publishes, stalled jobs, and HANA errors before they affect readers.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- CF Space Developer in prod space (for Cloud Logging)

**Steps:**

1. **Admin UI pipeline logs:** Navigate to `/admin-ui/` → **Operations** tile → **Pipeline Logs** tab. Each workflow run has a row. The `cfLogsUrl` virtual field in each log row opens SAP Cloud Logging pre-filtered to a ±30-second window around the run — click it for detailed server-side traces.

2. **GitHub Actions:** GitHub → `tutorials-poc` → **Actions** → filter by **Rebuild Content** or **Deploy**. Red runs need investigation.

3. **Smoke tests:** After any deploy, the CI pipeline automatically runs smoke tests. Check the Actions run summary for smoke-test results. Key smoke targets include:
   - `GET /health` and `GET /health/db` — liveness and HANA connectivity.
   - `GET /build/catalog` — catalog availability.
   - `GET /content/hashes` — active manifest present.
   - `GET /tutorials/<canonical-slug>` — BLOB serving.

4. **Content GC:** A daily cron job at 03:00 prunes `SUPERSEDED` and `ROLLED_BACK` content manifest versions older than 7 days (keeping the three most recent for rollback). No action needed unless the job shows errors in the Pipeline Logs.

**Related:**
- [testing-endpoints.md](../testing-endpoints.md)

---

### Task: Pipeline incident playbook

- **Interval:** On demand
- **Status:** Active
- **Purpose and Objective:** Reference table for diagnosing common failure modes quickly.

**Prerequisites:**
- CF Space Developer in prod
- Access to GitHub Actions on `tutorials-poc`
- `CONTENT_API_KEY` for rollback operations

| Symptom | Likely cause | First check | Fix |
|---|---|---|---|
| Author's PR merged but content not live after 15 min | `repository_dispatch` from the source repo did not reach `tutorials-poc` | Source repo Actions tab — check whether the dispatch step ran and what HTTP status it received | Verify `TUTORIALS_DISPATCH_TOKEN` secret on the source repo (e.g., `sap-tutorials/abap-core-development`) is still valid; rotate if expired |
| All publishes failing with HANA LOB errors | A recent code change is SELECTing a BLOB column alongside metadata in a single CDS QL query, triggering locator expiry | `cfLogsUrl` on the failing Pipeline Log row — look for `LOB locator expired` or `invalid locator handle` | In `srv/lib/content-store.js` (or whichever handler regressed), split the query: use `db.run()` raw SQL for BLOB retrieval, and a separate CDS QL query for metadata — never mix them in a single `SELECT` on HANA |
| Manifest stuck in `PUBLISHING` status | Publish job crashed mid-run (network timeout, OOM, pod restart) leaving the manifest in a non-`ACTIVE` state | `GET /content/hashes` returns an error or empty; Pipeline Log shows status `PUBLISHING` with no `ACTIVE` follow-up | Run `POST /content/rollback` (see [Task: Content rollback](#task-content-rollback)) to revert to the previous manifest; then trigger a full rebuild |
| GitHub rate-limit errors during fetch | Too many cold builds without a valid GitHub token | Actions log — look for `403 rate limit exceeded` from GitHub API calls | Ensure `TUTORIALS_APP_ID` + `TUTORIALS_APP_PRIVATE_KEY` secrets are set on `tutorials-poc` (preferred — generates short-lived app tokens); fallback is `TUTORIALS_GITHUB_TOKEN` PAT |
| `/tutorials/<slug>` returns 404 after rebuild | Slug not in the active manifest (BLOB never published for it) | `GET /content/hashes` — check whether the slug appears | Run a single-slug rebuild with that slug; if the tutorial source was deleted, the 404 is expected — set up a redirect via the Operations admin app |
| Smoke tests failing on `/build/catalog` | CAP srv is down or HANA binding is broken | `GET /health/db` — check HANA status | Check CF app status (`cf app tutorials-srv`); restart if crashed; check HANA Cloud instance status in BTP cockpit |
| Admin UI shows no data / OData 401 | XSUAA token expired or role-collection missing | `/auth/user` endpoint — check `scopes` array | Assign the correct role collection in BTP cockpit; wait for token expiry (or log out and back in) |

**Related:**

- [Monitor the publish pipeline](#task-monitor-the-publish-pipeline) — daily health checks and Pipeline Log access
- [build.md](../developers/architecture/build.md) — deep-dive on the fetch → Hugo → publish pipeline

---

### Task: Backup and recovery

- **Interval:** Quarterly (restore-test); automated (backup)
- **Status:** Active
- **Purpose and Objective:** HANA Cloud provides automated point-in-time recovery within its retention window. The `ExportsService` provides logical exports of tutorials, users, and progress for off-system archiving.

**Prerequisites:**
- BTP subaccount admin (to access HANA Cloud backup controls in BTP cockpit)
- `Tutorials Admin` role collection (for `ExportsService` logical exports)

**Automated HANA Cloud backups:**

SAP HANA Cloud performs continuous incremental backups automatically. Point-in-time recovery is available from:

```
https://cockpit.btp.cloud.sap → your subaccount → SAP HANA Cloud → <instance> → Manage HANA Cloud
```

The retention window and recovery options depend on your HANA Cloud service plan. Recovery restores the entire instance — coordinate with the team before initiating.

**Logical exports via ExportsService:**

The `ExportsService` at `/admin/exports` exposes a streaming download action:

```bash
# Export as CSV (requires Admin scope — use a BTP-authenticated session or cf ssh + curl with XSUAA token)
GET /admin/exports/exportLegacyData?format=csv
GET /admin/exports/exportLegacyData?format=xlsx
```

This covers tutorial progress records and user data. Use for off-system archiving or pre-migration snapshots. The export is streamed and may be large for the full production dataset.

**Restore-test cadence:**

Quarterly, perform a restore-test into a dev or sandbox HANA Cloud instance. Verify that:
1. The instance restores to a consistent state.
2. `GET /health/db` returns OK after binding the restored instance.
3. `GET /build/catalog` returns the expected missions and groups.
4. A smoke test run passes against the restored environment.

Document the result (date, duration, success/fail) in the team's incident log.

**Related:**

- [mta-deployment.md](../mta-deployment.md) — MTA build and CF deploy reference, including HANA binding setup
- [analytics-admin.md](analytics-admin.md) — Export data action for logical off-system archiving

---

## Access & identity

### Task: Add a user to the system

- **Interval:** On demand
- **Status:** Active
- **Purpose and Objective:** Grant a new user the correct role collection for their persona. All access is via XSUAA role collections assigned in BTP cockpit — there are no local user stores.

**Prerequisites:**
- BTP subaccount admin rights on the community-tools subaccount

**Role collections and their purpose (from `xs-security.json`):**

| Role collection | Included scopes | Typical assignee |
|---|---|---|
| `Tutorials Admin` | `Admin`, `DisplayApp`, `DeveloperApp`, `Everyone` | Center Admin team members |
| `Tutorials SuperAdmin` | `SuperAdmin`, `Admin`, `DisplayApp`, `DeveloperApp`, `Everyone` | Elevated operators (publish/unpublish, rollback) |
| `Tutorials Developer` | `DeveloperApp`, `Everyone` | Internal developer tooling / service accounts |
| `Tutorials Display` | `DisplayApp`, `Everyone` | Event-monitor screens (read-only) |
| `Tutorials Author` | `Tutorial.Author`, `Everyone` | Tutorial authors who need access to the QA preview channel (`/tutorials-qa/*`) |

**Steps:**

1. Go to `https://cockpit.btp.cloud.sap` → your subaccount.
2. In the left menu, navigate to **Security** → **Users**.
3. Search for the user by email address or SAP ID. If the user does not exist yet, press **Create** and enter their email.
4. Click the **>** arrow at the right of the user's row to open the user detail.
5. Click on **Role Collections** → **Assign Role Collection**.
6. Select the appropriate role collection from the table above and confirm.

> **Note:** Users assigned `Tutorials Author` gain access to the QA preview channel at `/tutorials-qa/*` only. They cannot create or modify catalog records. For repo group owner registration, see [repo-group-owners.md](repo-group-owners.md).

**Related:**
- [authentication.md](../developers/architecture/authentication.md)
- [repo-group-owners.md](repo-group-owners.md)

---

### Task: Anonymize a user (GDPR / DSR)

- **Interval:** On demand (Data Subject Requests)
- **Status:** Active
- **Purpose and Objective:** Fulfill a GDPR right-to-erasure request by anonymizing all personally identifiable information for a user while preserving anonymized completion records for analytics integrity.

**Prerequisites:**
- `Tutorials Admin` role collection (scope: `Admin`)
- Access to `/admin-ui/` — **Accounts** tile
- The user's SAP ID or DSR request number

**What gets anonymized:**
- Name, email address, account number (replaced with an opaque token).

**What is preserved:**
- Anonymized completion records (task records remain linked to an anonymous identity — no PII, but aggregate analytics remain accurate).

**What is emitted:**
- A `SecurityEvent` audit log entry (via `@cap-js/audit-logging`) is written for every anonymization action. This is required for GDPR compliance and is visible in the SAP Audit Log Service connected to the subaccount.

**Steps:**

1. Navigate to `/admin-ui/` → **Accounts** tile.
2. Search for the user by SAP ID or email.
3. Open the user detail and locate the **Privacy** section.
4. Press **Anonymize User**. Confirm the dialog.
   - Alternatively, for a formal DSR request with a request number: use the **Anonymize by DSR Request** action and supply the DSR request number. This links the anonymization event to the request for audit trail purposes.
5. Verify: the user's record now shows anonymized fields. The `SecurityEvent` entry appears in the audit log within seconds.

> **Do not delete the record.** Deletion removes the completion history. Anonymization is the correct GDPR response — PII is removed but the record structure is preserved for analytics.

**Related:**

- [authentication.md](../developers/architecture/authentication.md) — XSUAA, BTP identity, and audit-logging setup
- [Add a user to the system](#task-add-a-user-to-the-system) — role collection assignment reference (Task 11)

---

## Author support & coordination

### Task: Handle author support requests

- **Interval:** As needed
- **Status:** Stub
- **Purpose and Objective:** Provide guidance to tutorial authors on taxonomy, access, preview deploys, and authoring best practices. The Center Admin is the first escalation point for authors who cannot resolve an issue with the standard [writing-tutorials.md](writing-tutorials.md) guide or their repo group owner.

> **Note (Stub):** The intake channel for author support is currently internal Slack and GitHub Issues on `tutorials-poc`. This task will be updated once a formal support channel and SLA are established.

**Prerequisites:**
- Familiarity with [writing-tutorials.md](writing-tutorials.md) and [repo-group-owners.md](repo-group-owners.md)
- `Tutorials Admin` role collection (for access/tag operations on behalf of authors)

**Common request types and responses:**

| Request | Response |
|---|---|
| "My tag isn't recognized by the validator" | Import the tag: [Task: Import a new tag from the SAP taxonomy](#task-import-a-new-tag-from-the-sap-taxonomy) |
| "I can't see my tutorial after merge" | Check the rebuild pipeline — did `rebuild-content.yml` fire? Check the source repo's `dispatch` step in Actions. |
| "I need access to the QA preview channel" | Assign `Tutorials Author` role collection in BTP cockpit: [Task: Add a user to the system](#task-add-a-user-to-the-system) |
| "I need to move a tutorial to a different repo" | Direct to repo group owners: [repo-group-owners.md#task-migrate-a-tutorial-to-another-repository](repo-group-owners.md#task-migrate-a-tutorial-to-another-repository) |
| "My tutorial has a broken image after merge" | Confirm image path convention in [writing-tutorials.md](writing-tutorials.md) §3.4; if path is correct, trigger a single-slug rebuild |

**Escalation paths:**
- Technical platform issues → open a GitHub Issue on `tutorials-poc` with the `platform` label.
- Product taxonomy questions → route to the product owner or SAP taxonomy team.
- GitHub org access → route to SAP OSPO.

**Related:**

- [writing-tutorials.md](writing-tutorials.md) — the primary authoring reference authors should consult first
- [repo-group-owners.md](repo-group-owners.md) — repo group owner responsibilities and escalation paths

---

### Task: Maintain the repo group owner list

- **Interval:** On demand (when an owner changes)
- **Status:** Active
- **Purpose and Objective:** Keep two records in sync: the JSON file in `tutorial-checker` (used by the CI lint tool) and the Accounts records in the admin UI (used for in-app contact lookups and author support routing).

**Prerequisites:**
- Write access to `sap-tutorials/tutorial-checker`
- `Tutorials Admin` role collection (for admin UI Accounts edits)

**Two sources of truth:**

1. **`sap-tutorials/tutorial-checker/data/repository.owner.json`** — the canonical list. Each top-level key is a repository group name; the value object has `name` (GitHub username) and `email` (SAP email). This file drives CI checks and contact lookups.

2. **Admin UI Accounts app** — `/admin-ui/` → **Accounts** tile — holds the platform-side owner record linked to a user's SAP ID and role collection.

**Steps:**

1. When an owner changes, update `repository.owner.json` in a PR to `sap-tutorials/tutorial-checker`.
2. Also update the corresponding record in the admin UI Accounts app to reflect the new owner's SAP ID.
3. If the outgoing owner held the `Tutorial.Author` QA scope, remove the `Tutorials Author` role collection from their BTP user. Assign it to the incoming owner.
4. Notify the new owner of their responsibilities: link to [repo-group-owners.md](repo-group-owners.md).

**Related:**
- [repo-group-owners.md#task-designate-or-change-a-repository-group-owner](repo-group-owners.md#task-designate-or-change-a-repository-group-owner)

---

### Task: Conduct author office hours

- **Interval:** Monthly (suggested)
- **Status:** Stub
- **Purpose and Objective:** A recurring touchpoint where tutorial authors can ask questions, get live help with authoring issues, and stay current on platform changes. Helps surface recurring pain points before they become support tickets.

> **Note (Stub):** The cadence and format below are recommended starting points. Adjust based on team availability and author community size.

**Prerequisites:**
- Meeting facilitation access (calendar invite, video call link)
- Prepared agenda template (see below)

**Suggested cadence:** Monthly, 60 minutes. Schedule in the first or second week of the month to give time to action items before month-end.

**Agenda template:**

```
Author Office Hours — <Month YYYY>

1. Catalog status (5 min)
   - New groups / missions added this month
   - Upcoming taxonomy changes

2. Platform updates (10 min)
   - Relevant changes to writing-tutorials.md since last session
   - Any tooling or pipeline changes authors should know about

3. Author Q&A (30 min)
   - Open floor for authoring questions
   - Live demos of new features if applicable

4. Action items review (10 min)
   - Review open items from previous session
   - Assign new action items

5. AOB / Next session date (5 min)
```

**Tips:**
- Record the session if authors in other time zones cannot attend.
- Post a written summary as a GitHub Discussion or internal Slack message after each session.
- Track recurring questions — if the same question comes up twice, update [writing-tutorials.md](writing-tutorials.md).

**Related:**

- [Handle author support requests](#task-handle-author-support-requests) — common request types and escalation paths (Task 13)
- [repo-group-owners.md#task-office-hours-and-author-support-intake](repo-group-owners.md#task-office-hours-and-author-support-intake) — repo group owner perspective on office hours

---

## See also

- [decommissioned-tasks.md](../historic/decommissioned-tasks.md) — tasks from the old run-book that have been replaced or removed
- [analytics-admin.md](analytics-admin.md) — analytics platform operations (tutorial engagement, query explorer)
- [build.md](../developers/architecture/build.md) — deep-dive on the fetch → Hugo → publish pipeline
- [mta-deployment.md](../mta-deployment.md) — MTA build and CF deploy reference
- [authentication.md](../developers/architecture/authentication.md) — XSUAA, BTP identity, AppRouter auth flows
- [testing-endpoints.md](../testing-endpoints.md) — canonical endpoint reference with auth/scope mapping
