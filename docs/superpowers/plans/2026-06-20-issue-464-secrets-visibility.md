# Phase 2-B Secrets Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Secrets` HANA entity that tracks credential metadata (no values) + a daily expiry-check cron + a notifications-popover live feed of expiring secrets, establishing the list-shaped admin tile pattern for future runtime-config phases.

**Architecture:** New CDS entity in `db/schema.cds` (7 columns, no encrypted-value fields — Phase 2-C #465 adds those). Self-contained cron at `srv/jobs/secret-expiry-check.js` with stateless severity classification (no per-row state in schema; popover queries live). New AdminService unbound function `secretWarnings()` returns severity-tiered + sorted warnings. Custom-XML admin tile at `app/admin/secrets/` mirrors the kg-settings pattern (singleton-config style applied to a list with sap.m.Table + dialog fragment). Admin-shell wiring: 5 locations (manifest componentUsages/target/route, copy-components.js, Shell.view.xml side-nav, Shell.view.xml notifications popover binding, Shell.controller.js NAV maps + onNotificationsPress fetch). One-shot seed script at `scripts/seed-secrets.cjs` for the 6 known tracked secrets.

**Tech Stack:** SAP CAP Node.js, HANA Cloud, Vitest (unit only — no hybrid this PR), UI5 (custom XML, sap.m), `@cap-js/change-tracking`, native `node-cron` (already a dep via scheduler.js).

**Spec:** [docs/superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md](../specs/2026-06-20-issue-464-secrets-visibility-design.md)

**Branch:** `worktree-issue-464-secrets-visibility` (already checked out in worktree).

---

## Worktree context warning

**This worktree branched from main BEFORE PR #471 (Phase 2-A foundation) merged.** Therefore:

- `KnowledgeGraphSettings` does NOT exist in `db/schema.cds` here. The new `Secrets` entity gets appended at the **end** of `db/schema.cds`, NOT "after KnowledgeGraphSettings."
- `knowledgeGraph` is NOT in `app/admin-shell/scripts/copy-components.js` here. The new `'secrets'` entry gets appended at the **end** of the COMPONENTS array, NOT "between joule and feedback."
- `Shell.controller.js` NAV_KEY_TO_ROUTE / NAV_KEY_TO_TITLE maps do NOT have `knowledgeGraph` here. The new `secrets:` entries follow the existing alphabetical/logical ordering (place near `joule:` since both are System-group config tiles).

If the implementer sees `KnowledgeGraphSettings` in this worktree, the worktree was rebased onto main after #471 merged. In that case, the plan's anchors still work — just with #463's content already present. **No edits required either way; the appendable patterns work in both worktree states.**

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `db/schema.cds` | Modify (append at end-of-file) | Define `Secrets` entity with `@assert.unique.key` annotation |
| `db/data/com.sap.developers.ims-Secrets.csv` | Create | HEADER ONLY — empty seed (per [feedback_cap_csv_seeds_clobber_admin_data]) |
| `db/change-tracking.cds` | Modify (append at end-of-file) | `annotate ims.Secrets with @changelog;` |
| `srv/admin-service.cds` | Modify (append before service-block closing `}`) | `Secrets` projection + `secretWarnings()` function |
| `srv/admin-service.js` | Modify (append before `await super.init();` at ~line 984) | `this.on('secretWarnings', ...)` handler |
| `srv/jobs/secret-expiry-check.js` | Create | Cron job (~70 lines): exports `daysUntil`, `classifySeverity`, `runSecretExpiryCheck` |
| `srv/jobs/scheduler.js` | Modify (append cron registration in `registerJobs()`) | `cron.schedule('11 4 * * *', ...)` |
| `scripts/seed-secrets.cjs` | Create | One-shot idempotent INSERT of 6 known secrets |
| `app/admin/secrets/webapp/manifest.json` | Create | UI5 component manifest, sap.m only |
| `app/admin/secrets/webapp/Component.js` | Create | UI5 component shell |
| `app/admin/secrets/webapp/index.html` | Create | UI5 boot HTML |
| `app/admin/secrets/webapp/view/Secrets.view.xml` | Create | Table + Add/Refresh toolbar; row Edit/Delete buttons |
| `app/admin/secrets/webapp/view/SecretDialog.fragment.xml` | Create | Reusable Add/Edit dialog form |
| `app/admin/secrets/webapp/controller/Secrets.controller.js` | Create | Load/Save/Delete + dialog lifecycle (~150 lines) |
| `app/admin/secrets/webapp/i18n/i18n.properties` | Create | Tile-local labels |
| `app/admin-shell/scripts/copy-components.js` | Modify (append `'secrets'` to COMPONENTS array) | Wire tile into admin-shell `dist/components/` |
| `app/admin-shell/webapp/manifest.json` | Modify (4 sub-locations) | componentUsages + target component-usage + target route-target + route + i18n model registration |
| `app/admin-shell/webapp/view/Shell.view.xml` | Modify (2 sub-locations) | NavigationListItem in System group + popover bound List |
| `app/admin-shell/webapp/controller/Shell.controller.js` | Modify (3 sub-locations) | NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE entries + onNotificationsPress fetch |
| `app/admin-shell/webapp/i18n/i18n.properties` | Create (FIRST i18n bundle for admin-shell) | `notificationsEmpty=...` |
| `.deploy/mta.yaml` | Modify (line 97) | DEFENSIVELY add `cp ../../srv/jobs/secret-expiry-check.js srv/jobs/` to srv-qa cp chain |
| `test/unit/jobs/secret-expiry-check.test.js` | Create | 6 unit tests |
| `docs/developers/operations/secrets-tracking.md` | Create | Operations doc: how to add tracked secrets, how warnings surface |

---

## Pre-flight checklist

- [ ] **Step 0.1: Confirm working in the worktree, not the parent repo**

  Run:

  ```bash
  pwd
  git branch --show-current
  ```

  Expected: working directory ends in `.claude/worktrees/issue-464-secrets-visibility`, branch is `worktree-issue-464-secrets-visibility`.

  If wrong: STOP. Re-enter the worktree before any edits ([feedback_subagent_writes_can_leak_to_parent_repo]).

- [ ] **Step 0.2: Verify spec is committed in branch history**

  Run:

  ```bash
  git log --oneline -10 | grep -E 'docs.*spec.*#464'
  ```

  Expected: at least one match showing the Phase 2-B spec was committed (e.g. `docs(spec): Phase 2-B secrets visibility metadata-only design (#464)` and the iter-2 corrections commit).

- [ ] **Step 0.3: Confirm cron + scheduler precedent at HEAD**

  Run:

  ```bash
  test -f srv/jobs/scheduler.js && echo OK
  test -f srv/jobs/cleanup.js && echo OK
  ```

  Expected: two `OK` lines. Plan references these as cron-pattern templates.

- [ ] **Step 0.4: Confirm Joule admin tile precedent at HEAD**

  Run:

  ```bash
  test -f app/admin/joule/webapp/manifest.json && echo OK
  test -f app/admin/joule/webapp/controller/Settings.controller.js && echo OK
  ```

  Expected: two `OK` lines. Plan references these as the custom-XML tile template + CSRF round-trip template.

---

## Task 1: Define `Secrets` schema entity

**Files:**

- Modify: `db/schema.cds` (append at end-of-file — entity does NOT need to follow any specific neighbor)

- [ ] **Step 1.1: Verify schema.cds line count and last entity**

  Run:

  ```bash
  tail -5 db/schema.cds
  wc -l db/schema.cds
  ```

  Note the line count. The new entity goes at the **very end** of the file (after the last existing entity's closing `}`).

- [ ] **Step 1.2: Append the Secrets entity**

  Append to `db/schema.cds` at end-of-file:

  ```cds


  // Phase 2-B (#464): Secrets-visibility metadata-only inventory.
  // Tracks WHAT credentials exist, WHEN they expire, WHO owns rotation.
  // Does NOT store secret values — those stay in CF env / mtaext / GH Actions
  // secrets. Phase 2-C (#465) will add encryptedValue + encryptionKeyId
  // columns once the encryption-key management decision is made.
  //
  // Daily cron (srv/jobs/secret-expiry-check.js, 04:11 UTC) computes
  // days-remaining and surfaces warnings via /admin/secretWarnings() ↦
  // admin-shell notifications popover.
  //
  // CSV seed at db/data/...-Secrets.csv MUST stay empty per the
  // HDI-clobbers-admin-edits footgun ([feedback_cap_csv_seeds_clobber_admin_data]).
  // Initial seeding is a one-shot script: scripts/seed-secrets.cjs.
  @assert.unique.key : [![key]]
  entity Secrets : cuid, managed {
    ![key]              : String(120);
    description         : String(500);
    kind                : String(40);
    rotationOwner       : String(120);
    rotationDocsUrl     : String(500);
    expiresAt           : Date;
    lastRotatedAt       : Timestamp;
  }
  ```

  **Notes:**
  - `![key]` escapes the CDS reserved word `key`. The column itself is `String(120)`, NOT a primary key — `cuid` already provides `ID : UUID`.
  - `@assert.unique.key : [![key]]` uses the entity-level **named** form matching the existing 4 patterns at lines 28, 47, 64, 298 (`@assert.unique.slug:[slug]` etc.). Generates a deterministic HANA constraint name.
  - All columns are nullable (no `default` clauses). `expiresAt: null` means "never expires" — cron treats null as silent.

- [ ] **Step 1.3: Verify schema compiles**

  Run:

  ```bash
  npx cds compile db/schema.cds > /dev/null && echo OK
  ```

  Expected: `OK`. If `@assert.unique.key` syntax errors, try alternative form:

  ```cds
  @assert.unique.key : [key]
  ```

  (without the `![key]` escape inside the array — the `![]` is for declaring a column with reserved-word name; references inside annotations may not need it.)

- [ ] **Step 1.4: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(db): add Secrets metadata-only entity (#464)

  Tracks credential metadata only — values stay in CF env / mtaext /
  GH Actions secrets. Phase 2-C (#465) will add encryptedValue +
  encryptionKeyId columns once the encryption-key management decision
  is made.

  All columns nullable; expiresAt null means 'never expires' (cron
  treats as silent). @assert.unique.key uses the named entity-level
  form matching existing patterns at lines 28, 47, 64, 298."
  ```

---

## Task 2: Create empty CSV seed

**Files:**

- Create: `db/data/com.sap.developers.ims-Secrets.csv`

- [ ] **Step 2.1: Verify the existing data/ pattern**

  Run:

  ```bash
  ls db/data/ | head -5
  cat db/data/com.sap.developers.ims-Categories.csv | head -3
  ```

  Confirm filename pattern (`com.sap.developers.ims-<EntityName>.csv`) and `;` separator.

- [ ] **Step 2.2: Create empty CSV (header only)**

  Write to `db/data/com.sap.developers.ims-Secrets.csv`:

  ```csv
  ID;key;description;kind;rotationOwner;rotationDocsUrl;expiresAt;lastRotatedAt
  ```

  Single line with newline. **MUST stay empty** per [feedback_cap_csv_seeds_clobber_admin_data].

- [ ] **Step 2.3: Commit**

  ```bash
  git add db/data/com.sap.developers.ims-Secrets.csv
  git commit -m "feat(db): empty CSV seed for Secrets (#464)

  Header-only by design. HDI re-imports CSVs as UPSERT on every
  deploy; a non-empty seed would clobber admin-edited values
  (expiresAt, lastRotatedAt, rotationOwner). Initial seeding is a
  one-shot script: scripts/seed-secrets.cjs."
  ```

---

## Task 3: Add change-tracking annotation

**Files:**

- Modify: `db/change-tracking.cds` (append at end-of-file)

- [ ] **Step 3.1: Add the annotation**

  Append to `db/change-tracking.cds` at end-of-file:

  ```cds

  // Phase 2-B (#464): track admin edits to tracked-secret metadata
  // (description, expiresAt, rotationOwner). Surfaces in /admin-ui/#changelog-display.
  annotate ims.Secrets with @changelog;
  ```

  Plain `@changelog` (not `@changelog: ['col1', 'col2']`) tracks all column changes.

- [ ] **Step 3.2: Verify the annotation compiles in context**

  Run:

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`. (admin-service.cds includes change-tracking.cds transitively.)

- [ ] **Step 3.3: Commit**

  ```bash
  git add db/change-tracking.cds
  git commit -m "feat(db): change-tracking on Secrets (#464)

  Mirrors the existing pattern. Mutations appear in the ChangeLog
  entity, viewable at /admin-ui/#changelog-display."
  ```

---

## Task 4: Add AdminService projection + `secretWarnings()` function

**Files:**

- Modify: `srv/admin-service.cds` (append before the service block's closing `}`)

- [ ] **Step 4.1: Verify the service block boundary**

  Run:

  ```bash
  tail -5 srv/admin-service.cds
  ```

  Confirm the file ends with `}` (the closing brace of the service block). The new projection + function go just before that closing brace.

- [ ] **Step 4.2: Add the projection + function**

  Use Edit tool. Anchor on the closing `}` of the service block. Insert before it:

  ```cds

    // Phase 2-B (#464): Secrets-visibility metadata-only.
    // Full CRUD over tracked-secret rows. NOT @odata.singleton — this is a list,
    // not a singleton (unlike ChatSettings / KnowledgeGraphSettings).
    @requires: 'Admin'
    entity Secrets as projection on ims.Secrets;

    // Severity-classified expiry warnings, used by the admin-shell notifications
    // popover. Read-only function (NOT action) — invokable via GET; no CSRF
    // token required for the popover fetch.
    @requires: 'Admin'
    function secretWarnings() returns array of {
      ![key]            : String(120);
      description       : String(500);
      daysRemaining     : Integer;
      severity          : String(10);
      rotationOwner     : String(120);
      rotationDocsUrl   : String(500);
    };
  ```

- [ ] **Step 4.3: Verify admin-service compiles**

  Run:

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`. If the function syntax fails, the most likely cause is the array-of-anonymous-type syntax — try:

  ```cds
  type SecretWarning {
    ![key]            : String(120);
    description       : String(500);
    daysRemaining     : Integer;
    severity          : String(10);
    rotationOwner     : String(120);
    rotationDocsUrl   : String(500);
  };

  @requires: 'Admin'
  function secretWarnings() returns array of SecretWarning;
  ```

  (Add the `type` definition before the service block, or as a separate using/imports section.)

- [ ] **Step 4.4: Commit**

  ```bash
  git add srv/admin-service.cds
  git commit -m "feat(srv): Secrets AdminService projection + secretWarnings function (#464)

  Projection is plain (NOT @odata.singleton) — Secrets is a list, not
  a singleton. @requires:'Admin' enforces XSUAA scope.

  secretWarnings() is an unbound read-only OData V4 function that
  returns severity-classified expiry warnings for the notifications
  popover. Invokable via GET (no CSRF token required)."
  ```

---

## Task 5: Create cron job module

**Files:**

- Create: `srv/jobs/secret-expiry-check.js`

- [ ] **Step 5.1: Write the cron module**

  Write to `srv/jobs/secret-expiry-check.js`:

  ```javascript
  // srv/jobs/secret-expiry-check.js
  // Daily cron (04:11 UTC) — computes days-remaining for tracked Secrets
  // and surfaces warnings via the admin-shell notifications popover. Stateless
  // — no per-row state in the schema; the popover queries live via
  // /admin/secretWarnings() so today's warning state is always fresh.
  //
  // Returns a structured summary for the scheduler's PipelineLog row so admins
  // can audit the daily run history.

  import cds from '@sap/cds';

  const LOG = cds.log('jobs/secret-expiry-check');

  const CRITICAL_THRESHOLD_DAYS = 0;   // ≤ 0 days = expired (or expires today)
  const WARNING_THRESHOLD_DAYS = 7;    // 0 < days ≤ 7
  const INFO_THRESHOLD_DAYS = 14;      // 7 < days ≤ 14

  /** Compute calendar-day delta between today (UTC) and expiresAt.
   *  Negative = already expired. Exported so the secretWarnings()
   *  AdminService handler can reuse it without duplication. */
  export function daysUntil(expiresAt, now = new Date()) {
    if (!expiresAt) return null;
    const expiry = new Date(expiresAt).getTime();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    return Math.floor((expiry - today) / 86_400_000);
  }

  /** Classify days-remaining into a severity tier. Null = no expiry tracked. */
  export function classifySeverity(daysRemaining) {
    if (daysRemaining == null) return null;
    if (daysRemaining <= CRITICAL_THRESHOLD_DAYS) return 'CRITICAL';
    if (daysRemaining <= WARNING_THRESHOLD_DAYS) return 'WARNING';
    if (daysRemaining <= INFO_THRESHOLD_DAYS) return 'INFO';
    return null;  // > 14 days = silent (not in the popover)
  }

  /**
   * Run the daily expiry check. Returns a structured summary for PipelineLog.
   * @returns {Promise<{ critical: number, warning: number, info: number,
   *                     total: number, criticalKeys: string[] }>}
   */
  export async function runSecretExpiryCheck() {
    const { Secrets } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(Secrets)
      .columns('key', 'expiresAt')
      .where({ expiresAt: { '!=': null } });

    const now = new Date();
    const counts = { critical: 0, warning: 0, info: 0 };
    const criticalKeys = [];

    for (const row of rows) {
      const days = daysUntil(row.expiresAt, now);
      const severity = classifySeverity(days);
      if (severity === 'CRITICAL') {
        counts.critical += 1;
        criticalKeys.push(row.key);
        LOG.warn(`secret ${row.key} expired or expiring today (${days} days)`);
      } else if (severity === 'WARNING') {
        counts.warning += 1;
        LOG.info(`secret ${row.key} expires in ${days} days`);
      } else if (severity === 'INFO') {
        counts.info += 1;
        LOG.info(`secret ${row.key} expires in ${days} days`);
      }
    }

    return {
      total: rows.length,
      critical: counts.critical,
      warning: counts.warning,
      info: counts.info,
      criticalKeys: criticalKeys.slice(0, 5),  // truncate for readable PipelineLog summary
    };
  }
  ```

- [ ] **Step 5.2: Verify file is syntactically valid**

  Run:

  ```bash
  node --check srv/jobs/secret-expiry-check.js && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 5.3: Commit**

  ```bash
  git add srv/jobs/secret-expiry-check.js
  git commit -m "feat(jobs): secret-expiry-check cron module (#464)

  Stateless severity classifier — no per-row state in the schema;
  popover queries live via /admin/secretWarnings().

  Exports daysUntil, classifySeverity (used by secretWarnings handler
  to avoid duplication) + runSecretExpiryCheck (called by scheduler).

  daysUntil truncates to UTC calendar days for DST-immunity. Returns
  structured summary for PipelineLog audit trail. criticalKeys
  truncated to 5 to keep the summary column under formatJobSummary's
  2000-char cap."
  ```

---

## Task 6: Register cron in scheduler

**Files:**

- Modify: `srv/jobs/scheduler.js` (add import at top + cron.schedule call inside `registerJobs()`)

- [ ] **Step 6.1: Add the import**

  Open `srv/jobs/scheduler.js`. Find the existing import block (around lines 1-12). Add a new import line alongside the others:

  ```javascript
  import { runSecretExpiryCheck } from './secret-expiry-check.js';
  ```

  Use Edit with another existing import as the unique anchor (e.g. `from './extract-concepts-job.js'`).

- [ ] **Step 6.2: Add the cron registration**

  Find the existing cron registrations inside `registerJobs()`. They're around lines 55-200 (each `cron.schedule(...)` block). Append a new registration. The 04:11 UTC slot is uncontested by other crons.

  Use Edit. Anchor on the closing `}` of `registerJobs()` (or the last `cron.schedule` block — pick whichever is unique). Insert before it:

  ```javascript

    // Phase 2-B (#464): Daily expiry check for tracked secrets.
    // Off-minute (04:11) avoids the :00 thundering-herd spike. 10-minute
    // lock matches similar lightweight jobs; the actual run is a single
    // SELECT + classification, well under a second.
    cron.schedule('11 4 * * *', () =>
      runWithLock('secret-expiry-check', 600000, runSecretExpiryCheck)
    );
  ```

- [ ] **Step 6.3: Verify scheduler is syntactically valid**

  Run:

  ```bash
  node --check srv/jobs/scheduler.js && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 6.4: Commit**

  ```bash
  git add srv/jobs/scheduler.js
  git commit -m "feat(jobs): register secret-expiry-check daily cron (#464)

  04:11 UTC daily — off-minute (matches existing pattern: :11, :13,
  :17, :30, :45 are all in use). 10-minute lock matches similar
  lightweight jobs."
  ```

---

## Task 7: Add `secretWarnings` AdminService handler

**Files:**

- Modify: `srv/admin-service.js` (append before `await super.init();` at ~line 984)

- [ ] **Step 7.1: Add the import**

  Find the existing import block at the top of `srv/admin-service.js`. Add:

  ```javascript
  import { classifySeverity, daysUntil } from './jobs/secret-expiry-check.js';
  ```

  Use Edit with another existing `from './...'` import as the unique anchor.

- [ ] **Step 7.2: Add the handler**

  Find the line `await super.init();` near the end of the `init()` method (around line 984). The new handler goes BEFORE that line, alongside the other `this.on('FUNCTION_NAME', ...)` registrations.

  Use Edit with `await super.init();` as the unique anchor. Insert before it:

  ```javascript

      // Phase 2-B (#464): Severity-classified expiry warnings for the
      // admin-shell notifications popover. Read-only — no DB writes.
      // Imports daysUntil + classifySeverity from the cron module to share
      // the threshold + UTC-truncation contract.
      this.on('secretWarnings', async (req) => {
        const { Secrets } = cds.entities('com.sap.developers.ims');
        const rows = await SELECT.from(Secrets)
          .columns('key', 'description', 'expiresAt', 'rotationOwner', 'rotationDocsUrl')
          .where({ expiresAt: { '!=': null } });

        const now = new Date();
        const warnings = [];
        for (const row of rows) {
          const daysRemaining = daysUntil(row.expiresAt, now);
          const severity = classifySeverity(daysRemaining);
          if (!severity) continue;
          warnings.push({
            key: row.key,
            description: row.description ?? '',
            daysRemaining,
            severity,
            rotationOwner: row.rotationOwner ?? '',
            rotationDocsUrl: row.rotationDocsUrl ?? '',
          });
        }

        warnings.sort((a, b) => a.daysRemaining - b.daysRemaining);
        return warnings;
      });
  ```

- [ ] **Step 7.3: Verify file is syntactically valid**

  Run:

  ```bash
  node --check srv/admin-service.js && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 7.4: Commit**

  ```bash
  git add srv/admin-service.js
  git commit -m "feat(srv): secretWarnings AdminService handler (#464)

  Severity-classified expiry warnings for the notifications popover.
  Imports daysUntil + classifySeverity from the cron module to share
  threshold + UTC-truncation contract (single source of truth).

  Empty-string fallbacks for nullable fields (?? '') keep UI binding
  safe. Sort by daysRemaining ascending puts already-expired secrets
  at the top of the popover."
  ```

---

## Task 8: One-shot seed script

**Files:**

- Create: `scripts/seed-secrets.cjs`

- [ ] **Step 8.1: Write the seed script**

  Write to `scripts/seed-secrets.cjs`:

  ```javascript
  #!/usr/bin/env node
  // scripts/seed-secrets.cjs
  // One-shot seed of the 6 known tracked secrets into the Secrets HANA entity.
  // Run via: npx cds bind --exec -- node scripts/seed-secrets.cjs
  //
  // Idempotent on `key` — re-running is safe; existing rows are not touched.
  // Add NEW tracked secrets via:
  //   1) Admin UI at /admin-ui/#secrets, OR
  //   2) Edit this file's INITIAL_SECRETS array + re-run.

  const cds = require('@sap/cds');

  const INITIAL_SECRETS = [
    {
      key: 'GITHUB_DISPATCH_TOKEN',
      description: 'Fine-grained GitHub PAT for workflow_dispatch on rebuild-content.yml.',
      kind: 'github-pat',
      rotationOwner: 'thomas.jung@sap.com',
      rotationDocsUrl: 'https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/github-dispatch-pat-rotation.md',
      expiresAt: null,
    },
    {
      key: 'CONTENT_API_KEY',
      description: 'Bearer token for POST /content/publish.',
      kind: 'content-api-key',
      rotationOwner: 'thomas.jung@sap.com',
      rotationDocsUrl: '',
      expiresAt: null,
    },
    {
      key: 'SUBMISSION_SALT_SECRET',
      description: 'IP-hash salt for /feedback/submit rate-limiter. Rotation invalidates rate-limit keys.',
      kind: 'salt',
      rotationOwner: 'thomas.jung@sap.com',
      rotationDocsUrl: '',
      expiresAt: null,
    },
    {
      key: 'SMTP_PASS',
      description: 'SMTP credential for outbound contributor-notifications mail.',
      kind: 'smtp-credential',
      rotationOwner: 'thomas.jung@sap.com',
      rotationDocsUrl: '',
      expiresAt: null,
    },
    {
      key: 'TUTORIALS_GITHUB_TOKEN',
      description: 'GitHub PAT for CI tutorial-fetcher (CI-only — not on tutorials-srv).',
      kind: 'github-pat',
      rotationOwner: 'thomas.jung@sap.com',
      rotationDocsUrl: '',
      expiresAt: null,
    },
    {
      key: 'AI_AUTHOR_AICORE_SERVICE_KEY',
      description: 'BTP service key for AI Core orchestration (CI-only). Vendor-defined rotation.',
      kind: 'service-key',
      rotationOwner: 'thomas.jung@sap.com',
      rotationDocsUrl: '',
      expiresAt: null,
    },
  ];

  async function main() {
    await cds.connect.to('db');
    const { Secrets } = cds.entities('com.sap.developers.ims');
    const existing = await SELECT.from(Secrets).columns('key');
    const existingKeys = new Set(existing.map(r => r.key));
    const toInsert = INITIAL_SECRETS.filter(s => !existingKeys.has(s.key));

    if (toInsert.length === 0) {
      console.log(`All ${INITIAL_SECRETS.length} known secrets already present — nothing to do.`);
      return;
    }

    await INSERT.into(Secrets).entries(toInsert);
    console.log(`Inserted ${toInsert.length} new tracked secrets:`);
    toInsert.forEach(s => console.log(`  - ${s.key} (${s.kind})`));
    console.log('');
    console.log('Next: visit /admin-ui/#secrets to set expiresAt + lastRotatedAt for each row.');
    console.log('The expiry-check cron (04:11 UTC daily) will surface warnings via the bell-icon popover.');
  }

  main()
    .catch(err => { console.error('Seed failed:', err.message); process.exit(1); })
    .finally(() => process.exit(0));
  ```

- [ ] **Step 8.2: Verify syntactically valid**

  Run:

  ```bash
  node --check scripts/seed-secrets.cjs && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 8.3: Commit**

  ```bash
  git add scripts/seed-secrets.cjs
  git commit -m "feat(scripts): one-shot seed-secrets script (#464)

  Idempotent on key — re-runnable safely. Run after first deploy:
  npx cds bind --exec -- node scripts/seed-secrets.cjs

  All 6 seeds ship with expiresAt: null (= 'never expires' to the
  cron). Admins set actual expiry dates via the admin tile after
  first run. Avoids day-1 false-positive warnings (boy-who-cried-wolf
  failure mode).

  process.exit(0) in .finally() needed because @sap/cds opens DB
  connections that don't auto-close. Pattern matches setup-dev-data.cjs."
  ```

---

## Task 9: Unit tests for cron module

**TDD note:** Tests follow Task 5 because the cron module is a translation of the spec's severity tiers — there is no design exploration to drive with red tests. Tests lock in the threshold boundaries.

**Files:**

- Create: `test/unit/jobs/secret-expiry-check.test.js`

- [ ] **Step 9.1: Inspect chat-settings-resolver test for bootstrap pattern**

  ```bash
  head -30 test/unit/chat-settings-resolver.test.js
  ```

  Note the `cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')` bootstrap.

- [ ] **Step 9.2: Create test directory**

  ```bash
  mkdir -p test/unit/jobs
  ```

- [ ] **Step 9.3: Write the tests**

  Write to `test/unit/jobs/secret-expiry-check.test.js`:

  ```javascript
  // test/unit/jobs/secret-expiry-check.test.js
  // Unit tests for srv/jobs/secret-expiry-check.js (#464).

  import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
  import path from 'node:path';
  import cds from '@sap/cds';
  import {
    classifySeverity,
    daysUntil,
    runSecretExpiryCheck,
  } from '../../../srv/jobs/secret-expiry-check.js';

  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { Secrets } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Secrets);
  });

  describe('classifySeverity (#464)', () => {
    it('returns null for daysRemaining > 14', () => {
      expect(classifySeverity(15)).toBe(null);
      expect(classifySeverity(100)).toBe(null);
    });

    it('returns INFO for 7 < days <= 14', () => {
      expect(classifySeverity(8)).toBe('INFO');
      expect(classifySeverity(14)).toBe('INFO');
    });

    it('returns WARNING for 0 < days <= 7', () => {
      expect(classifySeverity(1)).toBe('WARNING');
      expect(classifySeverity(7)).toBe('WARNING');
    });

    it('returns CRITICAL for days <= 0 (including negative = expired)', () => {
      expect(classifySeverity(0)).toBe('CRITICAL');
      expect(classifySeverity(-1)).toBe('CRITICAL');
      expect(classifySeverity(-90)).toBe('CRITICAL');
    });

    it('returns null for null input (no expiry tracked)', () => {
      expect(classifySeverity(null)).toBe(null);
      expect(classifySeverity(undefined)).toBe(null);
    });
  });

  describe('runSecretExpiryCheck (#464)', () => {
    it('returns zeroes for empty Secrets table', async () => {
      const summary = await runSecretExpiryCheck();
      expect(summary).toEqual({
        total: 0,
        critical: 0,
        warning: 0,
        info: 0,
        criticalKeys: [],
      });
    });

    it('classifies mixed-severity rows + truncates criticalKeys to 5', async () => {
      const { Secrets } = cds.entities('com.sap.developers.ims');
      const today = new Date();
      const ymd = (offset) => {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
        return d.toISOString().slice(0, 10);
      };
      // 7 critical rows (test the truncate-to-5), 1 warning, 1 info, 1 silent (>14)
      await INSERT.into(Secrets).entries([
        { key: 'C1', expiresAt: ymd(-10) },
        { key: 'C2', expiresAt: ymd(-5) },
        { key: 'C3', expiresAt: ymd(-1) },
        { key: 'C4', expiresAt: ymd(0) },
        { key: 'C5', expiresAt: ymd(0) },
        { key: 'C6', expiresAt: ymd(0) },
        { key: 'C7', expiresAt: ymd(0) },
        { key: 'W1', expiresAt: ymd(3) },
        { key: 'I1', expiresAt: ymd(10) },
        { key: 'S1', expiresAt: ymd(30) },
      ]);

      const summary = await runSecretExpiryCheck();
      expect(summary.total).toBe(10);
      expect(summary.critical).toBe(7);
      expect(summary.warning).toBe(1);
      expect(summary.info).toBe(1);
      expect(summary.criticalKeys).toHaveLength(5);
    });
  });
  ```

- [ ] **Step 9.4: Run tests**

  Run:

  ```bash
  npx vitest run test/unit/jobs/secret-expiry-check.test.js 2>&1 | tail -20
  ```

  Expected: 7 tests PASS (5 classifySeverity + 2 runSecretExpiryCheck).

  **If tests fail**: report what failed and STATUS: BLOCKED. Do NOT commit failing tests.

- [ ] **Step 9.5: Commit**

  ```bash
  git add test/unit/jobs/secret-expiry-check.test.js
  git commit -m "test(unit): secret-expiry-check coverage (#464)

  7 tests covering classifySeverity boundary cases (every threshold
  tier including null) + runSecretExpiryCheck shape (empty table,
  mixed-severity rows with criticalKeys truncate-to-5).

  Mirrors test/unit/chat-settings-resolver.test.js bootstrap pattern."
  ```

---

## Task 10: Admin tile — files

**Files:**

- Create: `app/admin/secrets/webapp/manifest.json`
- Create: `app/admin/secrets/webapp/Component.js`
- Create: `app/admin/secrets/webapp/index.html`
- Create: `app/admin/secrets/webapp/view/Secrets.view.xml`
- Create: `app/admin/secrets/webapp/view/SecretDialog.fragment.xml`
- Create: `app/admin/secrets/webapp/controller/Secrets.controller.js`
- Create: `app/admin/secrets/webapp/i18n/i18n.properties`

- [ ] **Step 10.1: Create directory tree**

  ```bash
  mkdir -p app/admin/secrets/webapp/view
  mkdir -p app/admin/secrets/webapp/controller
  mkdir -p app/admin/secrets/webapp/i18n
  ```

- [ ] **Step 10.2: Write `manifest.json`**

  Write to `app/admin/secrets/webapp/manifest.json`:

  ```json
  {
    "_version": "1.65.0",
    "sap.app": {
      "id": "sap.tutorials.admin.secrets",
      "type": "application",
      "title": "{{appTitle}}",
      "i18n": "i18n/i18n.properties"
    },
    "sap.ui5": {
      "rootView": {
        "viewName": "sap.tutorials.admin.secrets.view.Secrets",
        "type": "XML",
        "id": "secrets",
        "async": true
      },
      "dependencies": {
        "minUI5Version": "1.136.0",
        "libs": { "sap.m": {}, "sap.ui.core": {}, "sap.ui.layout": {} }
      },
      "models": {
        "i18n": {
          "type": "sap.ui.model.resource.ResourceModel",
          "settings": { "bundleName": "sap.tutorials.admin.secrets.i18n.i18n" }
        }
      },
      "contentDensities": { "compact": true, "cozy": true }
    }
  }
  ```

- [ ] **Step 10.3: Write `Component.js`**

  Write to `app/admin/secrets/webapp/Component.js`:

  ```javascript
  sap.ui.define(["sap/ui/core/UIComponent"], function (UIComponent) {
    "use strict";
    return UIComponent.extend("sap.tutorials.admin.secrets.Component", {
      metadata: { manifest: "json" }
    });
  });
  ```

- [ ] **Step 10.4: Write `index.html`**

  First inspect Joule's index.html as template:

  ```bash
  cat app/admin/joule/webapp/index.html
  ```

  Then write the same shape to `app/admin/secrets/webapp/index.html`, replacing every `sap.tutorials.admin.joule` reference with `sap.tutorials.admin.secrets` and any title literal with "Secrets Inventory."

- [ ] **Step 10.5: Write the main view**

  Write to `app/admin/secrets/webapp/view/Secrets.view.xml`:

  ```xml
  <mvc:View
    controllerName="sap.tutorials.admin.secrets.controller.Secrets"
    xmlns:mvc="sap.ui.core.mvc"
    xmlns="sap.m"
    xmlns:core="sap.ui.core"
    height="100%">
    <Page showHeader="false">
      <VBox class="sapUiMediumMargin">
        <Title text="{i18n>pageTitle}" level="H2" class="sapUiSmallMarginBottom" />
        <MessageStrip
          text="{i18n>infoStrip}"
          type="Information"
          showIcon="true"
          class="sapUiSmallMarginBottom" />

        <Table
          id="secretsTable"
          items="{secrets>/items}"
          growing="true"
          growingThreshold="50"
          mode="None">
          <headerToolbar>
            <Toolbar>
              <Title text="{i18n>tableTitle}" level="H3" />
              <ToolbarSpacer />
              <Button text="{i18n>buttonAdd}" icon="sap-icon://add" press=".onAdd" />
              <Button icon="sap-icon://refresh" tooltip="{i18n>buttonRefresh}" press=".onRefresh" />
            </Toolbar>
          </headerToolbar>
          <columns>
            <Column><Text text="{i18n>colKey}" /></Column>
            <Column><Text text="{i18n>colKind}" /></Column>
            <Column><Text text="{i18n>colExpiresAt}" /></Column>
            <Column><Text text="{i18n>colRotationOwner}" /></Column>
            <Column hAlign="End"><Text text="{i18n>colActions}" /></Column>
          </columns>
          <items>
            <ColumnListItem>
              <cells>
                <ObjectIdentifier title="{secrets>key}" text="{secrets>description}" />
                <Text text="{secrets>kind}" />
                <ObjectStatus text="{secrets>expiresAt}" state="{secrets>expiryState}" />
                <Text text="{secrets>rotationOwner}" />
                <HBox>
                  <Button icon="sap-icon://edit" press=".onEdit" tooltip="{i18n>buttonEdit}" type="Transparent" />
                  <Button icon="sap-icon://delete" press=".onDelete" tooltip="{i18n>buttonDelete}" type="Transparent" />
                </HBox>
              </cells>
            </ColumnListItem>
          </items>
        </Table>
      </VBox>
    </Page>
  </mvc:View>
  ```

- [ ] **Step 10.6: Write the dialog fragment**

  Write to `app/admin/secrets/webapp/view/SecretDialog.fragment.xml`:

  ```xml
  <core:FragmentDefinition
    xmlns="sap.m"
    xmlns:core="sap.ui.core"
    xmlns:f="sap.ui.layout.form">
    <Dialog
      id="secretDialog"
      title="{dialog>/title}"
      contentWidth="500px"
      contentHeight="auto">
      <f:SimpleForm editable="true" layout="ResponsiveGridLayout">
        <Label text="{i18n>fieldKey}" required="true" />
        <Input value="{dialog>/key}" enabled="{dialog>/isNew}" placeholder="GITHUB_DISPATCH_TOKEN" />
        <Label text="{i18n>fieldDescription}" />
        <TextArea value="{dialog>/description}" rows="2" />
        <Label text="{i18n>fieldKind}" />
        <ComboBox selectedKey="{dialog>/kind}">
          <core:Item key="github-pat" text="GitHub PAT" />
          <core:Item key="content-api-key" text="Content API Key" />
          <core:Item key="salt" text="Salt / hash secret" />
          <core:Item key="smtp-credential" text="SMTP credential" />
          <core:Item key="service-key" text="BTP service key" />
          <core:Item key="other" text="Other" />
        </ComboBox>
        <Label text="{i18n>fieldRotationOwner}" />
        <Input value="{dialog>/rotationOwner}" placeholder="thomas.jung@sap.com" />
        <Label text="{i18n>fieldRotationDocsUrl}" />
        <Input value="{dialog>/rotationDocsUrl}" />
        <Label text="{i18n>fieldExpiresAt}" />
        <DatePicker value="{dialog>/expiresAt}" valueFormat="yyyy-MM-dd" displayFormat="yyyy-MM-dd" />
        <Label text="{i18n>fieldLastRotatedAt}" />
        <DateTimePicker value="{dialog>/lastRotatedAt}" valueFormat="yyyy-MM-ddTHH:mm:ss" />
      </f:SimpleForm>
      <buttons>
        <Button text="{i18n>buttonSave}" type="Emphasized" press=".onDialogSave" />
        <Button text="{i18n>buttonCancel}" press=".onDialogCancel" />
      </buttons>
    </Dialog>
  </core:FragmentDefinition>
  ```

- [ ] **Step 10.7: Write the controller**

  Write to `app/admin/secrets/webapp/controller/Secrets.controller.js`:

  ```javascript
  sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
  ], function (Controller, Fragment, JSONModel, MessageToast, MessageBox) {
    "use strict";

    function deriveExpiryState(expiresAt) {
      if (!expiresAt) return "None";
      var today = new Date();
      var expiry = new Date(expiresAt);
      var todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      var days = Math.floor((expiry.getTime() - todayUTC) / 86400000);
      if (days <= 0) return "Error";
      if (days <= 7) return "Warning";
      if (days <= 14) return "Information";
      return "None";
    }

    return Controller.extend("sap.tutorials.admin.secrets.controller.Secrets", {
      onInit: function () {
        this.getView().setModel(new JSONModel({ items: [] }), "secrets");
        this.getView().setModel(new JSONModel({}), "dialog");
        this._loadSecrets();
      },

      _loadSecrets: function () {
        var oModel = this.getView().getModel("secrets");
        fetch("/admin/Secrets", {
          credentials: "include",
          headers: { "Accept": "application/json" }
        })
          .then(function (res) {
            if (!res.ok) { throw new Error("HTTP " + res.status); }
            return res.json();
          })
          .then(function (body) {
            var items = (body.value || []).map(function (row) {
              row.expiryState = deriveExpiryState(row.expiresAt);
              return row;
            });
            oModel.setData({ items: items });
          })
          .catch(function (err) {
            MessageToast.show("Failed to load secrets: " + err.message);
          });
      },

      onRefresh: function () { this._loadSecrets(); },

      onAdd: function () {
        this.getView().getModel("dialog").setData({
          title: this.getView().getModel("i18n").getResourceBundle().getText("dialogTitleAdd"),
          isNew: true,
          ID: null,
          key: "",
          description: "",
          kind: "other",
          rotationOwner: "",
          rotationDocsUrl: "",
          expiresAt: null,
          lastRotatedAt: null
        });
        this._openDialog();
      },

      onEdit: function (oEvent) {
        var oCtx = oEvent.getSource().getBindingContext("secrets");
        var row = oCtx.getObject();
        this.getView().getModel("dialog").setData({
          title: this.getView().getModel("i18n").getResourceBundle().getText("dialogTitleEdit"),
          isNew: false,
          ID: row.ID,
          key: row.key,
          description: row.description || "",
          kind: row.kind || "other",
          rotationOwner: row.rotationOwner || "",
          rotationDocsUrl: row.rotationDocsUrl || "",
          expiresAt: row.expiresAt || null,
          lastRotatedAt: row.lastRotatedAt || null
        });
        this._openDialog();
      },

      onDelete: function (oEvent) {
        var self = this;
        var oCtx = oEvent.getSource().getBindingContext("secrets");
        var row = oCtx.getObject();
        var bundle = this.getView().getModel("i18n").getResourceBundle();
        MessageBox.confirm(bundle.getText("confirmDelete"), {
          onClose: function (sAction) {
            if (sAction !== MessageBox.Action.OK) { return; }
            self._withCsrf(function (token) {
              return fetch("/admin/Secrets(" + row.ID + ")", {
                method: "DELETE",
                credentials: "include",
                headers: { "x-csrf-token": token }
              });
            }).then(function () {
              MessageToast.show("Deleted");
              self._loadSecrets();
            }).catch(function (err) {
              MessageBox.error("Delete failed: " + err.message);
            });
          }
        });
      },

      _openDialog: function () {
        var self = this;
        if (!this._oDialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "sap.tutorials.admin.secrets.view.SecretDialog",
            controller: this
          }).then(function (oDialog) {
            self._oDialog = oDialog;
            self.getView().addDependent(oDialog);
            oDialog.open();
          });
        } else {
          this._oDialog.open();
        }
      },

      onDialogSave: function () {
        var self = this;
        var data = this.getView().getModel("dialog").getData();
        var body = {
          key: data.key,
          description: data.description || null,
          kind: data.kind || null,
          rotationOwner: data.rotationOwner || null,
          rotationDocsUrl: data.rotationDocsUrl || null,
          expiresAt: data.expiresAt || null,
          lastRotatedAt: data.lastRotatedAt || null
        };

        this._withCsrf(function (token) {
          if (data.isNew) {
            return fetch("/admin/Secrets", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-csrf-token": token
              },
              body: JSON.stringify(body)
            });
          }
          return fetch("/admin/Secrets(" + data.ID + ")", {
            method: "PATCH",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify(body)
          });
        }).then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          MessageToast.show("Saved");
          self._oDialog.close();
          self._loadSecrets();
        }).catch(function (err) {
          MessageBox.error("Save failed: " + err.message);
        });
      },

      onDialogCancel: function () {
        this._oDialog.close();
      },

      _withCsrf: function (fnAfterToken) {
        return fetch("/admin/$metadata", {
          method: "HEAD",
          credentials: "include",
          headers: { "x-csrf-token": "fetch" }
        }).then(function (res) {
          return res.headers.get("x-csrf-token") || "";
        }).then(fnAfterToken);
      }
    });
  });
  ```

- [ ] **Step 10.8: Write i18n**

  Write to `app/admin/secrets/webapp/i18n/i18n.properties`:

  ```properties
  appTitle=Secrets Inventory
  pageTitle=Secrets Inventory
  tableTitle=Tracked Secrets
  infoStrip=Tracks credential metadata only — values stay in CF env / GitHub Actions secrets / mtaext. Phase 2-C will add encrypted-value storage once the encryption-key management decision is made. Daily expiry-check cron at 04:11 UTC surfaces warnings via the notifications popover (bell icon).
  colKey=Key
  colKind=Kind
  colExpiresAt=Expires
  colRotationOwner=Rotation Owner
  colActions=Actions
  buttonAdd=Add
  buttonRefresh=Refresh
  buttonEdit=Edit
  buttonDelete=Delete
  buttonSave=Save
  buttonCancel=Cancel
  fieldKey=Key (env-var name)
  fieldDescription=Description
  fieldKind=Kind
  fieldRotationOwner=Rotation Owner (email)
  fieldRotationDocsUrl=Rotation Docs URL
  fieldExpiresAt=Expires At
  fieldLastRotatedAt=Last Rotated At
  dialogTitleAdd=Add Tracked Secret
  dialogTitleEdit=Edit Tracked Secret
  confirmDelete=Delete this tracked-secret entry? This removes the metadata only — the actual credential is unaffected.
  ```

- [ ] **Step 10.9: Verify all 7 tile files exist**

  ```bash
  ls app/admin/secrets/webapp/manifest.json app/admin/secrets/webapp/Component.js app/admin/secrets/webapp/index.html app/admin/secrets/webapp/view/Secrets.view.xml app/admin/secrets/webapp/view/SecretDialog.fragment.xml app/admin/secrets/webapp/controller/Secrets.controller.js app/admin/secrets/webapp/i18n/i18n.properties
  ```

  Expected: 7 files listed.

  Also verify the controller is syntactically valid:

  ```bash
  node --check app/admin/secrets/webapp/controller/Secrets.controller.js && echo OK
  ```

- [ ] **Step 10.10: Commit**

  ```bash
  git add app/admin/secrets/
  git commit -m "feat(admin): Secrets admin tile (#464)

  Custom-XML list (Table + Add/Edit/Delete dialog fragment) mirroring
  the kg-settings + Joule pattern. NOT Fiori Elements — no FE V4
  draft/edit machinery.

  CSRF round-trip via HEAD /admin/\$metadata before POST/PATCH/DELETE
  (CAP enforces CSRF on writes). credentials: 'include' on every
  fetch. _withCsrf helper centralizes the round-trip pattern.

  expiryState derived in the controller (today_UTC truncation matches
  the cron's daysUntil contract) and bound to ObjectStatus.state for
  red/yellow/blue per-row badges."
  ```

---

## Task 11: Wire admin tile into admin-shell

**Files:**

- Modify: `app/admin-shell/scripts/copy-components.js` (append `'secrets'` to COMPONENTS array)
- Modify: `app/admin-shell/webapp/manifest.json` (4 sub-locations: componentUsages, target component-usage, target route-target, route entries)
- Modify: `app/admin-shell/webapp/view/Shell.view.xml` (System group `<NavigationListItem>`)
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js` (NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE entries — the **5th wiring location** that #463's first attempt missed)

- [ ] **Step 11.1: Add to copy-components.js**

  Open `app/admin-shell/scripts/copy-components.js`. Find the `COMPONENTS` array. Append `'secrets',` at the end of the array (or after `'feedback'` — order is irrelevant; the script just iterates).

- [ ] **Step 11.2: Add componentUsages entry in manifest.json**

  Open `app/admin-shell/webapp/manifest.json`. In the `componentUsages` block, add:

  ```json
  "sap.tutorials.admin.secrets": "./components/secrets",
  ```

  Mirror the existing entries' shape exactly. Be careful with trailing commas — JSON is strict.

- [ ] **Step 11.3: Add target component-usage entry**

  In the `targets` block (around line 152, where `jouleSettingsComponent` lives), add:

  ```json
  "secretsComponent": {
    "name": "sap.tutorials.admin.secrets",
    "settings": {},
    "componentData": {},
    "lazy": true
  },
  ```

- [ ] **Step 11.4: Add target route-target entry**

  In the `targets` block (around line 310, where `jouleSettingsTarget` lives), add:

  ```json
  "secretsTarget": {
    "type": "Component",
    "usage": "secretsComponent",
    "id": "secretsTarget",
    "viewLevel": 1,
    "prefix": "se"
  },
  ```

- [ ] **Step 11.5: Add route entry**

  In the `routes` array (around line 202), find the existing route entries. Insert:

  ```json
  { "name": "secrets", "pattern": "secrets", "target": [{"name": "secretsTarget", "prefix": "se"}] },
  ```

- [ ] **Step 11.6: Add NavigationListItem to Shell.view.xml**

  Open `app/admin-shell/webapp/view/Shell.view.xml`. Find the System group `<NavigationListItem>` (around line 105 — the parent item with `expanded="{viewModel>/groupExpanded/system}"`). The new tile slots into the System group alongside `Joule Settings`.

  Use Edit. Anchor on:

  ```xml
  <tnt:NavigationListItem text="Joule Settings" key="joule" />
  ```

  Replace with:

  ```xml
  <tnt:NavigationListItem text="Joule Settings" key="joule" />
              <tnt:NavigationListItem text="Secrets" key="secrets" />
  ```

  (Indent matches existing items.)

- [ ] **Step 11.7: Add NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE entries (5th wiring location)**

  Open `app/admin-shell/webapp/controller/Shell.controller.js`. Find the `NAV_KEY_TO_ROUTE` map (line 8). Add `secrets:` entry — place near `joule:` (line 28) since both are System-group config tiles. Use Edit:

  Anchor on `joule: "joule",`. Replace with:

  ```javascript
  joule: "joule",
      secrets: "secrets",
  ```

  (Indent matches.)

  Then find the `NAV_KEY_TO_TITLE` map (line 35). Edit again with anchor `joule: "Joule Settings",`. Replace with:

  ```javascript
  joule: "Joule Settings",
      secrets: "Secrets",
  ```

- [ ] **Step 11.8: Verify admin-shell builds**

  ```bash
  npm --prefix app/admin-shell install 2>&1 | tail -5
  npm --prefix app/admin-shell run build 2>&1 | tail -20
  ```

  Expected: build success; output shows `Copied secrets`. `app/admin-shell/dist/components/secrets/` exists with all 7 tile files.

  If JSON syntax fails, fix commas/braces and re-run. Use `mcp__plugin_ui5_ui5-mcp-server__run_manifest_validation` if needed.

- [ ] **Step 11.9: Commit**

  ```bash
  git add app/admin-shell/scripts/copy-components.js app/admin-shell/webapp/manifest.json app/admin-shell/webapp/view/Shell.view.xml app/admin-shell/webapp/controller/Shell.controller.js
  git commit -m "feat(admin-shell): wire secrets tile into shell (#464)

  5-location wiring (the same pattern #463 caught one missed location
  in final review):
  - copy-components.js: append 'secrets' to COMPONENTS array
  - manifest.json: componentUsages, target component-usage,
    target route-target, route entries
  - Shell.view.xml: NavigationListItem in System group
  - Shell.controller.js: NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE entries
    (the 5th wiring location — without it, clicking the side-nav item
    is a no-op)"
  ```

---

## Task 12: Wire popover live feed + admin-shell i18n bundle

**Files:**

- Create: `app/admin-shell/webapp/i18n/i18n.properties` (FIRST i18n bundle for admin-shell)
- Modify: `app/admin-shell/webapp/manifest.json` (register i18n model)
- Modify: `app/admin-shell/webapp/view/Shell.view.xml` (replace popover hardcoded body)
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js` (extend `onNotificationsPress`)

- [ ] **Step 12.1: Create the i18n bundle**

  Run:

  ```bash
  mkdir -p app/admin-shell/webapp/i18n
  ```

  Write to `app/admin-shell/webapp/i18n/i18n.properties`:

  ```properties
  notificationsEmpty=No notifications. All tracked secrets are in good shape (or have no expiry tracked).
  ```

- [ ] **Step 12.2: Register i18n model in manifest**

  Open `app/admin-shell/webapp/manifest.json`. Find the `models` block. Add a new `i18n` model entry alongside any existing models. The shape:

  ```json
  "i18n": {
    "type": "sap.ui.model.resource.ResourceModel",
    "settings": { "bundleName": "sap.tutorials.admin.shell.i18n.i18n" }
  }
  ```

  (Adjust the bundleName to match the admin-shell's `sap.app.id`. Verify it via `head -20 app/admin-shell/webapp/manifest.json` first.)

- [ ] **Step 12.3: Replace popover hardcoded body**

  Open `app/admin-shell/webapp/view/Shell.view.xml`. Find the existing popover (around line 142):

  ```xml
  <Popover
    id="notificationsPopover"
    placement="Bottom"
    title="Notifications">
    <VBox class="sapUiSmallMargin">
      <Label text="No new notifications" class="sapUiSmallMargin" />
    </VBox>
  </Popover>
  ```

  Replace the entire block with:

  ```xml
  <Popover
    id="notificationsPopover"
    placement="Bottom"
    title="Notifications"
    contentWidth="380px">
    <VBox class="sapUiSmallMargin">
      <List
        id="notificationsList"
        items="{notifications>/items}"
        noDataText="{i18n>notificationsEmpty}"
        showSeparators="Inner">
        <CustomListItem>
          <VBox class="sapUiSmallMargin">
            <ObjectStatus
              text="{notifications>key}"
              state="{notifications>uiState}"
              icon="{notifications>uiIcon}" />
            <Text text="{notifications>summary}" class="sapUiTinyMarginTop" />
            <HBox class="sapUiTinyMarginTop">
              <Link
                text="Rotation guide"
                href="{notifications>rotationDocsUrl}"
                target="_blank"
                visible="{= !!${notifications>rotationDocsUrl} }" />
              <ToolbarSpacer />
              <Text text="{notifications>rotationOwner}" class="sapUiTinyMarginBegin" />
            </HBox>
          </VBox>
        </CustomListItem>
      </List>
    </VBox>
  </Popover>
  ```

- [ ] **Step 12.4: Extend `onNotificationsPress` in Shell.controller.js**

  Find the existing `onNotificationsPress` handler in `app/admin-shell/webapp/controller/Shell.controller.js`. It currently just opens the popover. Replace its body with:

  ```javascript
  onNotificationsPress: function (oEvent) {
    var oButton = oEvent.getSource();
    var oPopover = this.byId("notificationsPopover");
    var oNotifModel = this.getView().getModel("notifications") ||
      new JSONModel({ items: [] });
    this.getView().setModel(oNotifModel, "notifications");

    fetch("/admin/secretWarnings()", {
      credentials: "include",
      headers: { "Accept": "application/json" }
    })
      .then(function (res) {
        if (!res.ok) { throw new Error("HTTP " + res.status); }
        return res.json();
      })
      .then(function (body) {
        var aWarnings = (body.value || []).map(function (w) {
          var sUiState = w.severity === "CRITICAL" ? "Error"
                       : w.severity === "WARNING"  ? "Warning"
                       : "Information";
          var sUiIcon = w.severity === "CRITICAL" ? "sap-icon://alert"
                       : w.severity === "WARNING"  ? "sap-icon://warning"
                       : "sap-icon://information";
          var sSummary = w.daysRemaining < 0
            ? "Expired " + Math.abs(w.daysRemaining) + " day(s) ago"
            : w.daysRemaining === 0
            ? "Expires today"
            : "Expires in " + w.daysRemaining + " day(s)";
          return {
            key: w.key,
            summary: sSummary,
            uiState: sUiState,
            uiIcon: sUiIcon,
            rotationOwner: w.rotationOwner,
            rotationDocsUrl: w.rotationDocsUrl,
          };
        });
        oNotifModel.setData({ items: aWarnings });
      })
      .catch(function () {
        oNotifModel.setData({ items: [] });
      });

    oPopover.openBy(oButton);
  },
  ```

  Be careful: `JSONModel` may need to be imported at the top of the controller. Check the existing requires and add `'sap/ui/model/json/JSONModel'` to the `sap.ui.define` array if not already present.

- [ ] **Step 12.5: Verify admin-shell builds + controller is valid**

  ```bash
  node --check app/admin-shell/webapp/controller/Shell.controller.js && echo OK
  npm --prefix app/admin-shell run build 2>&1 | tail -10
  ```

  Expected: `OK` + build success.

- [ ] **Step 12.6: Commit**

  ```bash
  git add app/admin-shell/webapp/i18n/ app/admin-shell/webapp/manifest.json app/admin-shell/webapp/view/Shell.view.xml app/admin-shell/webapp/controller/Shell.controller.js
  git commit -m "feat(admin-shell): notifications popover live feed + first i18n bundle (#464)

  Replaces the hardcoded 'No new notifications' label with a live
  query against /admin/secretWarnings() on every popover open.
  Severity → UI mapping: CRITICAL→Error, WARNING→Warning, INFO→Information.

  Creates the FIRST i18n bundle for admin-shell at
  webapp/i18n/i18n.properties — until now, admin-shell hardcoded all
  labels in XML literals. This unblocks future i18n migration of the
  hardcoded nav-item labels (separate cleanup PR).

  Soft-fail on fetch error: empty popover instead of blocking the
  user. Warnings reload on next open."
  ```

---

## Task 13: Update srv-qa cp list (defensive)

**Files:**

- Modify: `.deploy/mta.yaml:97`

- [ ] **Step 13.1: Identify the srv-qa cp chain**

  ```bash
  sed -n '97p' .deploy/mta.yaml | head -c 500
  ```

  Confirm the line begins with `- bash -c "mkdir -p srv/jobs && ...`. Note that `srv/jobs/` already has a `mkdir -p` — the new file goes into the EXISTING subdirectory.

- [ ] **Step 13.2: Add the cp segment**

  Use Edit. Find the existing `cp <existing-jobs-files> srv/jobs/` segment in the bash chain. Add `../../srv/jobs/secret-expiry-check.js` to the file list.

  **Note:** This is DEFENSIVE — `srv-qa/server.js` does NOT load `scheduler.js` or anything under `srv/jobs/`, so the cron file would be a dead file in `gen/srv-qa/`. Adding it preserves the convention that all `srv/jobs/*` ship to QA, preempting a crash if QA ever grows a feature that loads the cron module.

- [ ] **Step 13.3: Verify YAML + bash both valid**

  ```bash
  yq '.modules[] | select(.name == "tutorials-srv-qa")' .deploy/mta.yaml > /dev/null && echo YAML_OK
  yq -r '.modules[] | select(.name == "tutorials-srv-qa") | ."build-parameters".commands[] | select(test("secret-expiry-check"))' .deploy/mta.yaml | bash -n && echo SHELL_OK
  ```

  Expected: both `YAML_OK` and `SHELL_OK`. If either fails, `git checkout .deploy/mta.yaml` and try again with extra care for quote balance.

- [ ] **Step 13.4: Commit**

  ```bash
  git add .deploy/mta.yaml
  git commit -m "chore(deploy): defensively add secret-expiry-check.js to srv-qa cp (#464)

  Not strictly required today — srv-qa/server.js doesn't load
  scheduler.js or anything under srv/jobs/, so the cron file would be
  dead in gen/srv-qa/. Adding it preserves the convention that all
  srv/jobs/* files ship to QA, preempting a crash if QA ever grows a
  feature that loads the cron module."
  ```

---

## Task 14: Add operations doc

**Files:**

- Create: `docs/developers/operations/secrets-tracking.md`

- [ ] **Step 14.1: Write the doc**

  Write to `docs/developers/operations/secrets-tracking.md`:

  ```markdown
  # Secrets tracking — operations runbook

  **Spec:** [docs/superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md](../../superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md)

  **Issue:** [#464](https://github.com/sap-tutorials/tutorials-ims/issues/464)

  ## What

  The `Secrets` HANA entity tracks **credential metadata only** — `key`, `description`, `kind`, `rotationOwner`, `rotationDocsUrl`, `expiresAt`, `lastRotatedAt`. It does NOT store credential values. Values stay in CF env / mtaext / GitHub Actions secrets / managed services. Phase 2-C (#465) will add encrypted-value storage once the encryption-key management decision is made.

  A daily cron at 04:11 UTC computes `daysRemaining` per row and surfaces warnings via the admin-shell notifications popover (bell icon, top-right of `/admin-ui/`).

  ## How to add a new tracked secret

  Two paths converge on the same DB row:

  **Path A — via the admin tile (preferred for ad-hoc additions):**

  1. Open `/admin-ui/#secrets`.
  2. Click **Add**.
  3. Fill in `Key` (env-var name), `Description`, `Kind` (dropdown), `Rotation Owner` (email), `Rotation Docs URL`, `Expires At`, `Last Rotated At`.
  4. Click **Save**.

  **Path B — via the seed script (preferred when adding multiple secrets, or when DB is fresh):**

  1. Edit `scripts/seed-secrets.cjs` and add a new entry to the `INITIAL_SECRETS` array.
  2. Run: `npx cds bind --exec -- node scripts/seed-secrets.cjs`
  3. The script is idempotent on `key` — existing rows are not touched.

  ## How rotation owners receive warnings

  - **Bell icon notifications popover** in `/admin-ui/`. Live query on every open. Shows secrets with `daysRemaining ≤ 14`.
  - **Severity tiers:**
    - 🔴 **CRITICAL** — `daysRemaining ≤ 0` (expired or expires today)
    - 🟡 **WARNING** — `1 ≤ daysRemaining ≤ 7`
    - 🔵 **INFO** — `8 ≤ daysRemaining ≤ 14`
    - silent — `daysRemaining > 14` or `expiresAt = null`

  - **Daily PipelineLog row** at 04:11 UTC capturing `{total, critical, warning, info, criticalKeys}`.
    - View at `/admin-ui/#pipelinelog` (filter by `jobName = secret-expiry-check`).

  Phase 3+ may add external notifiers (GitHub-issue-comment poster, email via mail-client.js). Out of scope for #464.

  ## `kind` enum values

  | Kind | Examples |
  |---|---|
  | `github-pat` | GitHub PAT (DISPATCH_TOKEN, TUTORIALS_GITHUB_TOKEN) |
  | `content-api-key` | Bearer token for `/content/publish` |
  | `salt` | Hash salt (SUBMISSION_SALT_SECRET) |
  | `smtp-credential` | SMTP credentials |
  | `service-key` | BTP service key (AI_AUTHOR_AICORE_SERVICE_KEY) |
  | `other` | Fallback |

  ## After rotating a secret

  1. Update the **actual** credential per its rotation runbook (e.g. mint a new GitHub PAT, push it to CF env or GH Actions secret, redeploy).
  2. In `/admin-ui/#secrets`, find the row, click Edit, update `Last Rotated At` and (if it's a vendor-defined cadence like 90-day GitHub PATs) update `Expires At` to `today + 90 days`.
  3. The popover entry will disappear within 24 hours (next cron tick) — or immediately on next popover open if `daysRemaining` is now > 14.

  ## Cross-links

  - Research-design parent: [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](../../superpowers/specs/2026-06-20-runtime-config-research-design.md)
  - Phase 2-A foundation (already shipped): #463 / PR #471
  - Phase 2-C encrypted values (gated): #465
  - Phase 3 long-tail env-var migration: #466
  - GitHub PAT rotation runbook: [github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md)
  ```

- [ ] **Step 14.2: Commit**

  ```bash
  git add docs/developers/operations/secrets-tracking.md
  git commit -m "docs(ops): secrets-tracking operations runbook (#464)

  Describes the Secrets entity surface, the two paths for adding new
  tracked secrets (admin tile + seed script), the severity tiers, and
  the post-rotation update flow."
  ```

---

## Task 15: End-to-end verification

- [ ] **Step 15.1: Run all unit tests**

  ```bash
  npm test 2>&1 | tail -30
  ```

  Expected: all unit tests pass. Specifically the new `test/unit/jobs/secret-expiry-check.test.js` should show 7/7 pass.

  **If pre-existing tests fail unrelated to #464:** check whether the failure is environment-related (fresh-worktree missing native bindings, missing test fixtures, etc.). Compare with main if needed. Don't block on pre-existing failures.

- [ ] **Step 15.2: Confirm CDS compile clean**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo SRV_OK
  npx cds compile db/schema.cds > /dev/null && echo SCHEMA_OK
  ```

  Expected: 2 OKs.

- [ ] **Step 15.3: Confirm admin-shell build clean**

  ```bash
  npm --prefix app/admin-shell run build 2>&1 | tail -20
  ```

  Expected: build success; `Copied secrets` in output.

- [ ] **Step 15.4: Inspect git log on branch**

  ```bash
  git log --oneline main..HEAD
  ```

  Expected: ~14 implementation commits + spec/plan docs commits. All on the worktree branch, none on main.

- [ ] **Step 15.5: Use `superpowers:finishing-a-development-branch`**

  After all verifications pass, use the **superpowers:finishing-a-development-branch** skill to:

  1. Verify tests pass.
  2. Determine base branch (`main`).
  3. Present the user with the 4-option menu (merge / push+PR / keep / discard).

  When the user picks **"Push and create a Pull Request"**, the PR body should:

  - Reference issue #464 (`Closes #464.`).
  - Include a summary of the architecture (Secrets entity + cron + popover + tile).
  - Include the test plan checkboxes:
    - [ ] Local unit tests pass (`npx vitest run test/unit/jobs/secret-expiry-check.test.js` — 7/7 pass).
    - [ ] DEV deploy: tile loads at `/admin-ui/#secrets`.
    - [ ] DEV deploy: run `npx cds bind --exec -- node scripts/seed-secrets.cjs` once; 6 secrets appear in tile.
    - [ ] DEV deploy: edit a Secret's `expiresAt` to today + 5 days. Click bell icon → see WARNING entry.
    - [ ] DEV deploy: edit `expiresAt` to yesterday. Click bell icon → see CRITICAL entry (red).
    - [ ] DEV deploy: change appears in `/admin-ui/#changelog-display`.
    - [ ] DEV deploy: cron-job log appears in `/admin-ui/#pipelinelog` after next 04:11 UTC tick.
  - Reference the spec doc + research-design parent.

---

## Out of scope for this plan

- **Encrypted-value columns + decryption.** Phase 2-C (#465) — gated on encryption-key management decision.
- **GitHub-issue-comment notifier.** Phase 3+ if visibility-only proves insufficient.
- **Email notifier via mail-client.js.** Phase 3+ — same gating.
- **Automated rotation handlers.** Phase 3+ — research doc explicitly defers.
- **`lastNotifiedAt` / `warningTier` columns on Secrets.** Cron is stateless; popover queries live.
- **Hybrid round-trip tests.** Stateless cron on a 7-column entity — unit-test SQLite path covers what matters; HANA-specific edge cases would only matter for the encrypted-values phase.
- **Smoke tests** against `/admin/secretWarnings()`. Manual smoke during DEV deploy.
- **i18n migration of existing hardcoded admin-shell labels.** Bundle creation here unblocks it; actual migration is a separate cleanup PR.
- **Removing env vars from mtaext.** Stays through Phase 3 + soak window.

## References

- Spec: `docs/superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md`
- Research-design parent: `docs/superpowers/specs/2026-06-20-runtime-config-research-design.md`
- Sibling Phase 2-A plan (template for admin-tile + admin-shell wiring): `docs/superpowers/plans/2026-06-20-issue-463-runtime-config-foundation.md`
- Issue: [#464](https://github.com/sap-tutorials/tutorials-ims/issues/464)
- Precedent files: `srv/lib/chat-settings-resolver.js`, `test/unit/chat-settings-resolver.test.js`, `app/admin/joule/webapp/`, `srv/jobs/scheduler.js`, `scripts/setup-dev-data.cjs`, `app/admin-shell/scripts/copy-components.js`
- Memory: [feedback_cap_csv_seeds_clobber_admin_data], [feedback_srv_qa_cp_list_recurring], [feedback_subagent_writes_can_leak_to_parent_repo], [project_463_runtime_config_foundation_shipped] (5th wiring location lesson).
