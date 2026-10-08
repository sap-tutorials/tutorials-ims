# Devtoberfest cat-game (Kasimir) & leaderboard — PROD data troubleshooting runbook

**Audience:** operators/engineers debugging the "Tag the Cat"/Kasimir counter, the Devtoberfest leaderboard, duplicate-user/identity-fork issues, or stranded points (e.g. issue #2651).

**Golden rule:** the live cat-game data is **NOT** in the container that a plain `cds bind` resolves to. Read **"Where the data actually lives"** first or you will waste hours querying an empty/stale container (this happened on 2026-10-05).

---

## Where the data actually lives

The `tutorials-hana` HANA **instance** hosts **multiple HDI container schemas**:

| Schema | What it is | Cat-game data? |
|--------|-----------|----------------|
| **`2FEC6DAB47984DB482E0B3BB80AFFEF7`** | The container bound by **`tutorials-srv`** and **`gameboard-srv`** at runtime | ✅ **YES — this is the real one** (~817k Users, ~3.2k CatGameAwards) |
| `AC9753D6…` | What `cds bind --to tutorials-hana:tutorials-hana-key` lands in | ❌ decoy — ~2 award rows only |

The prod HANA host is `8996974c-….hana.prod-eu10.hanacloud.ondemand.com` (the `prod-eu10` in the hostname is your confirmation you're on PROD, not DEV).

**`gameboard-db`** (own instance) is effectively empty (CDS_OUTBOX only). **`devtoberfest-planner-db`** is the conference **session planner**, not cat-game. Both are red herrings.

### Why `cds bind` lands in the wrong place
`cds bind --to tutorials-hana:tutorials-hana-key` uses the **service key** `tutorials-hana-key`, which maps to container `AC9753D6…`. The running apps bind the **same instance via a different HDI container** (`2FEC6DAB…`) delivered through their service binding, not that key. Trust the app's live binding, not the service key.

---

## How to connect read-only to the correct container

Use the live binding of a running app that already points at `2FEC6DAB…` (`tutorials-srv` or `gameboard-srv`):

```bash
cf target                               # MUST show org tutorial-system / space prod
cf env tutorials-srv > /tmp/srv-env.txt # or: cf env gameboard-srv
```

Parse `VCAP_SERVICES` → `hana[]` → the instance named `tutorials-hana` → `.credentials`
(`host`, `port`, `user`, `password`, `certificate`, `schema` = `2FEC6DAB…`).

Connect with the `hdb` node client (installed in this repo):

```js
const hdb = require('hdb');
const client = hdb.createClient({
  host: cc.host, port: cc.port, user: cc.user, password: cc.password,
  ca: cc.certificate, encrypt: true, sslValidateCertificate: !!cc.certificate,
});
```

### ⚠️ `hdb` client gotchas (both cost time on 2026-10-05)
1. **Positional `?` bound params FAIL** in this environment (`not all variables bound`). **Inline escaped literals instead** — `` `WHERE email = '${s.replace(/'/g,"''")}'` ``. (`@sap/hana-client` would support params, but `hdb` is what's installed.)
2. The service-key login lands in a **`…_RT` runtime schema**; the tables are in the **container schema `2FEC6DAB…`**. Always **fully-qualify**: `"2FEC6DAB47984DB482E0B3BB80AFFEF7"."TABLE_NAME"`. Querying `CURRENT_SCHEMA` finds nothing.

---

## Key objects (schema `2FEC6DAB…`)

Tables (`COM_SAP_DEVELOPERS_IMS_*`):

| Table | Holds | Rows (2026-10-05) |
|-------|-------|-------------------|
| `_USERS` | user accounts | ~817,424 (only ~20,671 have an email) |
| `_CATGAMEAWARDS` | per-day Kasimir catches (`user_ID`, `event_ID`, `awardDate`, `points`; 5/day, 100/event caps) | ~3,244 |
| `_EVENTREGISTRATIONS` | event opt-in (`user_ID`, `event_ID`, `joinedAt`) | ~2,692 |
| `_USERIDENTITIES` | login links (`issuer`, `subject`) | ~1,826 |
| `_EVENTS` | events; `eventType='DEVTOBERFEST'`, `startDate`/`endDate` | — |

Leaderboard views (defined in `db/src/*.hdbview`):

- **`GAMEBOARD_PARTICIPANT_V1`** — `FROM EVENTREGISTRATIONS r JOIN USERS JOIN EVENTS WHERE eventType='DEVTOBERFEST'`. **Driven by registrations.** A user with awards but **no registration row is invisible here** — this is the core stranding mechanism.
- `GAMEBOARD_BONUS_V1` — cat-game bonus points surfaced to the leaderboard.
- `GAMEBOARD_COMPLETION_V1` — completions scored by event **date window** `[startDate,endDate]` (retroactive, multi-event), NOT by `TaskRecords.event_ID`.
- `GAMEBOARD_ACTIVE_EVENT_V1` — current event.

---

## The #2651 class of bug (identity fork → stranded points)

**Symptom:** in-game Kasimir counter resets/climbs from a low base while the Devtoberfest leaderboard total is frozen; or vice-versa.

**Mechanism:** the same human has **≥2 `Users` rows** (same email, different `sapId`). New catches land on the **newer fork row**; the counter sums that row and looks "reset". The fork row has **no `EventRegistrations`**, so `GAMEBOARD_PARTICIPANT_V1`'s registration-driven join hides its points from the leaderboard, which still shows the **older** row's registered total.

**Prevention fix (shipped, PR #2661 / v1.36.0):** `tokenEmail()` now reads IAS tokens' `user.attr.email` (not just `payload.email`), so returning SAP-ID/IAS logins resolve to the existing row instead of minting a fork. Plus `pickCanonicalRow` + `provisionDbUser` hardening.

**Reconciliation of existing forks:** `reconcileDuplicateEmails` (`srv/jobs/identity-dedup-job.js`) → `mergeAccounts` (`srv/lib/account-merge.js`). Deliberately **NOT** in `JOB_REGISTRY` (operator-invoked only). See [identity-dedup-reconciliation.md](identity-dedup-reconciliation.md). **It must run against `2FEC6DAB…`** — running it via `cds bind … tutorials-hana-key` hits the decoy container and reports a false near-empty no-op.

The merge is a **soft-merge**: it repoints TaskRecords/PrizeRecords/AccomplishmentRecords/UserIdentities/EventRegistrations/CatGameAwards from secondary→primary, caps CatGameAwards (5/day, 100/event), and writes a `SecondaryAccounts` audit row (status `MERGED`, `mergedAt`, `primaryAccount_ID`). It does **NOT** delete the secondary `Users` row, so the email cluster still exists afterward. The job has **no idempotency guard** — do not run it twice; a second pass re-merges now-empty secondaries (harmless to points, but writes duplicate audit rows).

---

## Ready-to-use read-only queries

Replace `S` with `2FEC6DAB47984DB482E0B3BB80AFFEF7` and inline literals (no bound params).

```sql
-- A user's forked rows + their award/registration split (the #2651 picture)
SELECT ID, email, sapId, createdAt FROM "S"."COM_SAP_DEVELOPERS_IMS_USERS"
  WHERE LOWER(email) = LOWER('<email>');
-- per row:
SELECT COUNT(*) n, COALESCE(SUM(points),0) pts
  FROM "S"."COM_SAP_DEVELOPERS_IMS_CATGAMEAWARDS" WHERE user_ID = '<row-ID>';
SELECT COUNT(*) n
  FROM "S"."COM_SAP_DEVELOPERS_IMS_EVENTREGISTRATIONS" WHERE user_ID = '<row-ID>';

-- Whole-container dup-email clusters
SELECT COUNT(*) FROM (SELECT LOWER(email) e
  FROM "S"."COM_SAP_DEVELOPERS_IMS_USERS" WHERE email IS NOT NULL
  GROUP BY LOWER(email) HAVING COUNT(*) > 1);

-- Stranded cat-game points: awards on rows with no participant/registration
SELECT COUNT(DISTINCT a.user_ID) users, COUNT(*) rows_, COALESCE(SUM(a.points),0) pts
  FROM "S"."COM_SAP_DEVELOPERS_IMS_CATGAMEAWARDS" a
  WHERE NOT EXISTS (SELECT 1 FROM "S"."COM_SAP_DEVELOPERS_IMS_EVENTREGISTRATIONS" r
                    WHERE r.user_ID = a.user_ID);

-- A user's leaderboard visibility (participant row only exists if registered)
SELECT COUNT(*) FROM "S"."GAMEBOARD_PARTICIPANT_V1" WHERE "USER_ID" = '<row-ID>';
```

**Measured 2026-10-05 (PROD, container `2FEC6DAB…`):** 374 dup-email clusters; 142 users / 172 award rows / **860 points** stranded. Reporter `daniela.fojtzik@all-for-one.com`: canonical `25bae84a-…` (55 pts, 1 reg) + fork `b5649b00-…` (25 pts, 0 reg) → after merge, canonical carried 75 pts (5 trimmed to the per-day/event cap) and remained leaderboard-visible.

---

## Running the reconcile job against the correct container (operator)

Because `cds bind` resolves to the decoy container, feed CAP the **live `tutorials-srv` binding** so the real job code resolves `cds.entities` against `2FEC6DAB…`:

1. `cf env tutorials-srv` → extract `VCAP_SERVICES.hana` → write a `default-env.json` of `{ "VCAP_SERVICES": { "hana": [...] } }` to a **scratch dir outside the repo** (never commit creds).
2. In a node runner: set `process.env.VCAP_SERVICES` from that file + `CDS_REQUIRES_DB_KIND=hana`, `chdir` to the repo, `cds.connect.to('db')`.
3. **Assert `CURRENT_SCHEMA` starts with `2FEC6DAB` and abort otherwise** — the mandatory guard against the wrong-container trap.
4. `import('./srv/jobs/identity-dedup-job.js')` → `reconcileDuplicateEmails({ dryRun: true })`, review, then `{dryRun:false, limit:1}` canary, then full. See [identity-dedup-reconciliation.md](identity-dedup-reconciliation.md) for the gate/verify steps.

> **Note on `cf env` output:** it prints human-readable text before the JSON — don't pipe straight to `jq`. Extract the `VCAP_SERVICES` object by brace-matching first (a small Python/node snippet), then parse.
