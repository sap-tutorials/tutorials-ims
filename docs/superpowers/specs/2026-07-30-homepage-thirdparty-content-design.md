# Homepage third-party content seed — design

- **Date:** 2026-07-30
- **Status:** Approved (design)
- **Author:** homepage content
- **Related:** `2026-06-27-639-developer-homepage-design.md` (§10.1 entry schema, §5.1 persona scoring)

## 1. Problem

The homepage verb-section "content links" (entity `HomepageShelves`, seeded from
`db/data/com.sap.developers.ims-HomepageShelves.csv`, 74 rows) are almost entirely
SAP-owned destinations. We want to broaden the ecosystem coverage with curated
**third-party** sources across data/lakehouse, AI, workflow-automation, and community
topics — and review them **on DEV first**, without them appearing on PROD until we
deliberately promote them.

## 2. Key constraint (why this needs a deliberate mechanism)

CAP auto-loads exactly **one CSV per entity** by naming convention, and **DEV and PROD
read the same file** (verified: they are separate HANA HDI containers in one shared BTP
subaccount, distinguished only at deploy time by CF space name — see
`srv/lib/deploy-environment.js`). Appending to the canonical CSV would therefore ship the
new rows to PROD on its next deploy. We need the new content to (a) live as a durable,
reviewable, git-tracked artifact and (b) land in DEV without touching PROD.

## 3. Approach (chosen: "staging file + one-shot loader")

- Author the entries in a **separate, git-tracked file that CAP does NOT auto-load**:
  `db/data/staging/homepage-thirdparty.json`.
- An **idempotent loader** (`scripts/seed-thirdparty.js`, npm `seed:thirdparty`) upserts
  those rows into whatever DB the active `cds` profile points at. Run it against **DEV**;
  PROD stays clean.
- **Promotion to PROD** happens later, deliberately, once reviewed (see §8).

Rejected alternatives: environment-gated before-READ auto-init (adds a permanent
production runtime code path for a one-time job); admin-UI hand entry (content not
captured in git — fails the "save it so we can promote easily" requirement).

JSON (not CSV) is used for the staging file so that array fields (`personaTags`) and long
`whyItMatters` text stay clean and diff-friendly. The loader upserts via CQL, so there is
no CSV-array-encoding problem.

## 4. Entry conventions

Every entry sets:

| field | value |
|---|---|
| `badge` | `THIRD_PARTY` (existing enum value; already rendered — used today on ASUG/SAPinsider) |
| `isExternal` | `true` |
| `isActive` | `true` |
| `authoringStatus` | `REVIEWED` (human-authored; AI bulk-fill skips REVIEWED rows) |
| `personaWeight` | `0` (additive discovery links, not boosted above SAP-first content) |
| `ID` | block prefix `66333900-3rd0-<verb>-...`, unique, never colliding with existing rows |

Also populated per entry: `verb`, `shelf`, `sortOrder`, `title` (≤120), `url` (absolute
https), `description` (≤280), `tagline` (≤140), `whyItMatters` (≤800), `personaTags`.

`START_HERE` is intentionally left SAP-first — third-party rows land only in
`REFERENCE`, `TOOLS`, or `KEEP_CURRENT`. `sortOrder` values start at 200 within each
verb/shelf so they sort after existing SAP rows.

### Persona-tag vocabulary (hard constraint)

`personaTags` are validated at save time against `KNOWN_TAGS`
(`srv/lib/homepage/persona-tag-validator.js`, derived from `PROFILE_VOCAB` in
`srv/lib/branch/profile-fields.js`). Only these grammar values are legal — typos are
rejected:

- `role:` → `developer`, `architect`, `sysadmin`, `student`
- `deployment:` → `cloud`, `onprem`
- `cloud:` → `btp`, `aws`, `azure`, `gcp`, `alibaba`, `oracle`, `ibm`

Tagging rules applied:
- MODEL (data/lakehouse): `role:developer`, `role:architect`, `deployment:cloud`
- BUILD (Vercel): `role:developer`, `deployment:cloud`
- AI: `role:developer`, `role:student`, `deployment:cloud`
- INTEGRATE (n8n): `role:developer`, `deployment:cloud`
- CONNECT (reddit): topic-based `role:` tag only; no `cloud:` tag (vendor-neutral)

## 5. Content set (20 entries)

All `badge=THIRD_PARTY`. URLs verified live 2026-07-30 where noted.

### BUILD — frontend build & deploy
| title | url | shelf | personaTags |
|---|---|---|---|
| Vercel | https://vercel.com | TOOLS | role:developer, deployment:cloud |

### MODEL — data & lakehouse
| title | url | shelf | personaTags |
|---|---|---|---|
| Dremio | https://www.dremio.com | REFERENCE | role:developer, role:architect, deployment:cloud |
| Dremio Community | https://community.dremio.com | KEEP_CURRENT | role:developer, role:architect |
| Apache Iceberg | https://iceberg.apache.org | REFERENCE | role:developer, role:architect, deployment:cloud |
| Data Engineering Weekly | https://www.dataengineeringweekly.com | KEEP_CURRENT | role:architect |
| The Data Stack Show | https://datastackshow.com | KEEP_CURRENT | role:developer, role:architect |
| Reltio Community | https://community.reltio.com | KEEP_CURRENT | role:developer, role:architect |

### AI
| title | url | shelf | personaTags |
|---|---|---|---|
| Hugging Face | https://huggingface.co | REFERENCE | role:developer, role:student, deployment:cloud |
| TabPFN (Prior Labs) | https://github.com/PriorLabs/TabPFN | TOOLS | role:developer, role:student |
| Prior Labs Research | https://priorlabs.ai/research | REFERENCE | role:developer, role:student |
| Kaggle | https://www.kaggle.com | TOOLS | role:developer, role:student |

### INTEGRATE — n8n
| title | url | shelf | personaTags |
|---|---|---|---|
| n8n Community Forum | https://community.n8n.io | KEEP_CURRENT | role:developer, deployment:cloud |
| n8n Discord | https://discord.gg/n8n | KEEP_CURRENT | role:developer |
| n8n on YouTube | https://www.youtube.com/c/n8n-io | KEEP_CURRENT | role:developer |
| n8n (n8n-io/n8n) | https://github.com/n8n-io/n8n | TOOLS | role:developer, deployment:cloud |
| n8n docs (n8n-io/n8n-docs) | https://github.com/n8n-io/n8n-docs | TOOLS | role:developer |

### CONNECT — reddit
| title | url | shelf | personaTags |
|---|---|---|---|
| r/SAP | https://www.reddit.com/r/SAP | KEEP_CURRENT | role:developer |
| r/dataengineering | https://www.reddit.com/r/dataengineering | KEEP_CURRENT | role:architect |
| r/MachineLearning | https://www.reddit.com/r/MachineLearning | KEEP_CURRENT | role:developer |
| r/n8n | https://www.reddit.com/r/n8n | KEEP_CURRENT | role:developer |

`tagline` and `whyItMatters` are authored per-entry during implementation (short, factual,
no marketing tone), matching the voice of existing rows.

## 6. Files

| file | purpose |
|---|---|
| `db/data/staging/homepage-thirdparty.json` | durable, promotable source of truth: array of 20 entry objects |
| `scripts/seed-thirdparty.js` | idempotent CQL upsert into active-profile DB; run against DEV |
| `package.json` → `scripts.seed:thirdparty` | `node scripts/seed-thirdparty.js` |
| `scripts/__tests__/seed-thirdparty.test.js` | validation tests (see §7) |

The `db/data/staging/` directory is chosen because it is NOT matched by CAP's
`<namespace>-<Entity>.csv` auto-load convention, so nothing in it deploys implicitly.

## 7. Loader behaviour & tests

**Loader (`seed-thirdparty.js`):**
1. Read + parse the JSON array.
2. Validate every row: required fields present; `url` absolute https; every `personaTag`
   ∈ `KNOWN_TAGS` (import the real validator — no duplicated vocab). Fail loudly with the
   offending row/tag on any violation; write nothing.
3. Connect via `cds.connect` using the active profile. For each row, upsert idempotently on
   the `(verb, url)` natural key (matches the `@assert.unique.verbUrl` constraint):
   existing → `UPDATE`, else `INSERT`. Re-runnable with no duplicates.
4. Print a summary (inserted / updated counts).

**Tests (`seed-thirdparty.test.js`), no DB required:**
- JSON parses and is a non-empty array.
- Every row has all required fields with correct types and length limits.
- Every `url` is absolute https.
- Every `personaTag` is in `KNOWN_TAGS`.
- `(verb, url)` pairs are unique within the file AND do not collide with any pair already
  in `com.sap.developers.ims-HomepageShelves.csv`.
- Every `ID` is unique and does not collide with an existing CSV ID.

## 8. Promotion to PROD (documented, manual, later)

After review on DEV, promote by **either**:
- **(preferred, matches convention)** append the rows to
  `db/data/com.sap.developers.ims-HomepageShelves.csv` and redeploy PROD; or
- run `seed:thirdparty` against the PROD profile.

The JSON file remains the source of truth either way. A short "How to promote" note lives
at the top of the JSON file and in this spec.

## 9. Out of scope

- No schema change to `db/homepage.cds` (no new enum value or column).
- No new verbs/shelves; no changes to `VerbDefinitions` / `ShelfDefinitions`.
- No render changes to `verb-spine.html` — `THIRD_PARTY` already renders.
- No automated DEV→PROD sync; promotion stays a deliberate manual step.

## 10. Open items resolved during design

- "Demio" → **Dremio**; "TabPFM" → **TabPFN**; "Kagggle" → **Kaggle** (confirmed).
- "reddit … extended topics" → r/SAP, r/dataengineering, r/MachineLearning, r/n8n
  (accepted default).
- "n8n-io and n8n repos" → `n8n-io/n8n` + `n8n-io/n8n-docs` (accepted default).
