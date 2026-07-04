# @cap-js/data-privacy plugin adoption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install `@cap-js/data-privacy@^0.6.2` on the tutorials CAP srv, land the surrounding annotation cleanups (Concepts → change-tracking; 4 Users compositions upgraded; 4 `Other`-semantics entities upgraded to `DataSubjectDetails`; 2 kept as `Other` + `DataSubjectRole: 'Developer'`), wire the two plugin scopes into `xs-security.json`, expose `/dpp/information` and `/dpp/retention` through the approuter under `$XSAPPNAME.Admin`, and land the guarding unit + hybrid + smoke tests.

**Architecture:** The plugin ships built-in `sap.dpp.InformationService` (@requires `'PersonalDataManagerUser'`) and `sap.ilm.RetentionService` (@requires `'DataRetentionManagerUser'`), auto-exposed on any entity annotated `@PersonalData.EntitySemantics`. It skips UNION views for exposure (which is why the PR #957 compile break is subtle: it's CDS type inference through the UNION, not exposure), so removing `@PersonalData` from `Concepts` is the correct unblock. Retention durations are DPI-configured externally, not CDS-annotated — the earlier draft that proposed `P7Y` / `P1Y` / `P90D` annotations is superseded.

**Tech Stack:** SAP CAP 10, `@cap-js/data-privacy@^0.6.2`, `@cap-js/change-tracking`, `@cap-js/audit-logging`, XSUAA, Vitest (unit + hybrid + smoke), Node 20+, `cds build --production` for CSN refresh.

## Global Constraints

- **Plugin version pinned to `^0.6.2`** — the current 0.6.x line; upgrade to 1.0 in a follow-up when SAP tags GA.
- **xs-security.json is DUPLICATED** at repo root and `.deploy/xs-security.json`. Every edit must apply to both; `test/unit/xs-security-authorities.test.js` fails CI if they drift.
- **Anonymization cascade is annotation-driven**: adding `@PersonalData` + `cascade: 'delete'` to an entity means user anonymization NOW deletes rows there (behavior change intentional; see spec §2a).
- **`cds build --production` refreshes `db/last-dev/csn.json`** — must run after schema-annotation changes so `db/last-dev/` stays in sync (per CLAUDE.md rule).
- **Every commit follows Conventional Commits**: `feat(#960): ...`, `fix(#960): ...`, `docs(#960): ...`, `test(#960): ...`, `chore(#960): ...`.
- **Never edit `hugo/content/tutorials/**` and never touch generated `db/last-dev/csn.json` by hand** — regenerate via `cds build --production`.
- **Do not commit CONTENT_API_KEY, DPI credentials, or any secret**. This PR provisions scopes only.

---

## File map

**Modified**
- `package.json` — add `@cap-js/data-privacy` to `dependencies`
- `package-lock.json` — auto-updated by `npm install`
- `db/audit-logging.cds` — drop `Concepts` block; add 4 Users-composition annotations; upgrade 4 `Other → DataSubjectDetails` entities
- `db/analytics-builder.cds` — add `DataSubjectRole: 'Developer'` to `AnalyticsQueryHistory` and `AnalyticsSavedQuery`
- `db/change-tracking.cds` — add `annotate ims.Concepts with @changelog;`
- `xs-security.json` (root) — add 2 new scopes and 2 new grants in Admin role-template
- `.deploy/xs-security.json` — mirror byte-identical
- `approuter/xs-app.json` — add 2 routes for `/dpp/information` and `/dpp/retention`
- `docs/developers/architecture/authentication.md` — new "Data Privacy Integration" subsection under Admin-scoped API surfaces
- `db/last-dev/csn.json` — regenerated via `cds build --production` after every schema-annotation change

**Created**
- `test/unit/data-privacy-model.test.js` — model-shape assertions (Concepts absent from `@PersonalData`, 4 Users compositions correct, 4 Other→DataSubjectDetails upgrades correct, plugin services present)
- `test/unit/xs-security-dpp-scopes.test.js` — 2 new scopes exist and are granted to Admin, not to top-level `authorities`
- `test/smoke/dpp-endpoints.test.js` — 401 without auth, 200 with Admin bearer, baseline entity listing check
- `test/hybrid/anonymization-cascade-compositions.test.js` — seed & assert cascade-delete for PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs, DeveloperEnvironmentLinks

**Not modified (Option B intentional)**
- `db/views.cds` — `SearchableItems` unchanged; removing `@PersonalData` from `Concepts` upstream is enough
- `srv/analytics-service.cds` — no projection change
- `srv/search-service.cds` — no projection change
- No new `srv/dpp-annotations.cds` — plugin's own `@requires` are correct once scopes exist

---

## Task 1: Install plugin and confirm baseline compile

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (auto)
- Test: none in this task — deferred to Task 3+

**Interfaces:**
- Consumes: nothing
- Produces: `@cap-js/data-privacy` on `require`/`import`; plugin auto-registers via its `cds-plugin.js`

- [ ] **Step 1: Confirm current CAP srv compiles cleanly before any change**

Run: `npx cds compile srv/ --to json > /dev/null`
Expected: exits 0 with no errors printed. If it errors, STOP and diagnose before proceeding — the plan assumes a clean starting model.

- [ ] **Step 2: Install the plugin**

Run:
```bash
npm install @cap-js/data-privacy@^0.6.2 --save
```
Expected: single new entry in `package.json` `dependencies`, `package-lock.json` updated. No `--save-dev` — this ships to production.

- [ ] **Step 3: Attempt to compile the model with the plugin present**

Run: `npx cds compile srv/ --to json > /dev/null 2>&1`
Expected: FAIL with 8 model errors about `dppBlockingDate`/`ilmEarliestDestructionDate` on non-Concepts branches of `SearchableItems`. This is the exact PR #957 failure signature; confirming it here is a regression sanity check.

If the errors are DIFFERENT from that signature, STOP — the plugin may have changed behavior; re-read `db/views.cds:87-155` and `db/audit-logging.cds:76-82` and adjust the plan.

- [ ] **Step 4: Commit the install**

```bash
git add package.json package-lock.json
git commit -m "chore(#960): add @cap-js/data-privacy@^0.6.2 (fails to compile — unblocked in next commit)"
```

The commit message explicitly names the temporary broken state so a bisect lands on the right change. The next task fixes it.

---

## Task 2: Unblock compile — Concepts annotation swap

**Files:**
- Modify: `db/audit-logging.cds` (lines 76-82 — the `annotate ims.Concepts with @PersonalData` block)
- Modify: `db/change-tracking.cds` (append)
- Modify: `db/last-dev/csn.json` (regenerated)

**Interfaces:**
- Consumes: plugin installed (Task 1)
- Produces: model compiles cleanly; `Concepts` no longer in `@PersonalData` set; `Concepts` now `@changelog`-tracked

- [ ] **Step 1: Delete the Concepts `@PersonalData` block**

Open `db/audit-logging.cds`. Remove lines 76-82 verbatim (the whole comment + annotate block). Result — the space between `annotate ims.BranchDecisions ...` (which ends around line 74) and the Secrets section (starts around line 84) collapses.

The exact block to delete:
```cds
// Knowledge graph (#381). Concepts is admin-edited (merge / veto / rename) and
// while it carries no personal data, the audit-logging plugin's annotation-driven
// emission gives us a tamper-evident record of curation actions for free —
// mirrors how Categories / Missions admin edits are surfaced.
annotate ims.Concepts with @PersonalData: {
  EntitySemantics: 'Other'
};
```

Replace it with a single-line breadcrumb so a reader knows where the annotation moved:
```cds
// Concepts audit trail moved to @cds.changelog — see db/change-tracking.cds (#960).
```

- [ ] **Step 2: Add `Concepts` to change-tracking**

Open `db/change-tracking.cds`. Add a new line in the admin-editable entities group (near `annotate ims.Tutorials with @changelog;`):

```cds
// Concepts admin merge/veto/rename — audit trail moved here from @PersonalData (#960).
annotate ims.Concepts with @changelog;
```

- [ ] **Step 3: Compile check**

Run: `npx cds compile srv/ --to json > /dev/null`
Expected: exits 0 with no errors. If errors persist, either the deletion missed a line or the plugin's exposure engine is still tripping on something — re-inspect `SearchableItems` and the projections at `srv/analytics-service.cds:10` and `srv/search-service.cds:34`.

- [ ] **Step 4: Regenerate db/last-dev/csn.json**

Run: `npx cds build --production`
Expected: `db/last-dev/csn.json` updated. `git status db/last-dev/` shows exactly one modified file.

- [ ] **Step 5: Boot check — start srv and grep for data-privacy warnings from THIS change alone**

Run (in one shell, background):
```bash
npx cds watch --port 4004 2>&1 | tee /tmp/cds-boot-task2.log &
sleep 10
kill %1 || true
```
Then: `grep -c '\[data-privacy\]' /tmp/cds-boot-task2.log`
Expected: several warnings (the composition warnings we fix in Task 3, the `Other → DataSubjectDetails` warnings we fix in Task 4). NOT zero — those are our next tasks. If the srv fails to boot at all, STOP.

- [ ] **Step 6: Commit**

```bash
git add db/audit-logging.cds db/change-tracking.cds db/last-dev/csn.json
git commit -m "fix(#960): swap Concepts @PersonalData → @cds.changelog

Concepts holds no personal data (per its own inline comment); the
@PersonalData annotation existed only to register the entity with
@cap-js/audit-logging. Swapping to @cds.changelog keeps the admin
merge/veto/rename audit trail on the shared changelog surface at
/admin-ui/#changelog and unblocks @cap-js/data-privacy install by
preventing the plugin from injecting dppBlockingDate /
ilmEarliestDestructionDate on the Concepts branch of the
SearchableItems UNION.

Contributes to #960."
```

---

## Task 3: Fix "bad-practice" warnings — 4 Users compositions

**Files:**
- Modify: `db/audit-logging.cds` (append 4 annotate blocks)
- Modify: `db/last-dev/csn.json` (regenerated)

**Interfaces:**
- Consumes: clean compile from Task 2
- Produces: `PrizeRecords`, `AccomplishmentRecords`, `DeveloperEnvironmentTabs`, `DeveloperEnvironmentLinks` all carry `@PersonalData.EntitySemantics: 'DataSubjectDetails'` + `cascade: 'delete'`; anonymization-cascade plan now includes these 4 entities

- [ ] **Step 1: Append the 4 annotate blocks to `db/audit-logging.cds`**

Add at the end of the file, after the Advocates block (which currently ends at line 137):

```cds

// #960 — DataSubjectDetails compositions of ims.Users. The @cap-js/data-privacy
// plugin flags these as missing at boot (modelling bad-practice warning) because
// they compose off Users but carry no personal-data semantics. Adding
// EntitySemantics: 'DataSubjectDetails' + cascade: 'delete' both silences the
// warning AND fixes a latent bug: today these rows survive user anonymization
// as FK-ghosts pointing at anonymized ghost users. Field-level review confirmed
// none carries analytical value post-anonymization (see spec §2a).
annotate ims.PrizeRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

annotate ims.AccomplishmentRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

annotate ims.DeveloperEnvironmentTabs with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

// Links are nested inside Tabs; annotate the child for plugin completeness.
// Cascade-delete of the parent already cleans up Links via the composition
// (Composition of many DeveloperEnvironmentLinks on links.tab = $self at
// db/schema.cds:217) — the direct annotation here is belt-and-braces for
// the case where a Link exists without its parent Tab (which the schema
// prevents but the annotation should not assume).
annotate ims.DeveloperEnvironmentLinks with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  tab @PersonalData.FieldSemantics: 'DataSubjectID';
};
```

- [ ] **Step 2: Regenerate CSN and boot check**

Run: `npx cds build --production`
Then: `npx cds watch --port 4004 2>&1 | tee /tmp/cds-boot-task3.log &`, wait 10 sec, kill.
Run: `grep -c '\[data-privacy\].*DataSubjectDetails' /tmp/cds-boot-task3.log`
Expected: 0 warnings about missing `DataSubjectDetails` on compositions of Users.

- [ ] **Step 3: Commit**

```bash
git add db/audit-logging.cds db/last-dev/csn.json
git commit -m "feat(#960): annotate 4 Users compositions as DataSubjectDetails

PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs,
DeveloperEnvironmentLinks each get EntitySemantics: 'DataSubjectDetails'
+ cascade: 'delete'. Silences 4 boot warnings from @cap-js/data-privacy
AND fixes a latent anonymization-cascade gap: these rows previously
survived as FK-ghosts pointing at anonymized users. Hybrid test in
Task 5 covers the behavior change.

Contributes to #960."
```

---

## Task 4: Fix "bad-practice" warnings — upgrade 4 `Other` entities to `DataSubjectDetails`; add role to remaining 2

**Files:**
- Modify: `db/audit-logging.cds` (in-place edits on 4 existing blocks)
- Modify: `db/analytics-builder.cds` (in-place edits on 2 existing blocks)
- Modify: `db/last-dev/csn.json` (regenerated)

**Interfaces:**
- Consumes: clean compile from Task 3
- Produces: `CodeCheckSubmissions`, `ValidateAnswerSubmissions`, `AuthorAiRequests`, `BranchDecisions` upgraded to `DataSubjectDetails` + `cascade: 'delete'`; `AnalyticsQueryHistory` and `AnalyticsSavedQuery` keep `Other` but gain `DataSubjectRole: 'Developer'`

- [ ] **Step 1: Upgrade CodeCheckSubmissions in `db/audit-logging.cds`**

Find (currently lines ~48-53):
```cds
annotate ims.CodeCheckSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user          @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedCode @PersonalData.IsPotentiallyPersonal;
}
```
Replace with:
```cds
annotate ims.CodeCheckSubmissions with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user          @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedCode @PersonalData.IsPotentiallyPersonal;
}
```

- [ ] **Step 2: Upgrade ValidateAnswerSubmissions**

Find:
```cds
annotate ims.ValidateAnswerSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user            @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedAnswer @PersonalData.IsPotentiallyPersonal;
}
```
Replace with:
```cds
annotate ims.ValidateAnswerSubmissions with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user            @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedAnswer @PersonalData.IsPotentiallyPersonal;
}
```

- [ ] **Step 3: Upgrade AuthorAiRequests**

Find:
```cds
annotate ims.AuthorAiRequests with @PersonalData: {
  EntitySemantics: 'Other'
} {
  authorId       @PersonalData.FieldSemantics: 'DataSubjectID';
  sourceMarkdown @PersonalData.IsPotentiallyPersonal;
  variants       @PersonalData.IsPotentiallyPersonal;
}
```
Replace with:
```cds
annotate ims.AuthorAiRequests with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  authorId       @PersonalData.FieldSemantics: 'DataSubjectID';
  sourceMarkdown @PersonalData.IsPotentiallyPersonal;
  variants       @PersonalData.IsPotentiallyPersonal;
}
```

- [ ] **Step 4: Upgrade BranchDecisions**

Find:
```cds
annotate ims.BranchDecisions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
```
Replace with:
```cds
annotate ims.BranchDecisions with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
```

- [ ] **Step 5: Add DataSubjectRole to AnalyticsQueryHistory in `db/analytics-builder.cds`**

Find (currently line 20):
```cds
@PersonalData : { EntitySemantics: 'Other' }
entity AnalyticsQueryHistory : managed, AnalyticsQueryShape {
```
Replace with:
```cds
// #960 — 90-day retention enforced by cleanupChangeLog cron
// (srv/jobs/cleanup.js). DataSubjectRole tags the row as authored by
// a Developer / Admin for the DPI ILM object listing.
@PersonalData : { EntitySemantics: 'Other', DataSubjectRole: 'Developer' }
entity AnalyticsQueryHistory : managed, AnalyticsQueryShape {
```

- [ ] **Step 6: Add DataSubjectRole to AnalyticsSavedQuery**

Find (currently line 26):
```cds
@PersonalData    : { EntitySemantics: 'Other' }
@cds.changelog   : true
entity AnalyticsSavedQuery : managed, AnalyticsQueryShape {
```
Replace with:
```cds
@PersonalData    : { EntitySemantics: 'Other', DataSubjectRole: 'Developer' }
@cds.changelog   : true
entity AnalyticsSavedQuery : managed, AnalyticsQueryShape {
```

- [ ] **Step 7: Regenerate CSN and boot check**

Run: `npx cds build --production`
Then: `npx cds watch --port 4004 2>&1 | tee /tmp/cds-boot-task4.log &`, wait 10 sec, kill.
Run: `grep -c '\[data-privacy\]' /tmp/cds-boot-task4.log`
Expected: **0** warnings. If any survive, `grep '\[data-privacy\]' /tmp/cds-boot-task4.log` to see them and address before continuing.

- [ ] **Step 8: Commit**

```bash
git add db/audit-logging.cds db/analytics-builder.cds db/last-dev/csn.json
git commit -m "feat(#960): upgrade 4 Other→DataSubjectDetails; add role to 2 audit entities

Upgrades:
  CodeCheckSubmissions, ValidateAnswerSubmissions, AuthorAiRequests,
  BranchDecisions — each now EntitySemantics: DataSubjectDetails +
  cascade: 'delete'. These are genuinely user-owned rows; cascade-delete
  on anonymization is correct.

Kept-as-Other + role:
  AnalyticsQueryHistory (retention enforced by cleanupChangeLog cron —
  in-line comment documents the 90-day policy for future auditors),
  AnalyticsSavedQuery — DataSubjectRole: 'Developer'.

Zero @cap-js/data-privacy boot warnings after this commit.

Contributes to #960."
```

---

## Task 5: Hybrid test for the anonymization-cascade behavior change

**Files:**
- Create: `test/hybrid/anonymization-cascade-compositions.test.js`

**Interfaces:**
- Consumes: annotations from Tasks 3 and 4; existing `srv/lib/anonymization-cascade.js` `executeAnonymizationCascade(userId)` export
- Produces: hybrid test that seeds rows in the 4 new-cascade entities and asserts they are deleted post-anonymization

- [ ] **Step 1: Write the failing test**

Create `test/hybrid/anonymization-cascade-compositions.test.js` with:

```js
// #960 — Guards the anonymization cascade behavior change from spec §2a.
// After annotating PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs,
// DeveloperEnvironmentLinks with @PersonalData + cascade: 'delete', running
// executeAnonymizationCascade(userId) must delete rows in all four entities
// for that user. Prior to this PR the rows survived as FK-ghosts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { executeAnonymizationCascade } from '../../srv/lib/anonymization-cascade.js';
import '../hybrid/_guard.js';  // ALLOW_HYBRID_WRITES gate

const NS = 'com.sap.developers.ims';
const TAG = '__TEST__#960-cascade-compositions';
let userId;

describe('#960 anonymization cascade — 4 Users compositions delete on cascade', () => {
  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid write guard: set ALLOW_HYBRID_WRITES=true to run this suite');
    }
    await cds.connect.to('db');
    const { Users, PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs, DeveloperEnvironmentLinks, Events, Accomplishments } =
      cds.entities(NS);

    userId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: userId,
      firstName: `${TAG}-first`,
      lastName: `${TAG}-last`,
      email: `${TAG}-${userId}@example.test`
    });

    // Create a synthetic Event + Accomplishment for the FK targets so we do
    // not depend on seed data. Both are @TEST__-tagged for cleanup.
    const eventId = cds.utils.uuid();
    await INSERT.into(Events).entries({ ID: eventId, name: `${TAG}-evt` });
    const accId = cds.utils.uuid();
    await INSERT.into(Accomplishments).entries({ ID: accId, name: `${TAG}-acc` });

    await INSERT.into(PrizeRecords).entries({
      ID: cds.utils.uuid(), user_ID: userId, event_ID: eventId, prizeType: `${TAG}-prize`
    });
    await INSERT.into(AccomplishmentRecords).entries({
      ID: cds.utils.uuid(), user_ID: userId, accomplishment_ID: accId
    });
    const tabId = cds.utils.uuid();
    await INSERT.into(DeveloperEnvironmentTabs).entries({
      ID: tabId, user_ID: userId, tabName: `${TAG}-tab`
    });
    await INSERT.into(DeveloperEnvironmentLinks).entries({
      ID: cds.utils.uuid(), tab_ID: tabId, title: `${TAG}-link`, url: 'https://example.test/'
    });
  });

  afterAll(async () => {
    // Best-effort cleanup — cascade should have already zapped the child rows,
    // but wipe any remnants tagged with __TEST__#960.
    const { Users, PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs, DeveloperEnvironmentLinks, Events, Accomplishments } =
      cds.entities(NS);
    if (userId) await DELETE.from(Users).where({ ID: userId });
    await DELETE.from(PrizeRecords).where({ prizeType: { like: `${TAG}%` } });
    await DELETE.from(AccomplishmentRecords).where("accomplishment.name LIKE ?", [`${TAG}%`]);
    await DELETE.from(DeveloperEnvironmentLinks).where({ title: { like: `${TAG}%` } });
    await DELETE.from(DeveloperEnvironmentTabs).where({ tabName: { like: `${TAG}%` } });
    await DELETE.from(Events).where({ name: { like: `${TAG}%` } });
    await DELETE.from(Accomplishments).where({ name: { like: `${TAG}%` } });
  });

  it('deletes rows in all 4 composition entities on cascade', async () => {
    const { PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs, DeveloperEnvironmentLinks } =
      cds.entities(NS);

    // sanity: rows exist before cascade
    expect((await SELECT.from(PrizeRecords).where({ user_ID: userId })).length).toBe(1);
    expect((await SELECT.from(AccomplishmentRecords).where({ user_ID: userId })).length).toBe(1);
    expect((await SELECT.from(DeveloperEnvironmentTabs).where({ user_ID: userId })).length).toBe(1);

    // run cascade
    await executeAnonymizationCascade(userId);

    // rows gone
    expect((await SELECT.from(PrizeRecords).where({ user_ID: userId })).length).toBe(0);
    expect((await SELECT.from(AccomplishmentRecords).where({ user_ID: userId })).length).toBe(0);
    expect((await SELECT.from(DeveloperEnvironmentTabs).where({ user_ID: userId })).length).toBe(0);
    // Links are cascaded via parent Tabs; direct annotation also covers direct
    // Links → child rows are gone once Tabs are gone.
    expect((await SELECT.from(DeveloperEnvironmentLinks)
      .where("tab.user_ID = ?", [userId])).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail because cascade doesn't yet run in a hybrid context without executeAnonymizationCascade wired**

Run:
```bash
ALLOW_HYBRID_WRITES=true npx vitest run --project hybrid test/hybrid/anonymization-cascade-compositions.test.js
```
Expected: PASS if Tasks 3 and 4 landed correctly, since `executeAnonymizationCascade` walks the annotation-driven plan. If it FAILS, inspect the failure message:
- "unknown entity" → likely a namespace mismatch; check `cds.entities(NS)` returns the entity for the missing name.
- "row not deleted" → the annotation on that entity didn't take; recheck Task 3 or 4.

TDD note: this is the "verify green" step for Tasks 3+4 in real HANA. Unlike a classic red-green cycle, the underlying code (cascade walker) already exists; this test is the guard against future regression.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/anonymization-cascade-compositions.test.js
git commit -m "test(#960): hybrid — cascade-delete for 4 Users compositions

Seeds one row per entity (PrizeRecords, AccomplishmentRecords,
DeveloperEnvironmentTabs, DeveloperEnvironmentLinks) for a synthetic
user, then runs executeAnonymizationCascade and asserts all four
are deleted. Guards the anonymization-cascade behavior change from
Tasks 3 and 4."
```

---

## Task 6: Unit test — model-shape assertions

**Files:**
- Create: `test/unit/data-privacy-model.test.js`

**Interfaces:**
- Consumes: compiled model from Tasks 2-4; plugin from Task 1
- Produces: unit assertions locking in Concepts drop, 4 compositions annotated, 4 upgrades, 2 role additions, plugin services present

- [ ] **Step 1: Write the test**

Create `test/unit/data-privacy-model.test.js`:

```js
// #960 — Guards the exact @PersonalData shape after adopting @cap-js/data-privacy.
// Failures here mean a future annotation edit slipped past reviewers. Run in
// the unit workspace (in-memory SQLite, no external deps).

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

let model;
const NS = 'com.sap.developers.ims';

const withPd = (defs, name) => defs[`${NS}.${name}`]?.['@PersonalData'] ?? defs[`${NS}.${name}`]?.['@PersonalData.EntitySemantics'];

beforeAll(async () => {
  model = await cds.load(['db', 'srv']);
});

describe('#960 data-privacy model shape', () => {
  it('Concepts no longer carries @PersonalData (Section 1)', () => {
    const c = model.definitions[`${NS}.Concepts`];
    expect(c).toBeTruthy();
    // Neither the nested @PersonalData object nor the flat @PersonalData.EntitySemantics key
    // is present on Concepts anymore.
    expect(c['@PersonalData']).toBeUndefined();
    expect(c['@PersonalData.EntitySemantics']).toBeUndefined();
  });

  it('Concepts is @changelog-tracked (audit trail moved)', () => {
    const c = model.definitions[`${NS}.Concepts`];
    expect(c['@changelog'] || c['@cds.changelog']).toBeTruthy();
  });

  const dsDetailsWithDelete = [
    'PrizeRecords',
    'AccomplishmentRecords',
    'DeveloperEnvironmentTabs',
    'DeveloperEnvironmentLinks',
    // Section 2b upgrades
    'CodeCheckSubmissions',
    'ValidateAnswerSubmissions',
    'AuthorAiRequests',
    'BranchDecisions'
  ];

  it.each(dsDetailsWithDelete)('%s is DataSubjectDetails + cascade delete', (name) => {
    const def = model.definitions[`${NS}.${name}`];
    expect(def).toBeTruthy();
    const pd = def['@PersonalData'] || {
      EntitySemantics: def['@PersonalData.EntitySemantics'],
      cascade: def['@PersonalData.cascade']
    };
    expect(pd.EntitySemantics).toBe('DataSubjectDetails');
    expect(pd.cascade).toBe('delete');
  });

  const otherWithRole = ['AnalyticsQueryHistory', 'AnalyticsSavedQuery'];

  it.each(otherWithRole)('%s stays Other + gains DataSubjectRole: Developer', (name) => {
    const def = model.definitions[`${NS}.${name}`];
    expect(def).toBeTruthy();
    const pd = def['@PersonalData'] || {
      EntitySemantics: def['@PersonalData.EntitySemantics'],
      DataSubjectRole: def['@PersonalData.DataSubjectRole']
    };
    expect(pd.EntitySemantics).toBe('Other');
    expect(pd.DataSubjectRole).toBe('Developer');
  });

  it('plugin services are registered in the model (Section 4)', () => {
    // The plugin auto-injects sap.dpp.InformationService and sap.ilm.RetentionService
    // once @cap-js/data-privacy is installed. Absence here means the plugin
    // did not load — usually a missing dep or a syntax error upstream.
    expect(model.definitions['sap.dpp.InformationService']).toBeTruthy();
    expect(model.definitions['sap.ilm.RetentionService']).toBeTruthy();
  });

  it('plugin service @requires match plugin defaults (not overridden)', () => {
    const info = model.definitions['sap.dpp.InformationService'];
    const ret = model.definitions['sap.ilm.RetentionService'];
    expect(info['@requires']).toBe('PersonalDataManagerUser');
    expect(ret['@requires']).toBe('DataRetentionManagerUser');
  });
});
```

- [ ] **Step 2: Run and verify**

Run: `npx vitest run --project unit test/unit/data-privacy-model.test.js`
Expected: all assertions green. If a `it.each` case fails, the failure name identifies the entity that wasn't annotated correctly — go back to Task 3 or 4 for it.

- [ ] **Step 3: Commit**

```bash
git add test/unit/data-privacy-model.test.js
git commit -m "test(#960): unit — @PersonalData model shape after data-privacy adoption

Locks in the annotation shape from Tasks 2-4: Concepts dropped,
8 entities marked DataSubjectDetails+delete, 2 entities kept Other
with DataSubjectRole, plugin services present with plugin's own
@requires scopes. Runs in-memory SQLite, no external deps."
```

---

## Task 7: xs-security.json — add plugin scopes, grant to Admin

**Files:**
- Modify: `xs-security.json` (root)
- Modify: `.deploy/xs-security.json` (mirror byte-identical)
- Create: `test/unit/xs-security-dpp-scopes.test.js`

**Interfaces:**
- Consumes: nothing new (Tasks 1-4 already installed)
- Produces: 2 new scopes granted to Admin role-template; drift guard test passes

- [ ] **Step 1: Write the failing test**

Create `test/unit/xs-security-dpp-scopes.test.js`:

```js
// #960 — Regression guard for the two plugin scopes wired in xs-security.json.
// PersonalDataManagerUser and DataRetentionManagerUser are the plugin's built-in
// @requires; without them in the xsuaa scope set, /dpp/* endpoints return 403
// even for an Admin JWT.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const FILES = ['xs-security.json', '.deploy/xs-security.json'];

describe.each(FILES)('%s — data-privacy plugin scopes', (rel) => {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8'));

  it('declares $XSAPPNAME.PersonalDataManagerUser scope', () => {
    const names = cfg.scopes.map(s => s.name);
    expect(names).toContain('$XSAPPNAME.PersonalDataManagerUser');
  });

  it('declares $XSAPPNAME.DataRetentionManagerUser scope', () => {
    const names = cfg.scopes.map(s => s.name);
    expect(names).toContain('$XSAPPNAME.DataRetentionManagerUser');
  });

  it('Admin role-template holds both plugin scopes', () => {
    const admin = cfg['role-templates'].find(rt => rt.name === 'Admin');
    expect(admin).toBeTruthy();
    expect(admin['scope-references']).toContain('$XSAPPNAME.PersonalDataManagerUser');
    expect(admin['scope-references']).toContain('$XSAPPNAME.DataRetentionManagerUser');
  });

  it('does NOT auto-grant plugin scopes via top-level authorities', () => {
    expect(cfg.authorities).not.toContain('$XSAPPNAME.PersonalDataManagerUser');
    expect(cfg.authorities).not.toContain('$XSAPPNAME.DataRetentionManagerUser');
  });
});
```

- [ ] **Step 2: Run test — expect it to fail**

Run: `npx vitest run --project unit test/unit/xs-security-dpp-scopes.test.js`
Expected: FAIL — scopes not declared yet.

- [ ] **Step 3: Edit root `xs-security.json`**

Two edits:

**(a) Add the two new scopes to the `scopes` array.** Find (root file, around line 15):
```json
    { "name": "$XSAPPNAME.KnowledgeGraph.Admin", "description": "Knowledge graph admin: merge/veto concepts, run raw SPARQL" },
    { "name": "$XSAPPNAME.Everyone",           "description": "Baseline access" }
```
Replace with:
```json
    { "name": "$XSAPPNAME.KnowledgeGraph.Admin", "description": "Knowledge graph admin: merge/veto concepts, run raw SPARQL" },
    { "name": "$XSAPPNAME.PersonalDataManagerUser",  "description": "@cap-js/data-privacy plugin: gates /dpp/information (#960)" },
    { "name": "$XSAPPNAME.DataRetentionManagerUser", "description": "@cap-js/data-privacy plugin: gates /dpp/retention (#960)" },
    { "name": "$XSAPPNAME.Everyone",           "description": "Baseline access" }
```

**(b) Add the two scopes to the Admin role-template.** Find:
```json
    {
      "name": "Admin",
      "description": "Administrator",
      "scope-references": ["$XSAPPNAME.Admin", "$XSAPPNAME.KnowledgeGraph.Admin", "$XSAPPNAME.Everyone"]
    },
```
Replace with:
```json
    {
      "name": "Admin",
      "description": "Administrator",
      "scope-references": [
        "$XSAPPNAME.Admin",
        "$XSAPPNAME.KnowledgeGraph.Admin",
        "$XSAPPNAME.PersonalDataManagerUser",
        "$XSAPPNAME.DataRetentionManagerUser",
        "$XSAPPNAME.Everyone"
      ]
    },
```

Also update the SuperAdmin role-template to include the two scopes (SuperAdmin inherits from Admin conceptually). Find:
```json
    {
      "name": "SuperAdmin",
      "description": "Elevated Administrator (can publish/unpublish)",
      "scope-references": ["$XSAPPNAME.SuperAdmin", "$XSAPPNAME.Admin", "$XSAPPNAME.KnowledgeGraph.Admin", "$XSAPPNAME.Everyone"]
    },
```
Replace with:
```json
    {
      "name": "SuperAdmin",
      "description": "Elevated Administrator (can publish/unpublish)",
      "scope-references": [
        "$XSAPPNAME.SuperAdmin",
        "$XSAPPNAME.Admin",
        "$XSAPPNAME.KnowledgeGraph.Admin",
        "$XSAPPNAME.PersonalDataManagerUser",
        "$XSAPPNAME.DataRetentionManagerUser",
        "$XSAPPNAME.Everyone"
      ]
    },
```

- [ ] **Step 4: Mirror to `.deploy/xs-security.json`**

Run: `cp xs-security.json .deploy/xs-security.json`
This is the canonical way to keep them byte-identical.

- [ ] **Step 5: Run all xs-security tests together**

Run:
```bash
npx vitest run --project unit test/unit/xs-security-dpp-scopes.test.js test/unit/xs-security-authorities.test.js
```
Expected: both files green — new scopes assertions pass, byte-identical drift guard passes.

- [ ] **Step 6: Commit**

```bash
git add xs-security.json .deploy/xs-security.json test/unit/xs-security-dpp-scopes.test.js
git commit -m "feat(#960): add PersonalDataManagerUser + DataRetentionManagerUser scopes

@cap-js/data-privacy exposes /dpp/information and /dpp/retention with its
own @requires ('PersonalDataManagerUser' and 'DataRetentionManagerUser').
Add both scopes and grant to Admin + SuperAdmin role-templates so existing
Admin holders can call the endpoints pre-DPI. Neither is added to top-level
authorities (the auto-grant surface — Section A1 regression rule).

Mirrored root ↔ .deploy per xs-security-authorities.test.js drift guard.
New unit test locks in scope presence and grant assignment.

Contributes to #960."
```

---

## Task 8: Approuter route + xs-app.json

**Files:**
- Modify: `approuter/xs-app.json`

**Interfaces:**
- Consumes: scopes from Task 7
- Produces: `/dpp/information` and `/dpp/retention` reachable via approuter with Admin scope check at the perimeter

- [ ] **Step 1: Add the two routes to `approuter/xs-app.json`**

Find the `/admin/*` block starting around line 134:
```json
    {
      "source": "^/admin/(.*)$",
      "target": "/admin/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "scope": "$XSAPPNAME.Admin"
    },
```

Add immediately after that block (before the `/author/*` block):
```json
    {
      "source": "^/dpp/information(.*)$",
      "target": "/dpp/information$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "scope": "$XSAPPNAME.Admin"
    },
    {
      "source": "^/dpp/retention(.*)$",
      "target": "/dpp/retention$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "scope": "$XSAPPNAME.Admin"
    },
```

- [ ] **Step 2: Sanity-check JSON validity**

Run: `jq '.routes | map(.source) | .[]' approuter/xs-app.json | grep dpp`
Expected: exactly two lines — `"^/dpp/information(.*)$"` and `"^/dpp/retention(.*)$"`.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(#960): approuter routes for /dpp/information and /dpp/retention

Both routed to srv-api under $XSAPPNAME.Admin scope. Approuter is the
perimeter gate; the plugin's own @requires
(PersonalDataManagerUser / DataRetentionManagerUser, wired via
xs-security.json in the previous commit) is the second layer. Since
Admin role-template holds both plugin scopes, human-Admin access is
coherent end-to-end.

Contributes to #960."
```

---

## Task 9: Smoke test — /dpp/* end-to-end

**Files:**
- Create: `test/smoke/dpp-endpoints.test.js`

**Interfaces:**
- Consumes: deployed AppRouter + srv (SMOKE_BASE_URL, SMOKE_SRV_URL, an Admin bearer token in env)
- Produces: post-deploy smoke that both endpoints return 200 with a valid Admin bearer, and 401 without

- [ ] **Step 1: Write the test**

Create `test/smoke/dpp-endpoints.test.js`:

```js
// #960 — Smoke: /dpp/information and /dpp/retention behind approuter Admin gate.
// Runs against a live deployment. Requires SMOKE_BASE_URL (approuter) and
// SMOKE_ADMIN_TOKEN (Admin JWT) env vars. Skipped if SMOKE_BASE_URL not set.

import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const TOKEN = process.env.SMOKE_ADMIN_TOKEN;

const skip = !BASE;
const describeMaybe = skip ? describe.skip : describe;

if (skip) {
  console.warn('[smoke/dpp-endpoints] SMOKE_BASE_URL not set — suite skipped');
}

describeMaybe('#960 /dpp/* smoke', () => {
  it('/dpp/information without auth → 401', async () => {
    const res = await fetch(`${BASE}/dpp/information`);
    expect(res.status).toBe(401);
  });

  it('/dpp/retention without auth → 401', async () => {
    const res = await fetch(`${BASE}/dpp/retention`);
    expect(res.status).toBe(401);
  });

  if (TOKEN) {
    it('/dpp/information with Admin bearer → 200 and lists ≥ 10 personal-data entities', async () => {
      const res = await fetch(`${BASE}/dpp/information`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      // Baseline entities that should appear as either OData EntitySet names
      // or as annotations references in the metadata document.
      const baseline = [
        'Users', 'UserMetaData', 'UserLearningPreferences', 'TaskRecords',
        'AuthorAiRequests', 'AnalyticsQueryHistory', 'AnalyticsSavedQuery',
        'CodeCheckSubmissions', 'ValidateAnswerSubmissions', 'BranchDecisions',
        'Advocates', 'Secrets'
      ];
      const hits = baseline.filter(n => body.includes(n));
      expect(hits.length).toBeGreaterThanOrEqual(10);
    });

    it('/dpp/retention with Admin bearer → 200', async () => {
      const res = await fetch(`${BASE}/dpp/retention`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      expect(res.status).toBe(200);
    });
  } else {
    console.warn('[smoke/dpp-endpoints] SMOKE_ADMIN_TOKEN not set — bearer cases skipped');
  }
});
```

- [ ] **Step 2: (Optional local) Run against local hybrid**

If a hybrid stack is running (`npm run dev:hybrid`), the smoke test can be pointed there:
```bash
SMOKE_BASE_URL=http://localhost:5000 npx vitest run --project smoke test/smoke/dpp-endpoints.test.js
```
Expected: `/dpp/*` 401 cases pass; bearer cases skip without `SMOKE_ADMIN_TOKEN`. If nothing is running the whole suite skips — that's fine, this is a post-deploy check.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/dpp-endpoints.test.js
git commit -m "test(#960): smoke — /dpp/information and /dpp/retention

Runs against deployed AppRouter (SMOKE_BASE_URL). Verifies 401 without
auth, 200 with SMOKE_ADMIN_TOKEN, and that /dpp/information lists ≥10
baseline personal-data entities. Skipped when SMOKE_BASE_URL is unset."
```

---

## Task 10: Docs — authentication reference

**Files:**
- Modify: `docs/developers/architecture/authentication.md`

**Interfaces:**
- Consumes: everything above
- Produces: a subsection under Admin-scoped API surfaces documenting the two endpoints and the scope wiring

- [ ] **Step 1: Add a "Data Privacy Integration (DPI)" subsection**

Locate the existing "Admin-scoped API surfaces" section in `docs/developers/architecture/authentication.md` (search for "Admin-scoped" — if the exact heading differs, add the new section near where `/admin/*` route gating is documented; if no such section exists, add a top-level `## Data Privacy Integration (DPI)` at the end of the file).

Append:

```markdown
### Data Privacy Integration (`/dpp/*`)

The `@cap-js/data-privacy` plugin exposes two endpoints on the CAP srv:

- `GET /dpp/information` — DPI service consumes this to enumerate `@PersonalData`-annotated entities in the model. Backed by the plugin's `sap.dpp.InformationService` (`@requires: 'PersonalDataManagerUser'`).
- `GET /dpp/retention` — DPI service consumes this to enumerate entities eligible for retention-managed blocking + destruction. Backed by the plugin's `sap.ilm.RetentionService` (`@requires: 'DataRetentionManagerUser'`).

**Scope wiring.** Both plugin scopes are declared in `xs-security.json` (and mirrored to `.deploy/xs-security.json`) and granted to the `Admin` and `SuperAdmin` role-templates. This means every human-Admin JWT satisfies both the approuter perimeter check (`$XSAPPNAME.Admin`) and the plugin's own `@requires` at the srv. Once a real DPI service instance is provisioned, the standard shape (via `grant-as-authority-to-apps` in `xs-security.json`) will allow the DPI technical user to hold only these two scopes and not the wider `Admin` scope — see the plugin's own README for the `mta.yaml` template.

**Not implemented in #960.** DPI service instance provisioning, destination binding, retention-window configuration (DPI-side; CDS annotations do not carry retention durations for this plugin).
```

- [ ] **Step 2: Commit**

```bash
git add docs/developers/architecture/authentication.md
git commit -m "docs(#960): DPI endpoint auth documentation

Adds Data Privacy Integration subsection covering /dpp/information
and /dpp/retention scope wiring and the two plugin scopes granted
to Admin/SuperAdmin role-templates."
```

---

## Task 11: Full-repo verification and CLAUDE.md gotcha

**Files:**
- Modify: `CLAUDE.md` (append a Gotcha bullet)

**Interfaces:**
- Consumes: everything above
- Produces: green unit suite; new gotcha for future agents

- [ ] **Step 1: Run the whole unit suite locally**

Run: `npm test`
Expected: all green. Specifically the new files pass, and `xs-security-authorities.test.js` still passes (byte-identical drift guard).

- [ ] **Step 2: Run manifest validation if the repo has one**

Run: `npx cds build --production` (from repo root) — clean exit.
Then confirm `db/last-dev/csn.json` is fully in sync:
```bash
git diff --stat db/last-dev/csn.json
```
Expected: no uncommitted changes to `db/last-dev/csn.json` (all changes committed in Tasks 2-4).

- [ ] **Step 3: Append a Gotcha to CLAUDE.md**

Add to `CLAUDE.md` under the `## Gotchas` section (find the last bullet in the list; add after it):

```markdown
- **`@cap-js/data-privacy` (#960)** — Plugin auto-exposes `/dpp/information` and `/dpp/retention` on any entity annotated `@PersonalData.EntitySemantics`. It **skips UNION/JOIN views** for exposure but CDS type inference through a UNION containing an annotated + a non-annotated entity still trips compile (`SearchableItems` broke this way in PR #957). Retention **windows** are DPI-configured externally — the plugin does NOT read a CDS `@ILM.retentionPeriod` (or `@PersonalData.RetentionPeriod`, or `@Common.Ilm.retentionPeriod`) annotation to bound durations. Adopting the plugin means: (a) install; (b) resolve UNION type collisions by keeping `@PersonalData` off the mixed UNION legs; (c) wire the two plugin scopes (`PersonalDataManagerUser`, `DataRetentionManagerUser`) into `xs-security.json` and grant to Admin. Full runbook in `docs/superpowers/specs/2026-07-04-960-data-privacy-plugin-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(#960): CLAUDE.md gotcha for @cap-js/data-privacy plugin

Captures the two non-obvious plugin traits future agents need up front:
UNION type inference tripping compile, and the fact retention windows
live in DPI configuration (not CDS annotations)."
```

- [ ] **Step 5: Final verification**

Run: `npm test` — full green.
Run: `npx cds watch --port 4004 2>&1 | tee /tmp/cds-boot-final.log &`, wait 10 sec, kill.
Run: `grep -c '\[data-privacy\]' /tmp/cds-boot-final.log`
Expected: **0**. If nonzero, `grep '\[data-privacy\]' /tmp/cds-boot-final.log` to see which warnings survived — usually a typo in Task 3 or 4.

---

## Task 12: Ship it — commit-push-PR

**Files:** none new

- [ ] **Step 1: Confirm branch state**

Run: `git branch --show-current && git log --oneline -12`
Expected: current branch is the worktree branch for #960; log shows ~10 commits from Tasks 1-11.

- [ ] **Step 2: Push and open draft PR**

Run:
```bash
git push -u origin HEAD
gh pr create --draft \
  --title "feat(#960): adopt @cap-js/data-privacy plugin (DPI /dpp/* endpoints)" \
  --body "$(cat <<'EOF'
Adopts \`@cap-js/data-privacy@^0.6.2\`. Resolves compile break by dropping \`@PersonalData\` from \`Concepts\` (was audit-registration only) and moving admin curation audit to \`@cds.changelog\`. Wires plugin scopes into xs-security and grants to Admin/SuperAdmin. Adds unit, hybrid, and smoke coverage.

**Highlights**
- Concepts audit trail moved from audit-logging to change-tracking (no PII in Concepts per its own comment)
- 4 Users compositions annotated \`DataSubjectDetails\` + \`cascade: delete\` — cleans up anonymization FK-ghosts
- 4 audit entities upgraded to \`DataSubjectDetails\` + \`cascade: delete\`; \`AnalyticsQueryHistory\` / \`AnalyticsSavedQuery\` keep \`Other\` + gain \`DataSubjectRole: 'Developer'\`
- New scopes: \`\$XSAPPNAME.PersonalDataManagerUser\`, \`\$XSAPPNAME.DataRetentionManagerUser\` (Admin + SuperAdmin only, not in top-level \`authorities\`)
- Approuter routes for \`/dpp/information\` and \`/dpp/retention\` under \`\$XSAPPNAME.Admin\`
- Zero boot warnings from the plugin after this PR

**Spec:** docs/superpowers/specs/2026-07-04-960-data-privacy-plugin-design.md
**Closes:** #960

**Test plan**
- \`npm test\` green
- Post-deploy: SMOKE_BASE_URL + SMOKE_ADMIN_TOKEN run of test/smoke/dpp-endpoints.test.js
- Hybrid: \`ALLOW_HYBRID_WRITES=true npm run test:hybrid\` covers cascade behavior change

**Rollback:** \`npm uninstall @cap-js/data-privacy\` + revert. Annotation changes stay (already covered by audit-logging elsewhere).
EOF
)"
```
Expected: PR opened as draft, URL printed. Comment on the issue with the PR link.

- [ ] **Step 3: Report result**

Return: `result: PR #<num> opened as draft for #960 — 11-commit chain landing @cap-js/data-privacy plugin, annotation cleanups, and scope wiring.`

---

## Global self-review checklist

The plan author (writing-plans skill) has already verified:

1. **Spec coverage** — every §1-§5 section of the spec maps to at least one task:
   - §1 Plugin install + Concepts swap → Tasks 1 + 2
   - §2a 4 Users compositions → Task 3
   - §2b 4 upgrades + 2 role additions → Task 4
   - §3 (revised) Retention-via-DPI → covered as a side effect of Tasks 3 + 4; no separate task
   - §4 Approuter routes + xs-security wiring → Tasks 7 + 8
   - §5 Tests → Tasks 5, 6, 9
   - Docs → Task 10 + Task 11 (CLAUDE.md gotcha)
2. **Placeholder scan** — no "TBD", no "similar to Task N" (all code inlined), no "handle errors" without shown code.
3. **Type consistency** — `executeAnonymizationCascade(userId)` matches the exported signature in `srv/lib/anonymization-cascade.js`. Entity names checked against `db/schema.cds`. Namespace `com.sap.developers.ims` verified.
4. **Ordering** — the compile-break-then-fix sequence in Tasks 1-2 is intentional (bisectability); each subsequent task keeps compile green.
