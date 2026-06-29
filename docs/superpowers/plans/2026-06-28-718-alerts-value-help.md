# Alerts Value Help — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/superpowers/specs/2026-06-28-718-alerts-value-help.md](../specs/2026-06-28-718-alerts-value-help.md)
**Issue:** [#718](https://github.com/sap-tutorials/ims/issues/718)
**Branch / worktree:** `fix/718-alerts-value-help` at `.claude/worktrees/718-alerts-value-help/`

**Goal:** Make `severity` and `audience` render as Select dropdowns (not plain text) in the Alerts admin object-page editor by adding `AlertSeverities` / `AlertAudiences` code-list stub entities and wiring them via `@Common.ValueList`.

**Architecture:** Mirror the established `EventTypes` / `MissionTypes` / `TaskStatuses` / `AlertCtaTargets` pattern: (1) two small `Object.freeze`d arrays in `srv/lib/`, (2) two `@readonly @cds.persistence.skip` entities in `srv/admin-service.cds`, (3) two `this.on('READ', …)` handlers in `srv/admin-service.js` returning shallow copies, (4) `@Common.ValueList` annotations on the two fields in `app/admin-annotations.cds`. Zero DB / schema impact — service-shape only.

**Tech Stack:** CAP Node.js (`@sap/cds`), CDS annotations, Fiori Elements V4, Vitest.

---

## File Structure

**Create**
- `srv/lib/alert-enums.js` — `Object.freeze`d arrays for severity + audience codes/labels, with `listAlertSeverities()` / `listAlertAudiences()` getters returning shallow copies. Single file (both lists are < 5 entries each and conceptually paired). Mirrors `srv/lib/alert-cta-targets.js`.
- `srv/lib/__tests__/alert-enums.test.js` — pure-data unit test. Mirrors `srv/lib/__tests__/alert-cta-targets.test.js`.

**Modify**
- `srv/admin-service.cds` (around line 241, right after the `EventTypes` stub) — add two `@readonly @cds.persistence.skip` entities.
- `srv/admin-service.js` (around line 162, right after the `EventTypes` READ handler) — add two READ handlers calling the new getters.
- `app/admin-annotations.cds` (lines 2783-2788, the existing `severity` + `audience` annotation block) — add `@Common.ValueList` clauses pointing at the new collections.

**Files NOT touched** (state once, do not re-derive)
- `db/schema.cds` — inline enums on `Alerts.severity` / `Alerts.audience` stay as-is; `@assert.range` continues to enforce values.
- `srv-qa/` — no admin-service in srv-qa, no parallel change.
- `db/last-dev/` — service-shape change only; no `cds build` needed.
- `mta.yaml` — no new directories to copy.
- `srv/server.js`, `srv/lib/alerts-cache.js`, `srv/routes/alerts-public.js` — public wire shape unchanged.

---

## Task 1: Add the data module

**Files:**
- Create: `srv/lib/alert-enums.js`

- [ ] **Step 1: Create the module.**

Write `srv/lib/alert-enums.js`:

```js
// srv/lib/alert-enums.js
//
// Static code-list source of truth for Alerts.severity and Alerts.audience.
// These arrays back the AdminService.AlertSeverities and
// AdminService.AlertAudiences read-only entities — Fiori Elements V4 fetches
// them as the value-help collection so the object-page editor renders a
// Select control instead of a plain text input.
//
// Codes MUST mirror the inline enums on db/schema.cds:467-471 exactly
// (drift would surface as @assert.range rejection on write).
// Labels are display-only — Fiori uses them only in the dropdown items.

export const ALERT_SEVERITIES = Object.freeze([
  Object.freeze({ code: 'Information', label: 'Information' }),
  Object.freeze({ code: 'Success',     label: 'Success'     }),
  Object.freeze({ code: 'Warning',     label: 'Warning'     }),
  Object.freeze({ code: 'Error',       label: 'Error'       }),
]);

export const ALERT_AUDIENCES = Object.freeze([
  Object.freeze({ code: 'ALL',           label: 'All visitors'    }),
  Object.freeze({ code: 'AUTHENTICATED', label: 'Signed-in users' }),
  Object.freeze({ code: 'ADMIN',         label: 'Admins only'     }),
]);

export function listAlertSeverities() {
  return ALERT_SEVERITIES.map((s) => ({ ...s }));
}

export function listAlertAudiences() {
  return ALERT_AUDIENCES.map((a) => ({ ...a }));
}
```

- [ ] **Step 2: Commit.**

```bash
git add srv/lib/alert-enums.js
git commit -m "feat(#718): code-list module for Alerts severity & audience"
```

---

## Task 2: Test the data module (TDD)

**Files:**
- Create: `srv/lib/__tests__/alert-enums.test.js`

- [ ] **Step 1: Write the failing test.**

Write `srv/lib/__tests__/alert-enums.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  ALERT_SEVERITIES,
  ALERT_AUDIENCES,
  listAlertSeverities,
  listAlertAudiences,
} from '../alert-enums.js';

describe('alert-enums', () => {
  it('ALERT_SEVERITIES mirrors the four db/schema.cds enum values', () => {
    expect(ALERT_SEVERITIES.map((s) => s.code)).toEqual([
      'Information', 'Success', 'Warning', 'Error',
    ]);
  });

  it('ALERT_AUDIENCES mirrors the three db/schema.cds enum values', () => {
    expect(ALERT_AUDIENCES.map((a) => a.code)).toEqual([
      'ALL', 'AUTHENTICATED', 'ADMIN',
    ]);
  });

  it('every entry has a string code and a string label', () => {
    for (const e of [...ALERT_SEVERITIES, ...ALERT_AUDIENCES]) {
      expect(typeof e.code).toBe('string');
      expect(typeof e.label).toBe('string');
      expect(e.code.length).toBeGreaterThan(0);
      expect(e.label.length).toBeGreaterThan(0);
    }
  });

  it('listAlertSeverities() returns a fresh shallow copy each call', () => {
    const a = listAlertSeverities();
    const b = listAlertSeverities();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    // Mutating the returned array does not affect the frozen source.
    a.pop();
    expect(listAlertSeverities()).toHaveLength(ALERT_SEVERITIES.length);
  });

  it('listAlertAudiences() returns a fresh shallow copy each call', () => {
    const a = listAlertAudiences();
    const b = listAlertAudiences();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run the test — should PASS since Task 1 already wrote the module.**

```bash
npx vitest run srv/lib/__tests__/alert-enums.test.js
```

Expected: `5 passed`. (We're writing the test second because the data is pure constants — a failing-test-first pass would only assert "module does not exist," which is noise. The test verifies content correctness, which is the real risk.)

- [ ] **Step 3: Commit.**

```bash
git add srv/lib/__tests__/alert-enums.test.js
git commit -m "test(#718): unit test for alert-enums constants"
```

---

## Task 3: Expose the code-list entities on AdminService

**Files:**
- Modify: `srv/admin-service.cds:241` (insert two lines after the `EventTypes` stub)

- [ ] **Step 1: Read context around line 241.**

```bash
sed -n '235,245p' srv/admin-service.cds
```

Confirm you see the `EventTypes` and `AdvocateRegions` stub entities — that's the insertion site.

- [ ] **Step 2: Edit `srv/admin-service.cds` — insert after line 241.**

Find:
```cds
  @readonly @cds.persistence.skip entity EventTypes       { key code : String(20); label : String(40); }
  @readonly @cds.persistence.skip entity AdvocateRegions  { key code : String(16); label : String(40); }
```

Insert between them:
```cds
  // Issue #718 — Alerts severity & audience dropdowns. Codes mirror the
  // inline enums on db/schema.cds:467-471 exactly; @assert.range on the
  // underlying fields rejects writes that bypass the dropdown.
  @readonly @cds.persistence.skip entity AlertSeverities  { key code : String(20); label : String(40); }
  @readonly @cds.persistence.skip entity AlertAudiences   { key code : String(20); label : String(40); }
```

Result:
```cds
  @readonly @cds.persistence.skip entity EventTypes       { key code : String(20); label : String(40); }
  // Issue #718 — Alerts severity & audience dropdowns. Codes mirror the
  // inline enums on db/schema.cds:467-471 exactly; @assert.range on the
  // underlying fields rejects writes that bypass the dropdown.
  @readonly @cds.persistence.skip entity AlertSeverities  { key code : String(20); label : String(40); }
  @readonly @cds.persistence.skip entity AlertAudiences   { key code : String(20); label : String(40); }
  @readonly @cds.persistence.skip entity AdvocateRegions  { key code : String(16); label : String(40); }
```

- [ ] **Step 3: Verify the CDS compiles.**

```bash
npx --no -- cds compile srv/admin-service.cds --to edmx --service AdminService 2>&1 | grep -E "AlertSeverities|AlertAudiences" | head -5
```

Expected output includes `<EntityType Name="AlertSeverities">` and `<EntityType Name="AlertAudiences">` and `<EntitySet Name="AlertSeverities"…>`, `<EntitySet Name="AlertAudiences"…>`. If you see a compile error instead, re-check that you matched the surrounding indentation (two-space, no tabs).

- [ ] **Step 4: Commit.**

```bash
git add srv/admin-service.cds
git commit -m "feat(#718): expose AlertSeverities & AlertAudiences code lists"
```

---

## Task 4: Wire READ handlers in admin-service.js

**Files:**
- Modify: `srv/admin-service.js:163` (insert after the `EventTypes` READ handler)

- [ ] **Step 1: Read context around the existing handler block.**

```bash
sed -n '153,170p' srv/admin-service.js
```

Confirm you see `this.on('READ', 'EventTypes', …)` ending around line 162 and `this.on('READ', 'AdvocateRegions', …)` starting around line 163.

- [ ] **Step 2: Add the import.**

Find the existing alert-cta import near the top of the file:
```js
import { listCtaTargets } from './lib/alert-cta-targets.js';
```

Add directly below it:
```js
import {
  listAlertSeverities,
  listAlertAudiences,
} from './lib/alert-enums.js';
```

- [ ] **Step 3: Add the two READ handlers.**

Insert between the `EventTypes` and `AdvocateRegions` handlers:

```js
    // Issue #718 — Alerts severity & audience DDLBs. Codes mirror the
    // inline enums on db/schema.cds:467-471 exactly (drift would surface
    // as @assert.range rejection on write). Labels are display-only.
    this.on('READ', 'AlertSeverities', () => listAlertSeverities());
    this.on('READ', 'AlertAudiences',  () => listAlertAudiences());
```

- [ ] **Step 4: Verify the file still parses.**

```bash
node --check srv/admin-service.js
```

Expected: exits 0 with no output. If you see a `SyntaxError`, re-check the inserted block's braces.

- [ ] **Step 5: Commit.**

```bash
git add srv/admin-service.js
git commit -m "feat(#718): READ handlers for AlertSeverities & AlertAudiences"
```

---

## Task 5: Wire the value help on the admin annotations

**Files:**
- Modify: `app/admin-annotations.cds:2783-2788` (replace the `severity` and `audience` annotation blocks)

- [ ] **Step 1: Read context.**

```bash
sed -n '2767,2792p' app/admin-annotations.cds
```

Confirm you see the `annotate AdminService.Alerts { … }` block with `title`, `body`, `severity`, `audience`, …, `ctaUrl` and the existing minimal `severity` / `audience` annotations.

- [ ] **Step 2: Replace the `severity` and `audience` annotation entries.**

Find this exact block (currently lines 2783-2788):
```cds
  severity    @Common.Label: 'Severity'
              @Common.ValueListWithFixedValues: true
              @assert.range: true;
  audience    @Common.Label: 'Audience'
              @Common.ValueListWithFixedValues: true
              @assert.range: true;
```

Replace with:
```cds
  severity    @Common.Label: 'Severity'
              @Common.ValueListWithFixedValues: true
              @Common.ValueList: {
                CollectionPath: 'AlertSeverities',
                Parameters: [
                  { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: severity, ValueListProperty: 'code'  },
                  { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
                ]
              }
              @assert.range: true;
  audience    @Common.Label: 'Audience'
              @Common.ValueListWithFixedValues: true
              @Common.ValueList: {
                CollectionPath: 'AlertAudiences',
                Parameters: [
                  { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: audience, ValueListProperty: 'code'  },
                  { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
                ]
              }
              @assert.range: true;
```

- [ ] **Step 3: Verify EDMX emits the expected annotations.**

```bash
npx --no -- cds compile srv/admin-service.cds --to edmx --service AdminService 2>&1 | grep -A 10 'Alerts/severity\|Alerts/audience' | head -50
```

Expected: each `Annotations Target="AdminService.Alerts/severity"` and `…/audience` block now contains a `<Annotation Term="Common.ValueList">` with `CollectionPath="AlertSeverities"` / `CollectionPath="AlertAudiences"`. If you only see the old `Validation.AllowedValues` block, the annotation wasn't picked up — re-check the indentation and the `:` after `CollectionPath`.

- [ ] **Step 4: Commit.**

```bash
git add app/admin-annotations.cds
git commit -m "feat(#718): @Common.ValueList annotations for Alerts severity & audience"
```

---

## Task 6: Full test sweep

**Files:** none modified.

- [ ] **Step 1: Run the focused test.**

```bash
npx vitest run srv/lib/__tests__/alert-enums.test.js srv/lib/__tests__/alert-cta-targets.test.js srv/lib/__tests__/alerts-endpoint.test.js
```

Expected: all three suites pass. `alert-cta-targets` and `alerts-endpoint` must continue passing — if either regresses, an unrelated edit slipped in.

- [ ] **Step 2: Run the full unit suite (smoke check that nothing CAP-level broke).**

```bash
npm test
```

Expected: green. If `cds build` complains about the new entities, you missed a colon or used a tab somewhere in the CDS edits.

- [ ] **Step 3: Lint check.**

```bash
npx cds lint srv/admin-service.cds app/admin-annotations.cds 2>&1 | tail -20
```

Expected: no new warnings/errors related to `Alerts`, `AlertSeverities`, or `AlertAudiences`.

---

## Task 7: Manual hybrid verification

**Files:** none modified (manual gate before PR).

- [ ] **Step 1: Make sure you're cf-logged in to the DEV space.**

```bash
cf target
```

Expected: org `tutorial-system`, space `dev`, eu10-005.

- [ ] **Step 2: Start hybrid dev (CAP + approuter against real HANA).**

```bash
npm run dev:hybrid
```

Wait until both the CAP srv on `:4004` and the approuter on `:5000` log ready. Do NOT use `cds watch` here — we want the credstore-bound hybrid env so XSUAA + draft handling are realistic.

- [ ] **Step 3: Browser check — log in and open the alerts admin.**

Navigate to <http://localhost:5000/admin-ui/#alerts-display>. Log in with your admin user.

- [ ] **Step 4: Verify the dropdown renders.**

Pick an existing alert (or click Create), click Edit / open the draft. The `Severity` and `Audience` fields MUST render as Select dropdowns. Confirm:
- Severity offers exactly: Information, Success, Warning, Error.
- Audience offers exactly: All visitors, Signed-in users, Admins only.

- [ ] **Step 5: Save round-trip.**

Change severity to `Warning`, save. Reopen the alert. Severity should display as `Warning` and the list-report column should render in yellow (the `severityCrit` virtual + Criticality is untouched).

- [ ] **Step 6: Public wire shape unchanged.**

```bash
curl -s http://localhost:5000/api/alerts | jq '.[] | {severity, audience}' | head -20
```

Expected: raw codes in the payload (`Information`, `ALL`, …) — same wire shape as before, with the friendly labels confined to the admin UI dropdown.

- [ ] **Step 7: Stop hybrid dev.** `Ctrl+C` both terminals.

---

## Task 8: PR

**Files:** none modified.

- [ ] **Step 1: Push the branch.**

```bash
git push -u origin fix/718-alerts-value-help
```

- [ ] **Step 2: Open a PR.**

```bash
gh pr create --base main --head fix/718-alerts-value-help \
  --title "fix(#718): value help for Alerts severity & audience" \
  --body "$(cat <<'EOF'
Closes #718.

Adds the missing `@Common.ValueList` annotations + backing code-list stub
entities (`AlertSeverities`, `AlertAudiences`) on the Alerts admin page so
`severity` and `audience` render as Select dropdowns instead of plain text
inputs in the object-page editor.

Mirrors the established pattern used for `EventTypes`, `MissionTypes`,
`TaskStatuses`, and `AlertCtaTargets` — same shape as PR #724 (Event Type
DDLB).

## What changed

- `srv/lib/alert-enums.js` — new `Object.freeze`d arrays + `list*()` getters.
- `srv/lib/__tests__/alert-enums.test.js` — unit test.
- `srv/admin-service.cds` — two `@readonly @cds.persistence.skip` entities.
- `srv/admin-service.js` — two `this.on('READ', …)` handlers.
- `app/admin-annotations.cds` — `@Common.ValueList` on `severity` + `audience`.

## What did NOT change

- `db/schema.cds` — inline enums unchanged; `@assert.range` still enforces.
- DB schema — no `cds build`, no HDI deploy.
- `srv-qa/` — no admin-service in srv-qa.
- `/api/alerts*` wire shape — friendly labels are admin-only.

## Verification

- `npx vitest run srv/lib/__tests__/alert-enums.test.js` — green.
- `npm test` — green.
- Manual hybrid: severity + audience render as Select with friendly labels;
  raw codes persist; severity list-report cell still renders with semantic
  Criticality coloring; `/api/alerts` wire shape unchanged.

Spec: docs/superpowers/specs/2026-06-28-718-alerts-value-help.md
EOF
)"
```

- [ ] **Step 3: Wait for CI green, request review.** Done.

---

## Rollback

Revert the merge commit. No DB state to roll back, no migration to undo.
