# Phase A — Auth-Parity Misconfiguration Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three acute authorization misconfigurations flagged in the auth-parity audit — remove the `Tutorial.Author` auto-grant, tighten `ScannerService` from `authenticated-user` to `MobileApp`, and remove the silent-Admin default in the tech-user auth path. Each fix ships as its own commit inside one PR so a bad one can be reverted independently.

**Architecture:** Three small production-code changes (`xs-security.json`, `srv/scanner-service.cds`, `srv/lib/tech-user-auth.js`) plus three regression tests (one new file, one extended file, one existing file amended). Adds an operational runbook (`docs/developers/operations/xsuaa-role-collection-assignment.md`) and updates the MTA deployment guide with the explicit `cf update-service` step.

**Tech Stack:** No new dependencies. Vitest (unit workspace), `cds.test('serve', '--in-memory')`, `cds.User` role injection pattern already used across `test/unit/**` (see [test/unit/author-service.test.js:96-102](test/unit/author-service.test.js#L96-L102) for the canonical anonymous-rejection idiom).

**Non-goals:**
- No test-framework changes (that's Phase B).
- No per-action `@requires` tightening beyond ScannerService (that's Phase C).
- No changes to `Tutorials Author` / `Tutorials Scanner` role-collection *definitions* — the fixes are about *how those roles are granted*.
- No removal of the legitimate `Admin` fallback for tech-users that DO explicitly specify `Admin` — only the silent-default case is affected.

**Related:** [Master spec](../specs/2026-07-03-809-authorization-parity-design.md) — Phase A section. Issue [#809](https://github.com/sap-tutorials/tutorials-ims/issues/809).

---

## Pre-implementation checks (do these before starting)

Some findings from these checks may reveal that A3 has more moving parts than the spec anticipated. If the audit turns up a role-less entry in a production tenant, coordinate with the tech lead before proceeding to A3 — the fail-loud change would crash srv boot if such an entry survives to deploy.

- [ ] **Check-1: Verify the auto-grant is still present in `xs-security.json`**

  Run:
  ```bash
  grep -n "Tutorial.Author" xs-security.json
  ```
  Expected: one line inside a role template's `scope-references`, and one line inside the top-level `authorities` array (currently line 120). If line 120 is already `"$XSAPPNAME.Everyone"` alone, A1 was completed in a prior PR — skip A1.

- [ ] **Check-2: Verify `ScannerService` still uses `authenticated-user`**

  Run:
  ```bash
  grep -n "@requires" srv/scanner-service.cds
  ```
  Expected: `@requires: 'authenticated-user'` on line 4. If it's already `MobileApp`, A2 was completed — skip A2.

- [ ] **Check-3: Verify the tech-user default is still `['Admin']`**

  Run:
  ```bash
  grep -n "'Admin'" srv/lib/tech-user-auth.js
  ```
  Expected: `roles: roles ? roles.split(',') : ['Admin']` on line 23. If the ternary already throws, A3 was completed — skip A3.

- [ ] **Check-4: Audit DEV `TenantSettings.techUsers` for role-less entries**

  This is the load-bearing pre-flight check for A3. A production tenant with a role-less entry would crash srv boot after A3 ships.

  Prereq: `cf login` to the tutorial-system DEV space.

  Run (uses `cds bind` to talk to the DEV HANA instance):
  ```bash
  npx cds bind --exec -- node -e "
    (async () => {
      const cds = await import('@sap/cds');
      const db = await cds.default.connect.to('db');
      const rows = await db.run(SELECT.from('COM_SAP_DEVELOPERS_IMS_TENANTSETTINGS').columns('TENANTID','TECHUSERS'));
      for (const r of rows) {
        if (!r.TECHUSERS) continue;
        for (const entry of String(r.TECHUSERS).split(';')) {
          const parts = entry.split(':');
          const [user, pass, roles] = parts;
          if (user && pass && !roles) {
            console.log('ROLE-LESS ENTRY in tenant', r.TENANTID, '→ user', user, '(would default to Admin today)');
          }
        }
      }
      console.log('audit complete');
    })().catch(e => { console.error(e); process.exit(1); });
  "
  ```
  Expected output: `audit complete` with zero `ROLE-LESS ENTRY` lines. If any appear, **stop Phase A implementation** and back-fill each entry via the admin UI (`/admin-ui/#tenants-display` → edit techUsers to append `:Admin` to each role-less entry) before proceeding. Re-run the audit until it's clean.

- [ ] **Check-5: Same audit against PROD**

  Prereq: `cf login` to the tutorial-system PROD space, then repeat Check-4. Same clean-output requirement. **Note:** PROD does not yet exist for this project (cutover end of July 2026 per [project_prod_cutover_july_2026](../../../.claude/projects/d--projects-tutorials-poc/memory/project_prod_cutover_july_2026.md)) — if PROD isn't stood up when this plan runs, note "N/A — PROD not deployed" and move on. Otherwise the check is mandatory.

---

## File Structure

**Create:**
- `test/unit/xs-security-authorities.test.js` — asserts `authorities` array contains only `"$XSAPPNAME.Everyone"`. Regression guard for A1.
- `test/unit/scanner-service-auth.test.js` — asserts ScannerService is `@requires: 'MobileApp'` (both by parsing the CDS file and by cds.test-based positive/negative call). Regression guard for A2.
- `docs/developers/operations/xsuaa-role-collection-assignment.md` — new runbook: how to grant `Tutorials Author` via BTP Cockpit + `btp` CLI, how to audit current assignments.

**Modify:**
- `xs-security.json:119-122` — remove `"$XSAPPNAME.Tutorial.Author"` from the top-level `authorities` array (A1).
- `srv/scanner-service.cds:4` — change `@requires: 'authenticated-user'` to `@requires: 'MobileApp'` (A2).
- `srv/lib/tech-user-auth.js:19-25` — parse-time throw when role field is missing (A3).
- `test/lib/tech-user-auth.test.js:83-92` — invert the "defaults to Admin role when no roles specified" test into a "throws when no roles specified" test (A3).
- `docs/developers/operations/mta-deployment.md` (near line 96, "Step 4: XSUAA Role Collections") — expand to explicitly note that `xs-security.json` changes require `cf update-service` and to link the new role-collection assignment runbook.
- `docs/developers/reference/testing-endpoints.md` — update the ScannerService row's "Required scope" from `authenticated-user` to `MobileApp` (if the file has that column; otherwise no-op — Phase C adds the column).

**Do NOT modify:**
- The `TutorialAuthor` role template itself (`xs-security.json` around line 40-something). It STAYS. The template is what the `Tutorials Author` role-collection grants. We're only removing the auto-grant to *every* JWT.
- Anonymous `@requires: 'any'` services (HomepageService, SearchService, EventStreamService, DeveloperService anonymous entities). Phase C decides what to annotate; Phase A only touches ScannerService.
- Any admin UI. Role assignment is a BTP Cockpit / `btp` CLI operation.

---

## Task A1: Remove `Tutorial.Author` auto-grant

**Files:**
- Modify: `xs-security.json:119-122`
- Create: `test/unit/xs-security-authorities.test.js`

- [ ] **Step A1.1: Write the failing test first**

  Create `test/unit/xs-security-authorities.test.js`:

  ```js
  // Phase A1 (#809) — Regression guard. The top-level `authorities` array in
  // xs-security.json is auto-granted to every authenticated JWT. Prior to A1
  // it contained `$XSAPPNAME.Tutorial.Author`, which defeated the `Tutorials
  // Author` role-collection design (any authenticated user got QA-preview
  // access). This test locks the auto-grant down to `Everyone` only.
  //
  // If a future change must re-add a scope here, update this test AND
  // document the operational impact in xsuaa-role-collection-assignment.md.

  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { describe, it, expect } from 'vitest';

  describe('xs-security.json — top-level authorities auto-grant', () => {
    const cfg = JSON.parse(
      readFileSync(join(process.cwd(), 'xs-security.json'), 'utf8')
    );

    it('exposes an authorities array', () => {
      expect(Array.isArray(cfg.authorities)).toBe(true);
    });

    it('auto-grants ONLY $XSAPPNAME.Everyone (no other scopes)', () => {
      expect(cfg.authorities).toEqual(['$XSAPPNAME.Everyone']);
    });

    it('does not auto-grant Tutorial.Author (A1 regression)', () => {
      expect(cfg.authorities).not.toContain('$XSAPPNAME.Tutorial.Author');
    });
  });
  ```

- [ ] **Step A1.2: Run test to verify it fails (current state has Tutorial.Author in authorities)**

  Run: `npx vitest run test/unit/xs-security-authorities.test.js --project unit`

  Expected: FAIL on the second test with something like `Expected: ["$XSAPPNAME.Everyone"], Received: ["$XSAPPNAME.Tutorial.Author", "$XSAPPNAME.Everyone"]`.

- [ ] **Step A1.3: Apply the fix — edit `xs-security.json`**

  Change lines 119-122 from:
  ```json
    "authorities": [
      "$XSAPPNAME.Tutorial.Author",
      "$XSAPPNAME.Everyone"
    ],
  ```
  to:
  ```json
    "authorities": [
      "$XSAPPNAME.Everyone"
    ],
  ```

- [ ] **Step A1.4: Run test to verify it passes**

  Run: `npx vitest run test/unit/xs-security-authorities.test.js --project unit`

  Expected: 3 tests PASS.

- [ ] **Step A1.5: Run the wider unit workspace to catch collateral damage**

  Run: `npm test -- --project unit`

  Expected: full unit suite passes. If any `Tutorial.Author`-related test regresses, do NOT proceed — investigate; the auto-grant may have been load-bearing for something the audit missed.

- [ ] **Step A1.6: Commit**

  ```bash
  git add xs-security.json test/unit/xs-security-authorities.test.js
  git commit -m "fix(#809): remove Tutorial.Author auto-grant from xs-security authorities

  Top-level authorities in xs-security.json is auto-granted to every
  authenticated JWT. Having Tutorial.Author there defeated the
  Tutorials Author role-collection design -- any authenticated user
  got QA-preview access.

  This tightens the model to require explicit role-collection
  assignment for QA preview (\`/tutorials-qa/*\`, \`/qa-search/*\`,
  \`/author/*\`).

  Operational impact: users currently relying on the auto-grant lose
  QA access until assigned to the Tutorials Author role-collection.
  Requires \`cf update-service tutorial-system-dev-xsuaa -c
  xs-security.json\` after deploy. Role-collection assignment
  runbook: docs/developers/operations/xsuaa-role-collection-assignment.md.

  Regression guard: test/unit/xs-security-authorities.test.js.

  Refs #809 (Phase A1)."
  ```

---

## Task A2: ScannerService requires `MobileApp` scope

**Files:**
- Modify: `srv/scanner-service.cds:4`
- Create: `test/unit/scanner-service-auth.test.js`

**Rationale:** Approuter route `^/scanner/(.*)$` already requires `MobileApp` at ingress ([approuter/xs-app.json:66-72](approuter/xs-app.json#L66-L72)), but direct-srv-URL access (hybrid dev, or via a leaked srv URL) only requires an authenticated JWT today. Aligning the CDS `@requires` with the approuter route closes that bypass.

- [ ] **Step A2.1: Write the failing test first**

  Create `test/unit/scanner-service-auth.test.js`:

  ```js
  // Phase A2 (#809) — Regression guard. ScannerService was `@requires:
  // 'authenticated-user'`, which allowed any authenticated JWT direct-srv
  // access to `getContestant` / `claimPrize`. The approuter enforces the
  // MobileApp scope at ingress, but the srv layer did not -- so a leaked
  // srv URL or a hybrid-dev bypass could enumerate contestants.
  //
  // A2 tightens the CDS gate to `MobileApp`. This test asserts BOTH the
  // static CDS annotation AND the runtime behavior (authenticated-user
  // -only callers are rejected 403, MobileApp callers succeed).

  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { describe, it, expect } from 'vitest';
  import cds from '@sap/cds';

  cds.test('serve', '--project', '.', '--in-memory');

  describe('ScannerService — @requires: MobileApp (A2)', () => {
    it('CDS file annotates @requires: MobileApp', () => {
      const src = readFileSync(
        join(process.cwd(), 'srv/scanner-service.cds'),
        'utf8'
      );
      expect(src).toMatch(/@requires:\s*'MobileApp'/);
      expect(src).not.toMatch(/@requires:\s*'authenticated-user'/);
    });

    it('rejects anonymous callers with 403', async () => {
      const srv = await cds.connect.to('ScannerService');
      await expect(
        srv.tx({ user: { id: 'anonymous', roles: {} } }, (tx) =>
          tx.send({ event: 'getContestant', data: { accountNumber: '8001' } })
        )
      ).rejects.toMatchObject({ code: 403 });
    });

    it('rejects a bare authenticated-user (no MobileApp scope) with 403', async () => {
      const srv = await cds.connect.to('ScannerService');
      // A bare JWT without MobileApp scope -- previously allowed, now denied.
      await expect(
        srv.tx(
          { user: { id: 'jwt-user', roles: { 'authenticated-user': true } } },
          (tx) =>
            tx.send({ event: 'getContestant', data: { accountNumber: '8001' } })
        )
      ).rejects.toMatchObject({ code: 403 });
    });

    it('permits callers holding MobileApp scope', async () => {
      const { Users } = cds.entities('com.sap.developers.ims');
      await DELETE.from(Users);
      await INSERT.into(Users).entries({
        ID: 'u-alice', uuid: 'u-alice', sapId: 'sap-alice',
        legacyId: 8001, displayName: 'Alice'
      });

      const srv = await cds.connect.to('ScannerService');
      // getContestant currently returns an object shape even when the
      // contestant has zero completions; the point of this test is the
      // scope check, not the response shape. Do not assert on fields.
      const result = await srv.tx(
        { user: { id: 'scanner-op', roles: { MobileApp: true } } },
        (tx) =>
          tx.send({ event: 'getContestant', data: { accountNumber: '8001' } })
      );
      expect(result).toBeDefined();
    });
  });
  ```

- [ ] **Step A2.2: Run test to verify it fails**

  Run: `npx vitest run test/unit/scanner-service-auth.test.js --project unit`

  Expected: FAIL on the static-check test (`Expected pattern /@requires:\s*'MobileApp'/`) and on the "authenticated-user" case (the call would currently succeed).

- [ ] **Step A2.3: Apply the fix — edit `srv/scanner-service.cds`**

  Change line 4 from:
  ```cds
  @requires: 'authenticated-user'
  ```
  to:
  ```cds
  @requires: 'MobileApp'
  ```

- [ ] **Step A2.4: Run test to verify it passes**

  Run: `npx vitest run test/unit/scanner-service-auth.test.js --project unit`

  Expected: 4 tests PASS.

- [ ] **Step A2.5: Verify existing scanner regression test still passes**

  Run: `npx vitest run test/unit/scanner-claim-prize-ownership.test.js --project unit`

  Expected: existing #889 ownership tests still PASS (they use `cds.User.Privileged()` which bypasses `@requires`, so this should be a no-op).

- [ ] **Step A2.6: Update testing-endpoints doc if the "Required scope" column exists**

  Run: `grep -n "Required scope" docs/developers/reference/testing-endpoints.md || echo "column does not exist yet"`

  If the column exists: update the ScannerService row to say `MobileApp` (was `authenticated-user`).
  If the column does not exist yet: no-op — Phase C creates the column.

- [ ] **Step A2.7: Commit**

  ```bash
  git add srv/scanner-service.cds test/unit/scanner-service-auth.test.js docs/developers/reference/testing-endpoints.md 2>/dev/null
  git commit -m "fix(#809): tighten ScannerService @requires to MobileApp

  Approuter route \`^/scanner/(.*)\$\` requires the MobileApp scope at
  ingress, but the srv layer only required \`authenticated-user\`. A
  direct-srv-URL call (leaked URL, hybrid-dev bypass) with any JWT
  could enumerate contestant progress via \`getContestant\`. Aligning
  the CDS gate with the approuter closes the bypass.

  Production users routing through the approuter are unaffected. Local
  hybrid-dev with tech-user Basic auth needs the tech-user's tenant
  entry to include \`MobileApp\` in its role list.

  Regression guard: test/unit/scanner-service-auth.test.js.

  Refs #809 (Phase A2)."
  ```

---

## Task A3: Remove silent-Admin default from tech-user auth

**Files:**
- Modify: `srv/lib/tech-user-auth.js:19-25`
- Modify: `test/lib/tech-user-auth.test.js:83-92`

**Rationale:** `srv/lib/tech-user-auth.js:23` currently falls back to `['Admin']` when a tenant-configured tech-user entry omits the role field. That's a supply-chain / config-drift risk — a partial tenant config edit could silently elevate a service account to Admin. Legacy Java required an explicit `authority` on every tech user. Phase A3 makes the same requirement explicit at parse time (throw + log, do not silently fall back).

**Critical dependency:** Check-4 and Check-5 above MUST have completed cleanly (zero role-less entries in DEV or PROD `TenantSettings.techUsers`). If they didn't, this task will crash srv boot after deploy.

- [ ] **Step A3.1: Read the existing test to understand the current shape**

  Run: `grep -n "defaults to Admin" test/lib/tech-user-auth.test.js`

  Expected: one hit around line 83. This test currently asserts the silent-Admin behavior — it must be inverted.

- [ ] **Step A3.2: Rewrite the "defaults to Admin" test as a failing "throws when role missing" test**

  In `test/lib/tech-user-auth.test.js`, replace the test block that begins with `it('defaults to Admin role when no roles specified', ...` (around line 83) with:

  ```js
  it('logs a warning and skips the entry when roles are missing (A3)', async () => {
    // Phase A3 (#809) -- previously this entry silently defaulted to Admin,
    // a supply-chain / config-drift risk. Now we skip the entry loudly:
    // the middleware refuses to authenticate against a role-less entry,
    // and prints a warning at parse time so operators notice.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockTenant({ techUsers: 'svc-account:pass123' });
    const mw = await loadMiddleware();
    const creds = Buffer.from('svc-account:pass123').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    // Middleware must not silently elevate to Admin.
    expect(req.user).toBeUndefined();
    // Downstream middleware still runs -- we don't 401, we just don't
    // authenticate this caller. Approuter / CAP layer will reject if
    // the endpoint requires auth.
    expect(called).toBe(true);
    // Operator visibility: parse-time warning names the offending user.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('tech-user'),
      expect.stringContaining('svc-account')
    );
    warn.mockRestore();
  });
  ```

  **Design note — why skip-with-warning instead of parse-time throw?** The spec's Section 6.3 risk table calls out A3's high impact if a role-less entry exists — a boot-crash locks operators out of admin UI to fix it. Skip-with-warning is safer: the offending entry stops working (so no silent Admin elevation), but the service stays up so operators can fix the config. This is a mid-planning refinement of the spec — flag it explicitly during plan review.

- [ ] **Step A3.3: Add a companion test for the well-formed-and-roled path (ensures we didn't break the happy path)**

  Add a new test block right after the one written in A3.2:

  ```js
  it('authenticates a well-formed entry with explicit roles', async () => {
    // Sanity check that A3 did not regress the intended happy path.
    // Two entries: one role-less (skipped), one explicit-roles (works).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockTenant({ techUsers: 'bad-entry:pass;good-entry:pass:ContentAuthor' });
    const mw = await loadMiddleware();
    const creds = Buffer.from('good-entry:pass').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    await mw(req, makeRes(), () => {});
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe('good-entry');
    expect(req.user.is('ContentAuthor')).toBe(true);
    warn.mockRestore();
  });
  ```

- [ ] **Step A3.4: Run tests to verify they fail (current code still silently defaults to Admin)**

  Run: `npx vitest run test/lib/tech-user-auth.test.js`

  Expected: the two new tests FAIL. The first one because `req.user` is currently defined (silent-Admin); the second one because the role-less entry is also silently authenticated as Admin instead of being skipped.

- [ ] **Step A3.5: Apply the fix — edit `srv/lib/tech-user-auth.js`**

  Change lines 17-27 (the `loadTechUsers` parse loop) from:

  ```js
    // Format: "user1:pass1:role1,role2;user2:pass2:role3"
    techUsers = new Map();
    for (const entry of raw.split(';')) {
      const [username, password, roles] = entry.split(':');
      if (username && password) {
        techUsers.set(username, {
          password,
          roles: roles ? roles.split(',') : ['Admin']
        });
      }
    }
    return techUsers;
  ```

  to:

  ```js
    // Format: "user1:pass1:role1,role2;user2:pass2:role3"
    // Phase A3 (#809): a role-less entry no longer silently defaults to
    // Admin. Such entries are skipped with a warning at parse time.
    // Operators must specify roles explicitly, e.g. "svc-account:pass:Admin".
    techUsers = new Map();
    for (const entry of raw.split(';')) {
      const [username, password, roles] = entry.split(':');
      if (!username || !password) continue;
      if (!roles) {
        console.warn(
          '[tech-user-auth] skipping tech-user entry with no roles:',
          username,
          '-- specify roles explicitly (e.g. "user:pass:Admin") to enable this entry.'
        );
        continue;
      }
      techUsers.set(username, { password, roles: roles.split(',') });
    }
    return techUsers;
  ```

- [ ] **Step A3.6: Run tests to verify they pass**

  Run: `npx vitest run test/lib/tech-user-auth.test.js`

  Expected: all 11 tests PASS (the original 9 tests continue passing, plus 2 new A3 tests).

- [ ] **Step A3.7: Run the wider unit workspace to catch collateral damage**

  Run: `npm test -- --project unit`

  Expected: full unit suite passes. If any test that used to rely on the silent-Admin default breaks, that test was itself an unaudited elevation path — investigate before proceeding.

- [ ] **Step A3.8: Commit**

  ```bash
  git add srv/lib/tech-user-auth.js test/lib/tech-user-auth.test.js
  git commit -m "fix(#809): drop silent-Admin default in tech-user auth path

  \`srv/lib/tech-user-auth.js\` previously fell back to \`['Admin']\`
  when a tenant-configured tech-user entry omitted the role field.
  That's a supply-chain / config-drift risk -- a partial tenant edit
  could silently elevate a service account to Admin without any audit
  trail.

  A3 changes the behavior: a role-less entry is now skipped at parse
  time with a warning naming the offending user. Operators must set
  roles explicitly, e.g. \`svc-account:pass:Admin\`. Well-formed
  entries with explicit roles are unchanged.

  Chose skip-with-warning over parse-time throw so a bad config does
  not lock operators out of the admin UI. See plan A3.2 design note.

  Pre-deploy audit: DEV and PROD \`TenantSettings.techUsers\` must be
  clear of role-less entries before shipping. See plan Check-4/-5.

  Refs #809 (Phase A3)."
  ```

---

## Task A4: Runbook and deploy-guide updates

**Files:**
- Create: `docs/developers/operations/xsuaa-role-collection-assignment.md`
- Modify: `docs/developers/operations/mta-deployment.md` (around line 96, "Step 4: XSUAA Role Collections")
- Modify: `docs/.vitepress/config.ts` (sidebar registration for the new doc)

- [ ] **Step A4.1: Confirm the VitePress sidebar structure**

  Run:
  ```bash
  grep -n "xsuaa\|mta-deployment\|operations" docs/.vitepress/config.ts | head -20
  ```

  Look for the "Operations" section under `sidebar` and note the pattern used for other runbooks — the new file will slot in the same shape.

- [ ] **Step A4.2: Create the role-collection assignment runbook**

  Create `docs/developers/operations/xsuaa-role-collection-assignment.md`:

  ```markdown
  # XSUAA Role Collection Assignment

  Post-Phase-A1 ([#809](https://github.com/sap-tutorials/tutorials-ims/issues/809)) the `Tutorial.Author` scope is no longer auto-granted to every authenticated JWT. QA preview (`/tutorials-qa/*`, `/qa-search/*`) and the author service (`/author/*`) now require explicit assignment to the `Tutorials Author` role collection.

  This runbook covers **assigning users** to role collections, **auditing current assignments**, and the **rollout sequence** when granting new access.

  ## Role collection catalog

  Defined in [xs-security.json](../../../xs-security.json). Six collections:

  | Role collection | Grants scope | Gates |
  |---|---|---|
  | `Tutorials Admin` | `Admin`, `DisplayApp`, `DeveloperApp`, `Everyone` | `/admin/*`, `/admin-ui/`, `/analytics-ui/`, `/admin/exports/*`, `/admin/analytics/*` |
  | `Tutorials SuperAdmin` | `SuperAdmin` + everything Admin grants | KG concept publish/unpublish; anything gated on `SuperAdmin` in Phase C |
  | `Tutorials Developer` | `DeveloperApp`, `Everyone` | authenticated `/api/*` progress endpoints |
  | `Tutorials Display` | `DisplayApp`, `Everyone` | `/display/*` (event-monitor dashboards) |
  | `Tutorials Author` | `Tutorial.Author`, `Everyone` | `/tutorials-qa/*`, `/qa-search/*`, `/author/*`, srv-qa `/content/*` |
  | `Tutorials Scanner` | `MobileApp`, `Everyone` | `/scanner-ui/`, `/scanner-vue/`, `/scanner/*` |

  ## Assignment via BTP Cockpit

  1. Log in to the BTP Cockpit for the target subaccount (currently `tutorial-system` in eu10-005).
  2. Navigate to **Security → Role Collections**.
  3. Click the target collection (e.g. `Tutorials Author`).
  4. In the **Users** tab: **Edit**, add rows with `SAP IDP` origin and the user's e-mail as `ID`. Save.

  User needs to log out and log back in for the JWT to pick up the new scope.

  ## Assignment via `btp` CLI

  ```bash
  btp target --subaccount <subaccount-guid>
  btp assign security/role-collection "Tutorials Author" \
    --to-user user@sap.com \
    --of-idp <origin-id>
  ```

  Notes:
  - `<origin-id>` is typically `sap.default` for SAP IDP. Run `btp list security/user-origin` to confirm.
  - Batch assign by looping over a text file of e-mails; the command is idempotent.

  ## Auditing current assignments

  **Cockpit path:** Security → Role Collections → click a collection → Users tab lists holders.

  **CLI path (JSON):**

  ```bash
  btp get security/role-collection "Tutorials Author" --format json | jq '.userAssignments[]'
  ```

  Snapshot the output before Phase A1 ships so you know which users need re-granting after the auto-grant is removed.

  ## Rollout sequence for Phase A1

  1. **Snapshot current QA-preview access** (users who need `Tutorials Author` explicitly). Because the auto-grant currently satisfies the gate, the current `Tutorials Author` role-collection membership is likely near-empty — real active QA authors need to be identified from GitHub activity or asked directly.

     Suggested query: check who has recently opened PRs against `*-Contribution` repos in the sap-tutorials GitHub org. Cross-reference with SAP IDP e-mails.

  2. **Assemble the initial grant list.** In practice this is: the QA-content authoring team, the tutorials-ims maintainer team, anyone who has used `/tutorials-qa/*` recently. When in doubt, err on the side of granting — a false-positive grant is low-cost; a missed grant blocks legitimate work.

  3. **Grant the collection to every user on the list** via cockpit or CLI *before* deploying the A1 change. Grants are cheap and can be added at any time, but adding them in advance means no user hits a 401 wall.

  4. **Deploy Phase A1** (removes the auto-grant from `xs-security.json`).

  5. **Run `cf update-service`** to reconcile the deployed XSUAA instance with the new config:

     ```bash
     cf update-service tutorial-system-dev-tutorials-xsuaa -c xs-security.json
     ```

     (Substitute the correct service-instance name for QA / PROD.) See the memory pattern [xsuaa_scope_changes_need_manual_update_service](../../../.claude/projects/d--projects-tutorials-poc/memory/xsuaa_scope_changes_need_manual_update_service.md).

  6. **Verify via `/auth/user`.** Pick a granted user and a non-granted user; log both in via the approuter and hit `/auth/user`. The `isAuthor` field must be `true` for the granted user and `false` for the non-granted user.

  ## Revocation

  Removing a user from a role collection takes effect on their next JWT refresh (default: ~12 hours, or immediately if they log out and back in).

  ## Related docs

  - [MTA Deployment Runbook](mta-deployment.md) — see Step 4 for the `cf update-service` command in context.
  - [Master auth-parity spec (#809)](../../superpowers/specs/2026-07-03-809-authorization-parity-design.md).
  ```

- [ ] **Step A4.3: Update `mta-deployment.md` around line 96 (Step 4: XSUAA Role Collections)**

  Read the current content of that section:
  ```bash
  sed -n '96,112p' docs/developers/operations/mta-deployment.md
  ```

  Replace the section (lines 96–110 approximately) with:

  ```markdown
  ## Step 4: XSUAA Role Collections

  Role collections are defined in `xs-security.json` and created automatically when the XSUAA service instance is created via MTA deploy. **Any subsequent change to `xs-security.json` (scope add/remove, role template edit, or authorities-array change) requires a manual `cf update-service` to reconcile the deployed instance.** The MTA `cf deploy` command alone does NOT re-read `xs-security.json`.

  ```bash
  cf update-service tutorial-system-dev-tutorials-xsuaa -c xs-security.json
  ```

  This is a well-known trap ([xsuaa_scope_changes_need_manual_update_service](../../../.claude/projects/d--projects-tutorials-poc/memory/xsuaa_scope_changes_need_manual_update_service.md)). Ship the `cf update-service` step in the same change window as the code deploy.

  **Post-Phase-A1 (#809):** the `Tutorial.Author` scope is no longer auto-granted. Users needing QA-preview access must be explicitly assigned to the `Tutorials Author` role collection. See [xsuaa-role-collection-assignment.md](xsuaa-role-collection-assignment.md) for the full runbook.

  **Assign users to role collections** in BTP Cockpit:

  1. Navigate to Security → Role Collections
  2. Find "Tutorials Admin" / "Tutorials Developer" / "Tutorials Display" / "Tutorials Author" / "Tutorials Scanner" / "Tutorials SuperAdmin"
  3. Add users (e-mail addresses from SAP IDP)

  Note: CF CLI cannot assign users to role collections — this is a BTP subaccount-level operation. Use `btp` CLI for CI/scripted assignments (see the assignment runbook).
  ```

  (This preserves the existing bullets while adding the two new paragraphs.)

- [ ] **Step A4.4: Register the new doc in the VitePress sidebar**

  Open `docs/.vitepress/config.ts`. Find the "Operations" section under `sidebar` — it will list `mta-deployment`, `content-rollback`, etc. Add an entry for the new runbook, alphabetically sorted:

  ```ts
  { text: 'XSUAA Role Collection Assignment', link: '/developers/operations/xsuaa-role-collection-assignment' },
  ```

  (Match the exact style — some entries may use `text:`/`link:`, others `text` + relative path. Follow the surrounding pattern.)

- [ ] **Step A4.5: Run the docs sidebar guard**

  Run: `npm run docs:build`

  Expected: build succeeds. The `predocs:build` sidebar guard rejects unregistered pages, so if you forgot A4.4 it fails here.

- [ ] **Step A4.6: Commit**

  ```bash
  git add docs/developers/operations/xsuaa-role-collection-assignment.md \
          docs/developers/operations/mta-deployment.md \
          docs/.vitepress/config.ts
  git commit -m "docs(#809): add XSUAA role-collection assignment runbook

  New runbook covers granting users to the six role collections
  (Tutorials Admin / SuperAdmin / Developer / Display / Author /
  Scanner), auditing current assignments via cockpit and \`btp\`
  CLI, and the rollout sequence for Phase A1 (Tutorial.Author
  auto-grant removal).

  Also expands mta-deployment.md Step 4 to make the
  \`cf update-service\` requirement explicit -- it is a well-known
  trap that MTA \`cf deploy\` does not re-read xs-security.json.

  Cross-linked from mta-deployment.md and registered in the
  VitePress sidebar.

  Refs #809 (Phase A4)."
  ```

---

## Task A5: Cross-cutting verification

Run the full slice of tests, docs build, and a lint pass to catch anything missed.

- [ ] **Step A5.1: Full unit suite**

  Run: `npm test`

  Expected: all unit tests pass. This includes the three new/amended auth tests plus every existing test that could have been broken by A1/A2/A3.

- [ ] **Step A5.2: Docs build (sanity)**

  Run: `npm run docs:build`

  Expected: succeeds. Confirms the new runbook is registered.

- [ ] **Step A5.3: CDS lint**

  Run: `npx cds compile srv/ --to xsuaa`

  Expected: succeeds without warnings. Confirms the `MobileApp` scope in `scanner-service.cds` is a known scope in `xs-security.json`.

- [ ] **Step A5.4: Verify no `Tutorial.Author` regression in xs-app.json**

  Run: `grep -n "Tutorial.Author" approuter/xs-app.json`

  Expected: hits — the routes gating `Tutorial.Author` (approuter route scopes) must still be there. If they're gone, that's a regression from a prior PR unrelated to this one, but flag it.

- [ ] **Step A5.5: Optional — probe a QA-preview flow via Playwright (only if a local hybrid environment is available)**

  This is the "verify live" step in the spec. Not required for PR merge, but strongly recommended before deploy.

  1. `npm run dev:hybrid` in the primary tree (worktree-based hybrid dev doesn't work reliably — spec's memory pattern [feedback_worktree_tests_hang](../../../.claude/projects/d--projects-tutorials-poc/memory/feedback_worktree_tests_hang.md) — but a fresh `npm run dev:hybrid` in the primary tree is fine).
  2. Log in via the approuter at `http://localhost:5000/login`.
  3. Hit `http://localhost:5000/auth/user`. `isAuthor` should reflect the current role-collection assignment on the logged-in user. Grants are still driven by the running BTP subaccount, not by A1's code change (A1's effect only shows up post-deploy).

---

## Task A6: PR + deploy checklist

Not a code task — an operational checklist to run before/after merging Phase A.

- [ ] **Step A6.1: Open PR from `worktree-809-auth-parity` to `main`**

  ```bash
  gh pr create --repo sap-tutorials/tutorials-ims \
    --base main \
    --head worktree-809-auth-parity \
    --title "fix(#809): auth-parity Phase A — three misconfiguration fixes" \
    --body-file /tmp/809-a-pr-body.md
  ```

  (Author the body inline covering: three commits, rollback plan, operational impact on QA authors, tech-user audit results.)

- [ ] **Step A6.2: Confirm CI passes on the PR**

  Expected: unit workspace + docs build both green. If either red, do not merge.

- [ ] **Step A6.3: Merge (after review)**

  Use the "Squash and merge" convention consistent with prior PRs on this repo. Commit message inherits from PR title + body.

- [ ] **Step A6.4: Deploy to DEV via the canonical local deploy path**

  Per the [Local Deploy Process memory](../../../.claude/projects/d--projects-tutorials-poc/memory/project_local_deploy_process.md) and [Always deploy from main memory](../../../.claude/projects/d--projects-tutorials-poc/memory/feedback_always_deploy_from_main_primary_tree.md):

  ```bash
  # In the primary tree, on main, after pulling the merged commits
  git checkout main && git pull
  npm run build:all
  cd .deploy
  mbt build
  envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
    < ../deploy/dev.mtaext > ../deploy/dev.resolved.mtaext
  cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
  cd ..
  ```

- [ ] **Step A6.5: Run `cf update-service` to reconcile XSUAA**

  Critical after A1's `xs-security.json` change. Without this, the deployed XSUAA instance keeps the old scope-set and A1 has no runtime effect.

  ```bash
  cf update-service tutorial-system-dev-tutorials-xsuaa -c xs-security.json
  ```

  (Substitute the correct instance name from `cf services | grep xsuaa`.)

- [ ] **Step A6.6: Grant `Tutorials Author` to all users on the pre-audit list**

  Following the runbook created in A4.2. Do this within the same change window as A6.5.

- [ ] **Step A6.7: Smoke-verify the deployment**

  ```bash
  APPROUTER="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com"

  # /auth/user for a granted user (log in first via a browser)
  # Should show isAuthor: true
  curl -sb cookies.txt "$APPROUTER/auth/user" | jq .isAuthor

  # /auth/user for a NON-granted user (different login session)
  # Should show isAuthor: false
  ```

  Or open a Playwright session driving both a granted and non-granted user through the approuter and inspect `/auth/user` in each session.

- [ ] **Step A6.8: One working-day soak, then unblock Phase B**

  Wait ≥ 1 working day with A deployed to DEV before opening the Phase B PR. This is the "bake time" from the spec's rollout section — catches surprise regressions that unit tests missed (auto-grant was load-bearing for a code path we didn't audit; a QA author's JWT refresh fails; etc.).

  If any regression surfaces during soak: file a follow-up issue, revert the offending sub-fix (they're separate commits — see A6.3), and re-deploy. Do NOT bundle the fix into Phase B.

---

## Rollback plan

Each of A1/A2/A3/A4 reverts independently — they were committed as separate commits in the PR.

**Rollback A1** (if the auto-grant removal broke QA access for someone we forgot to grant):
```bash
git revert <A1-commit-sha>          # in a new worktree/branch
gh pr create ... # merge
# Then on main:
cf update-service tutorial-system-dev-tutorials-xsuaa -c xs-security.json
```
Rolling back A1 requires re-running `cf update-service` — same as forward-deploying it.

**Rollback A2**: revert the CDS file change, redeploy, no XSUAA reconciliation needed.

**Rollback A3**: revert the tech-user-auth.js change, redeploy. If a tenant added a role-less entry post-A3 relying on the skip-with-warning behavior, that entry will silently re-enable Admin on rollback — audit `TenantSettings.techUsers` before considering the rollback complete.

**Rollback A4**: docs-only; safe to revert or forward-fix.

Do NOT revert Phase A as a whole — always revert the specific sub-fix that caused the issue. Bundling reverts loses the audit trail.

---

## Acceptance criteria (mirrored from spec)

- [x] `xs-security.json` `authorities` array contains only `["$XSAPPNAME.Everyone"]` — asserted by A1 test.
- [x] `srv/scanner-service.cds` uses `@requires: 'MobileApp'` — asserted by A2 test.
- [x] `srv/lib/tech-user-auth.js` skips role-less tech-user entries with a warning at parse time — asserted by A3 test.
- [x] 3 regression tests exist (`test/unit/xs-security-authorities.test.js`, `test/unit/scanner-service-auth.test.js`, amended `test/lib/tech-user-auth.test.js`).
- [x] `docs/developers/operations/xsuaa-role-collection-assignment.md` exists and covers current holders, cockpit + `btp` CLI grant procedure, audit.
- [x] Deploy runbook step for `cf update-service xsuaa` added to `mta-deployment.md`.
- [x] `TenantSettings.techUsers` audit run against DEV and PROD **as part of this deploy** (Check-4 and Check-5); role-less entries back-filled before A6.4.
- [x] PR merged, deployed to DEV, `cf update-service` executed (A6.5), one working-day soak (A6.8).
- [x] `/auth/user` shows the expected `isAuthor` value for both a role-collection-holder and a non-holder (A6.7 / A5.5).

---

## Notes for the plan reviewer

- **A3 refinement**: The spec says "parse-time throw"; this plan uses "parse-time skip-with-warning" to avoid boot-crash on a role-less entry in production. This is a safer failure mode with the same security property (no silent Admin elevation). See the design note under Step A3.2. If the reviewer prefers throw, the change is trivial — flip `continue` to `throw new Error(...)`.
- **Test-file location**: `test/unit/` is the unit workspace, but the existing tech-user test already lives at `test/lib/tech-user-auth.test.js`. This plan keeps A3's test edits in that file (co-located with the module under test's peer tests) rather than moving it — minimizes churn, respects the existing convention.
- **A5.5 (Playwright verify)** is called out as optional because worktree-based dev hybrid setups are flaky ([feedback_worktree_tests_hang](../../../.claude/projects/d--projects-tutorials-poc/memory/feedback_worktree_tests_hang.md)). The Playwright step should be run from the primary tree post-merge, not from the worktree pre-merge.
