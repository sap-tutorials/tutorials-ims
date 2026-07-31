# Devtoberfest Gameboard — Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a new, independently-deployed CAP MTA (`sap-community-gameboard`) that shares the tutorial system's XSUAA, reads two provider HANA containers cross-container, and serves a working public leaderboard end-to-end through the tutorial approuter.

**Architecture:** A separate CAP Node.js app in its own repo/MTA, deployed into the SAME BTP subaccount + CF org/space as `tutorials-ims` and `devtoberfest-planner`. It binds the shared `tutorials-xsuaa` (resource server), and its HDI container (`gameboard-db`) is a pure cross-container *consumer* of (1) the planner's already-granted `DTF_ACTIVITY_V1` and (2) two NEW views the tutorial system publishes out of `tutorials-hana` (`GAMEBOARD_PARTICIPANT_V1`, `GAMEBOARD_COMPLETION_V1`). The tutorial approuter proxies `/gameboard/*` to this new backend.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` v8/CAP 10 baseline), SAP HANA Cloud (HDI, `.hdbview`/`.hdbrole`/`.hdbsynonym`/`.hdbgrants`), MTA (`mbt`/`cf deploy`), XSUAA, Cloud Foundry (eu10). Provider-side changes land in the `tutorials-ims` repo; consumer-side changes land in the new `sap-community-gameboard` repo.

## Global Constraints

- **Deploy target is fixed:** same BTP subaccount + same CF org/space as `tutorials-ims` and `devtoberfest-planner` (guarantees same HANA Cloud instance for cross-container HDI, and same XSUAA/landscape). This is mandatory, not optional.
- **Cross-container HDI works only within ONE HANA Cloud instance** — all three containers (`gameboard-db`, `tutorials-hana`, `devtoberfest-planner-db`) must be co-located. Verify instance identity via `cf` service keys, NEVER `cds bind`.
- **Provider views are versioned `_V1` and never expose base tables.** Every output column is aliased **UPPERCASE** (cross-container workbook decision D4a) — camelCase aliases break the consumer's generated facade view.
- **`@cds.persistence.exists` facades must match the deployed view's column names char-for-char.** CAP references facade columns unquoted → HANA folds to UPPERCASE, so a camelCase facade element resolves to the UPPERCASE physical column.
- **Least-privilege reader role per provider domain**, plus a grantable `#` variant for the consumer's `object_owner` to re-grant to its `application_user`.
- **Bootstrap is base-then-enable:** publish provider views + roles FIRST, deploy them, THEN deploy the consumer's grants + synonyms. A consumer synonym over a non-existent view fails HDI deploy.
- **Tutorial slugs are lowercase-canonical.** Any slug the view emits is lowercased; the consumer matches slug-to-slug.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** (LOB locator expiry) — not expected in Plan A, but noted for the shared convention.
- **Dual mta.yaml in tutorials-ims:** mirror every provider-side `mta.yaml` change into `.deploy/mta.yaml`.
- **Fail-soft reads:** a cross-container read fault degrades to an empty-but-valid response, never a 500.
- **HANA stores columns UPPERCASE;** hand-authored `.hdbview` SOURCE identifiers must be UPPERCASE and quoted.

## Interface Contracts (locked — consumed by Plans B–E)

These names are frozen here. Later plans reference them verbatim.

**Provider views published by `tutorials-hana` (UPPERCASE columns):**

```
GAMEBOARD_PARTICIPANT_V1
  USER_ID               NVARCHAR(36)   -- Users.ID
  FIRST_NAME            NVARCHAR(255)
  LAST_INITIAL          NVARCHAR(1)    -- first char of Users.lastName, else ''
  COMMUNITY_ID          NVARCHAR(32)   -- Users.khorosId, NULL unless opted-in
  COMMUNITY_LOGIN       NVARCHAR(64)   -- Users.khorosLogin, NULL unless opted-in
  JOINED_AT             TIMESTAMP      -- EventRegistrations.joinedAt
  EVENT_ID              NVARCHAR(36)   -- Events.ID (active DEVTOBERFEST event)

GAMEBOARD_COMPLETION_V1
  USER_ID               NVARCHAR(36)   -- TaskRecords.user_ID
  TUTORIAL_SLUG         NVARCHAR(255)  -- resolved + lowercased (Tutorials.slug)
  TASK_TYPE             NVARCHAR(20)   -- TaskRecords.taskType
  COMPLETION_DATE       TIMESTAMP      -- TaskRecords.completionDate
  EVENT_ID              NVARCHAR(36)   -- TaskRecords.event_ID
```

**Consumer CDS facades (`sap-community-gameboard/db/external/`):** entities `GameboardParticipantV1`, `GameboardCompletionV1` (over the two views above), and `DtfActivityV1` (over the planner's `DTF_ACTIVITY_V1`), with camelCase elements mapping to the UPPERCASE physical columns.

**Public leaderboard read (frozen signature, implemented in Plan A minimally, extended in Plan B):**

```
GameboardService @(path:'/gameboard') @(requires:'any')
  function getLeaderboard(top: Integer) returns array of LeaderboardRow;
  type LeaderboardRow {
    rank         : Integer;
    displayName  : String;   // "Tom J." or "Tom J. (community)" when linked
    score        : Integer;  // Σ points; 0 in Plan A stub
    level        : Integer;  // 0 in Plan A stub
    communityUrl : String;   // null unless COMMUNITY_LOGIN present
  }
```

---

### Task 1: Provider views + reader role in `tutorials-ims`

**Repo:** `tutorials-ims` (the tutorial system). This is the base half of base-then-enable and must deploy before anything in the new repo.

**Files:**
- Create: `db/src/GAMEBOARD_PARTICIPANT_V1.hdbview`
- Create: `db/src/GAMEBOARD_COMPLETION_V1.hdbview`
- Create: `db/src/gameboard_reader.hdbrole`
- Create: `db/src/gameboard_reader_grantable.hdbrole`
- Test: `test/hybrid/gameboard-views.test.js`

**Interfaces:**
- Consumes: existing physical tables `COM_SAP_DEVELOPERS_IMS_USERS`, `COM_SAP_DEVELOPERS_IMS_EVENTREGISTRATIONS`, `COM_SAP_DEVELOPERS_IMS_EVENTS`, `COM_SAP_DEVELOPERS_IMS_TASKRECORDS`, `COM_SAP_DEVELOPERS_IMS_TUTORIALS`.
- Produces: the two `_V1` views + `gameboard_reader`/`gameboard_reader#` roles named in the Interface Contracts.

- [ ] **Step 1: Write the failing hybrid test**

`test/hybrid/gameboard-views.test.js`:

```js
const cds = require('@sap/cds');
const { expect } = require('chai');

describe('gameboard provider views', () => {
  const db = cds.connect.to('db');
  it('GAMEBOARD_PARTICIPANT_V1 resolves and exposes the frozen columns', async () => {
    const rows = await (await db).run(
      `SELECT TOP 1 "USER_ID","FIRST_NAME","LAST_INITIAL","COMMUNITY_ID","COMMUNITY_LOGIN","JOINED_AT","EVENT_ID" FROM "GAMEBOARD_PARTICIPANT_V1"`
    );
    expect(rows).to.be.an('array');
  });
  it('GAMEBOARD_COMPLETION_V1 resolves and exposes the frozen columns', async () => {
    const rows = await (await db).run(
      `SELECT TOP 1 "USER_ID","TUTORIAL_SLUG","TASK_TYPE","COMPLETION_DATE","EVENT_ID" FROM "GAMEBOARD_COMPLETION_V1"`
    );
    expect(rows).to.be.an('array');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/hybrid/gameboard-views.test.js --project hybrid` (needs `cf login` + `cds bind`).
Expected: FAIL — views do not exist yet (`invalid view name`).

- [ ] **Step 3: Write `GAMEBOARD_PARTICIPANT_V1.hdbview`**

```sql
VIEW "GAMEBOARD_PARTICIPANT_V1" AS
  SELECT r."USER_ID"                              AS "USER_ID",
         u."FIRSTNAME"                            AS "FIRST_NAME",
         LEFT(COALESCE(u."LASTNAME", ''), 1)      AS "LAST_INITIAL",
         u."KHOROSID"                             AS "COMMUNITY_ID",
         u."KHOROSLOGIN"                          AS "COMMUNITY_LOGIN",
         r."JOINEDAT"                             AS "JOINED_AT",
         r."EVENT_ID"                             AS "EVENT_ID"
  FROM "COM_SAP_DEVELOPERS_IMS_EVENTREGISTRATIONS" r
  JOIN "COM_SAP_DEVELOPERS_IMS_USERS"  u ON u."ID" = r."USER_ID"
  JOIN "COM_SAP_DEVELOPERS_IMS_EVENTS" e ON e."ID" = r."EVENT_ID"
  WHERE e."EVENTTYPE" = 'DEVTOBERFEST'
```

Note: `COMMUNITY_ID`/`COMMUNITY_LOGIN` come straight from `Users.khorosId`/`khorosLogin` (issue #566 opt-in linkage); they are NULL for unlinked users, which the consumer treats as "anonymize."

- [ ] **Step 4: Write `GAMEBOARD_COMPLETION_V1.hdbview`**

The slug is resolved inside the container by joining `TaskRecords.taskLegacyId` → `Tutorials.legacyId`, and lowercased:

```sql
VIEW "GAMEBOARD_COMPLETION_V1" AS
  SELECT tr."USER_ID"                       AS "USER_ID",
         LOWER(t."SLUG")                     AS "TUTORIAL_SLUG",
         tr."TASKTYPE"                       AS "TASK_TYPE",
         tr."COMPLETIONDATE"                 AS "COMPLETION_DATE",
         tr."EVENT_ID"                       AS "EVENT_ID"
  FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" tr
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS"   t ON t."LEGACYID" = tr."TASKLEGACYID"
  WHERE tr."STATUS" = 'COMPLETED'
    AND tr."TASKTYPE" = 'TUTORIAL'
```

Note: scoped to `TASK_TYPE='TUTORIAL'` because the planner's `Activity.tutorialSlug` links to tutorials/puzzles via `TASK_VALUE_HELP_V1`; §10 of the spec flags validating whether non-TUTORIAL activity types exist for a given edition — if they do, this WHERE clause widens in a follow-up. Event-window bounding is done by the consumer against the active event, so no date filter here (keeps the view edition-agnostic).

- [ ] **Step 5: Write the reader roles**

`db/src/gameboard_reader.hdbrole`:

```json
{
  "role": {
    "name": "gameboard_reader",
    "object_privileges": [
      { "name": "GAMEBOARD_PARTICIPANT_V1", "type": "VIEW", "privileges": [ "SELECT" ] },
      { "name": "GAMEBOARD_COMPLETION_V1",  "type": "VIEW", "privileges": [ "SELECT" ] }
    ]
  }
}
```

`db/src/gameboard_reader_grantable.hdbrole`:

```json
{
  "role": {
    "name": "gameboard_reader#",
    "object_privileges": [
      { "name": "GAMEBOARD_PARTICIPANT_V1", "type": "VIEW", "privileges_with_grant_option": [ "SELECT" ] },
      { "name": "GAMEBOARD_COMPLETION_V1",  "type": "VIEW", "privileges_with_grant_option": [ "SELECT" ] }
    ]
  }
}
```

- [ ] **Step 6: Deploy the db module and run the test**

Run: `npm run build:all` is NOT needed (DB-only). Deploy the db-deployer module per the repo runbook (`npm run deploy -- --env dev` scoped to the db-deployer, or full deploy). Then:
Run: `npx vitest run test/hybrid/gameboard-views.test.js --project hybrid`
Expected: PASS — both views resolve and return arrays.

- [ ] **Step 7: Commit (on a `tutorials-ims` feature branch, open a PR)**

```bash
git add db/src/GAMEBOARD_PARTICIPANT_V1.hdbview db/src/GAMEBOARD_COMPLETION_V1.hdbview \
        db/src/gameboard_reader.hdbrole db/src/gameboard_reader_grantable.hdbrole \
        test/hybrid/gameboard-views.test.js
git commit -m "feat(gameboard): publish GAMEBOARD_*_V1 provider views + gameboard_reader role"
```

---

### Task 2: New repo scaffold + minimal CAP app

**Repo:** NEW `sap-community-gameboard` on `github.tools.sap/developer-relations`.

**Files:**
- Create: `package.json`, `.cdsrc.json`, `srv/gameboard-service.cds`, `srv/gameboard-service.js`, `db/.gitkeep`
- Test: `test/unit/service-boot.test.js`

**Interfaces:**
- Produces: `GameboardService` at `@path:'/gameboard'`, `@requires:'any'`, with the frozen `getLeaderboard(top)` function returning `LeaderboardRow[]` (stubbed to `[]` here).

- [ ] **Step 1: Write the failing boot test**

`test/unit/service-boot.test.js`:

```js
const cds = require('@sap/cds');
const { expect } = require('chai');
const { GET } = cds.test(__dirname + '/../..');

describe('GameboardService boots', () => {
  it('serves getLeaderboard anonymously', async () => {
    const { data } = await GET(`/gameboard/getLeaderboard(top=10)`);
    expect(data.value).to.deep.equal([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/unit/service-boot.test.js`
Expected: FAIL — no project/service yet.

- [ ] **Step 3: Scaffold `package.json` + `.cdsrc.json`**

`package.json` (minimal CAP app; SQLite for local/unit, HANA for hybrid/prod):

```json
{
  "name": "sap-community-gameboard",
  "version": "0.1.0",
  "engines": { "node": "^22 || ^24" },
  "dependencies": { "@sap/cds": "^8", "@sap/xssec": "^4", "express": "^4" },
  "devDependencies": { "@cap-js/sqlite": "^1", "vitest": "^2", "chai": "^5" },
  "cds": {
    "requires": {
      "auth": { "kind": "xsuaa" },
      "db": { "kind": "sqlite", "[production]": { "kind": "hana", "impl": "@sap/cds/lib" } }
    }
  }
}
```

`.cdsrc.json`: `{ "build": { "target": "gen" } }`

- [ ] **Step 4: Write `srv/gameboard-service.cds`**

```cds
service GameboardService @(path: '/gameboard') @(requires: 'any') {
  type LeaderboardRow {
    rank         : Integer;
    displayName  : String;
    score        : Integer;
    level        : Integer;
    communityUrl : String;
  }
  function getLeaderboard(top: Integer) returns array of LeaderboardRow;
}
```

- [ ] **Step 5: Write `srv/gameboard-service.js` (stub)**

```js
const cds = require('@sap/cds');
module.exports = class GameboardService extends cds.ApplicationService {
  async init() {
    this.on('getLeaderboard', async () => []);
    return super.init();
  }
};
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run test/unit/service-boot.test.js`
Expected: PASS — `data.value` is `[]`.

- [ ] **Step 7: Commit**

```bash
git add package.json .cdsrc.json srv/ test/ db/.gitkeep
git commit -m "feat: scaffold gameboard CAP app with stubbed getLeaderboard"
```

---

### Task 3: Consumer cross-container facades + synonyms + grants

**Repo:** `sap-community-gameboard`. The enable half of base-then-enable. Task 1 must be deployed first.

**Files:**
- Create: `db/external/gameboard.cds` (facades over the two tutorial views)
- Create: `db/external/planner.cds` (facade over `DTF_ACTIVITY_V1`)
- Create: `db/src/GAMEBOARD_PARTICIPANT_V1.hdbsynonym` (+ `.hdbsynonymconfig`)
- Create: `db/src/GAMEBOARD_COMPLETION_V1.hdbsynonym` (+ `.hdbsynonymconfig`)
- Create: `db/src/DTF_ACTIVITY_V1.hdbsynonym` (+ `.hdbsynonymconfig`)
- Create: `db/src/tutorials-grants.hdbgrants`, `db/src/devtoberfest-grants.hdbgrants`
- Test: `test/hybrid/facades-resolve.test.js`

**Interfaces:**
- Consumes: the deployed views/roles from Task 1 + the planner's existing `DTF_ACTIVITY_V1` + `devtoberfest_reader#`/`devtoberfest_reader`.
- Produces: CDS entities `GameboardParticipantV1`, `GameboardCompletionV1`, `DtfActivityV1`.

- [ ] **Step 1: Write the failing facade-resolve test**

`test/hybrid/facades-resolve.test.js`:

```js
const cds = require('@sap/cds');
const { expect } = require('chai');

describe('cross-container facades resolve', () => {
  it('reads all three facades without throwing', async () => {
    const db = await cds.connect.to('db');
    const { GameboardParticipantV1, GameboardCompletionV1, DtfActivityV1 } = db.entities('external');
    expect(await db.run(SELECT.from(GameboardParticipantV1).limit(1))).to.be.an('array');
    expect(await db.run(SELECT.from(GameboardCompletionV1).limit(1))).to.be.an('array');
    expect(await db.run(SELECT.from(DtfActivityV1).limit(1))).to.be.an('array');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/hybrid/facades-resolve.test.js --project hybrid`
Expected: FAIL — synonyms/facades not deployed.

- [ ] **Step 3: Write `db/external/gameboard.cds`**

```cds
namespace external;

// @cds.persistence.exists proxies over cross-container synonyms targeting
// tutorials-hana views GAMEBOARD_PARTICIPANT_V1 / GAMEBOARD_COMPLETION_V1.
// camelCase elements resolve to UPPERCASE physical columns (workbook D4a).
@cds.persistence.exists
entity GameboardParticipantV1 {
  key userId        : String(36);
      firstName     : String(255);
      lastInitial   : String(1);
      communityId   : String(32);
      communityLogin: String(64);
      joinedAt      : Timestamp;
      eventId       : String(36);
}

@cds.persistence.exists
entity GameboardCompletionV1 {
  key userId        : String(36);
  key tutorialSlug  : String(255);
      taskType      : String(20);
      completionDate: Timestamp;
      eventId       : String(36);
}
```

- [ ] **Step 4: Write `db/external/planner.cds`**

```cds
namespace external;

// Proxy over DTF_ACTIVITY_V1 (devtoberfest-planner-db), already granted via
// devtoberfest_reader. Columns copied from the deployed view (UPPERCASE).
@cds.persistence.exists
entity DtfActivityV1 {
  key id            : String(36);
      title         : String(200);
      trackId       : String(36);
      status        : String(40);
      week          : String(1);
      points        : Integer;
      tutorialSlug  : String(255);
      tutorialTitle : String(255);
      tutorialId    : String(36);
}
```

- [ ] **Step 5: Write the six synonym files**

`db/src/GAMEBOARD_PARTICIPANT_V1.hdbsynonym`:

```json
{ "GAMEBOARD_PARTICIPANT_V1": { "target": { "object": "GAMEBOARD_PARTICIPANT_V1" } } }
```

`db/src/GAMEBOARD_PARTICIPANT_V1.hdbsynonymconfig`:

```json
{ "GAMEBOARD_PARTICIPANT_V1": { "target": { "object": "GAMEBOARD_PARTICIPANT_V1", "schema.configure": "tutorials-hana/schema" } } }
```

Repeat identically for `GAMEBOARD_COMPLETION_V1` (target `tutorials-hana/schema`) and `DTF_ACTIVITY_V1` (target `devtoberfest-planner-db/schema`).

- [ ] **Step 6: Write the two grants files**

`db/src/tutorials-grants.hdbgrants`:

```json
{
  "tutorials-hana": {
    "object_owner":     { "container_roles": [ "gameboard_reader#" ] },
    "application_user": { "container_roles": [ "gameboard_reader" ] }
  }
}
```

`db/src/devtoberfest-grants.hdbgrants`:

```json
{
  "devtoberfest-planner-db": {
    "object_owner":     { "container_roles": [ "devtoberfest_reader#" ] },
    "application_user": { "container_roles": [ "devtoberfest_reader" ] }
  }
}
```

- [ ] **Step 7: Deploy db module + run the test**

Deploy the gameboard db-deployer (Task 5 wires the MTA; for an interim check use `cds deploy` against the bound container). Then:
Run: `npx vitest run test/hybrid/facades-resolve.test.js --project hybrid`
Expected: PASS — all three facades return arrays.

- [ ] **Step 8: Commit**

```bash
git add db/external/ db/src/
git commit -m "feat(db): cross-container facades, synonyms, grants for both providers"
```

---

### Task 4: Real leaderboard read (participants only, score stubbed to 0)

**Repo:** `sap-community-gameboard`. Proves the consumer can actually read tutorial data end-to-end; full scoring is Plan B.

**Files:**
- Modify: `srv/gameboard-service.js`
- Create: `srv/lib/active-event.js`
- Test: `test/hybrid/leaderboard-read.test.js`

**Interfaces:**
- Consumes: `GameboardParticipantV1` facade.
- Produces: `getActiveEventId()` helper; `getLeaderboard(top)` returning real participant rows (rank by `joinedAt`, `score:0`, `level:0`, `displayName` = `"First L."` or `"First L. (community)"` when `communityLogin` present, `communityUrl` = `https://community.sap.com/t5/user/viewprofilepage/user-id/<communityId>` or null).

- [ ] **Step 1: Write the failing test**

`test/hybrid/leaderboard-read.test.js`:

```js
const cds = require('@sap/cds');
const { expect } = require('chai');
const { GET } = cds.test(__dirname + '/../..');

describe('getLeaderboard reads real participants', () => {
  it('returns participant rows with anonymized display names', async () => {
    const { data } = await GET(`/gameboard/getLeaderboard(top=5)`);
    expect(data.value).to.be.an('array');
    if (data.value.length) {
      const row = data.value[0];
      expect(row).to.have.keys(['rank','displayName','score','level','communityUrl']);
      expect(row.displayName).to.match(/^.+ .\.?( \(community\))?$/);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/hybrid/leaderboard-read.test.js --project hybrid`
Expected: FAIL — still returns `[]`.

- [ ] **Step 3: Write `srv/lib/active-event.js`**

```js
// Resolves the active DEVTOBERFEST event id from the participant view
// (every participant row carries EVENT_ID for the active event). Returns
// null if there are no participants (fail-soft).
module.exports.getActiveEventId = async (db, ParticipantV1) => {
  const [row] = await db.run(SELECT.one.from(ParticipantV1).columns('eventId'));
  return row ? row.eventId : null;
};
```

- [ ] **Step 4: Implement `getLeaderboard`**

```js
const cds = require('@sap/cds');
const { getActiveEventId } = require('./lib/active-event');

module.exports = class GameboardService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { GameboardParticipantV1 } = db.entities('external');

    this.on('getLeaderboard', async (req) => {
      const top = req.data.top || 25;
      try {
        const eventId = await getActiveEventId(db, GameboardParticipantV1);
        if (!eventId) return [];
        const parts = await db.run(
          SELECT.from(GameboardParticipantV1)
            .where({ eventId })
            .orderBy('joinedAt asc')
            .limit(top)
        );
        return parts.map((p, i) => ({
          rank: i + 1,
          displayName: `${p.firstName} ${(p.lastInitial || '').toUpperCase()}.`
            + (p.communityLogin ? ' (community)' : ''),
          score: 0,
          level: 0,
          communityUrl: p.communityId
            ? `https://community.sap.com/t5/user/viewprofilepage/user-id/${p.communityId}`
            : null
        }));
      } catch (e) {
        cds.log('gameboard').warn('getLeaderboard failed, returning empty', e);
        return []; // fail-soft
      }
    });
    return super.init();
  }
};
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/hybrid/leaderboard-read.test.js --project hybrid`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/gameboard-service.js srv/lib/active-event.js test/hybrid/leaderboard-read.test.js
git commit -m "feat(gameboard): real participant leaderboard read (score stubbed)"
```

---

### Task 5: MTA + shared XSUAA binding + both container bindings

**Repo:** `sap-community-gameboard`.

**Files:**
- Create: `mta.yaml`
- Create: `xs-security.json` (reference only — the shared instance owns scopes; this documents the expected xsappname)
- Test: `test/smoke/boot-smoke.test.js` (post-deploy)

**Interfaces:**
- Consumes: existing-services `tutorials-xsuaa`, `tutorials-hana`, `devtoberfest-planner-db`.
- Produces: deployable MTA with modules `gameboard-srv` (nodejs) + `gameboard-db-deployer` (hdb); `gameboard-srv` provides `gameboard-srv-api` (the URL the tutorial approuter proxies to).

- [ ] **Step 1: Write `mta.yaml`**

```yaml
_schema-version: '3.3'
ID: sap-community-gameboard
version: 0.1.0
modules:
  - name: gameboard-srv
    type: nodejs
    path: gen/srv
    requires:
      - name: tutorials-xsuaa
      - name: gameboard-db
      - name: tutorials-hana
      - name: devtoberfest-planner-db
    provides:
      - name: gameboard-srv-api
        properties:
          srv-url: ${default-url}
    parameters:
      buildpack: nodejs_buildpack
  - name: gameboard-db-deployer
    type: hdb
    path: gen/db
    requires:
      - name: gameboard-db
      - name: tutorials-hana
      - name: devtoberfest-planner-db
    parameters:
      buildpack: nodejs_buildpack
    properties:
      TARGET_CONTAINER: gameboard-db
resources:
  - name: gameboard-db
    type: com.sap.xs.hdi-container
    parameters: { service: hana, service-plan: hdi-shared }
  - name: tutorials-xsuaa
    type: org.cloudfoundry.existing-service
  - name: tutorials-hana
    type: org.cloudfoundry.existing-service
  - name: devtoberfest-planner-db
    type: org.cloudfoundry.existing-service
```

`TARGET_CONTAINER: gameboard-db` is required because THREE HDI services are bound to the deployer (the container's own + two providers).

- [ ] **Step 2: Verify all three provider services are the SAME HANA instance**

Run (does NOT use `cds bind` — per constraint):

```bash
cf target   # confirm subaccount + org/space match tutorials-ims / devtoberfest-planner
cf service-key tutorials-hana gameboard-check || cf create-service-key tutorials-hana gameboard-check
cf service-key devtoberfest-planner-db gameboard-check || cf create-service-key devtoberfest-planner-db gameboard-check
```

Expected: both service keys report the SAME HANA Cloud instance host. If they differ, STOP — cross-container will not work; escalate.

- [ ] **Step 3: Build + deploy**

Run:

```bash
npm install && npx cds build --production
cf target   # RE-ASSERT right before deploy (cf target can drift)
mbt build && cf deploy mta_archives/sap-community-gameboard_0.1.0.mtar -f
```

(Use the explicit mtar filename, not a glob — glob panics on Windows.)

- [ ] **Step 4: Write + run the post-deploy smoke test**

`test/smoke/boot-smoke.test.js`:

```js
const { expect } = require('chai');
describe('deployed gameboard smoke', () => {
  const base = process.env.SMOKE_SRV_URL; // gameboard-srv-api url
  (base ? it : it.skip)('getLeaderboard responds 200', async () => {
    const res = await fetch(`${base}/gameboard/getLeaderboard(top=5)`);
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.value).to.be.an('array');
  });
});
```

Run: `SMOKE_SRV_URL=<deployed-url> npx vitest run test/smoke/boot-smoke.test.js`
Expected: PASS — the deployed service reads cross-container and returns 200.

- [ ] **Step 5: Commit**

```bash
git add mta.yaml xs-security.json test/smoke/boot-smoke.test.js
git commit -m "feat: MTA with shared XSUAA + dual cross-container bindings"
```

---

### Task 6: Approuter route in `tutorials-ims`

**Repo:** `tutorials-ims`. Makes the gameboard reachable through the single front door.

**Files:**
- Modify: `approuter/xs-app.json`
- Modify: `mta.yaml` AND `.deploy/mta.yaml` (add `gameboard-srv-api` as a destination/route target)
- Test: manual + Playwright (deferred to Plan C for the UI; here a route-level curl check)

**Interfaces:**
- Consumes: `gameboard-srv-api` provided by the new MTA.
- Produces: `/gameboard/*` reachable anonymously through the tutorial approuter.

- [ ] **Step 1: Add the route block to `approuter/xs-app.json`**

Insert BEFORE the catch-all `^(.*)$` route:

```json
{
  "source": "^/gameboard/(.*)$",
  "destination": "gameboard-srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

- [ ] **Step 2: Declare the destination**

The approuter reaches a separately-deployed backend via a CF destination or a `destinations` env entry pointing at the `gameboard-srv` route URL. Add a `gameboard-srv-api` destination to the approuter module's `requires`/`properties` in BOTH `mta.yaml` and `.deploy/mta.yaml` (mirror exactly), using the deployed `gameboard-srv` URL. Because the two MTAs are separate, this is a URL-based destination, not an MTA `provides`/`requires` wire.

- [ ] **Step 3: Deploy the approuter (full deploy per runbook)**

Run: `npm run deploy -- --env dev` (full — the approuter static bundle must rebuild; no `--skip-build`, no `-m` scoping).

- [ ] **Step 4: Verify end-to-end through the approuter**

Run:

```bash
curl -s "https://<tutorial-approuter-host>/gameboard/getLeaderboard(top=5)" | jq '.value | length'
```

Expected: a number (0+), HTTP 200 — proving the approuter → new backend → cross-container read path works as one origin.

- [ ] **Step 5: Commit (PR on `tutorials-ims`)**

```bash
git add approuter/xs-app.json mta.yaml .deploy/mta.yaml
git commit -m "feat(approuter): route /gameboard/* to the gameboard backend"
```

---

## Self-Review

**Spec coverage (Foundation portions of the design):**
- Separate MTA + CAP instance → Tasks 2, 5. ✅
- Shared XSUAA (resource server) → Task 5 (`tutorials-xsuaa` existing-service). ✅
- Cross-container read of `DTF_ACTIVITY_V1` → Tasks 3, 5 (planner grants + synonym + facade). ✅
- New `GAMEBOARD_*_V1` views + `gameboard_reader` role published by tutorials-srv → Task 1. ✅
- Single approuter front door → Task 6. ✅
- Privacy (first name + last initial; community id/link only when linked) → Task 1 view + Task 4 display logic (uses `Users.khorosId`/`khorosLogin`, issue #566). ✅
- Slug resolution on the tutorial side → Task 1 `GAMEBOARD_COMPLETION_V1` (`taskLegacyId`→`legacyId`→`slug`, lowercased). ✅
- Deploy target = same subaccount/org/space; same-HANA-instance verification → Task 5 Step 2. ✅
- Base-then-enable ordering → Task 1 (base) precedes Task 3/5 (enable); called out in Global Constraints. ✅
- Fail-soft reads → Task 4 try/catch. ✅
- Full scoring, personalized view, realtime, UI, community utilities → deliberately OUT of Plan A (Plans B–E). Leaderboard `score`/`level` stubbed to 0 here.

**Placeholder scan:** No TBDs; every code step has concrete content. The one "widen the WHERE clause if non-TUTORIAL activities exist" is a conditional follow-up tied to a spec §10 validation item, not a placeholder in the deliverable.

**Type consistency:** `LeaderboardRow` keys (`rank`, `displayName`, `score`, `level`, `communityUrl`) are identical in the CDS type (Task 2), the implementation (Task 4), and the test assertions. Facade element names (`communityLogin`, `communityId`, `firstName`, `lastInitial`, `joinedAt`, `eventId`) are consistent between `db/external/gameboard.cds` (Task 3) and their use in `srv/gameboard-service.js` (Task 4). View column names match between Task 1 SQL aliases and the facade mappings.
